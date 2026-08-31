import { msg } from "@lingui/core/macro";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { dropSlices } from "../../platform/persistence/database.ts";
import { addNote, baseBranchOf } from "../../mech/util/rows.ts";
import { interrupt, park, pause, resume, unpark } from "../../mech/flow/intercept.ts";
import { dropGroup, startGroup, sweepApproved } from "../../mech/flow/start.ts";
import { escalationKey } from "../../mech/flow/escalate.ts";
import { openPr, prBody, prTitle } from "../../mech/git/prwatch.ts";
import { joinQueue, landed } from "../../mech/flow/mergequeue.ts";
import { validateDraftCard } from "../../mech/util/validate.ts";
import { canStart, CLAIMING, parseOwns } from "../../mech/flow/ownership.ts";
import { killSandbox } from "../../mech/sandbox/sandbox.ts";
import { clearSandboxLog } from "../../mech/sandbox/sandboxlog.ts";
import { z } from "zod";
import { Attachment as AttachmentSchema, IdParams } from "../../contracts/fields.ts";
import { newGroup } from "../../mech/flow/newgroup.ts";
import type { Handler } from "../../http/handler.ts";
import { bad, badText, json, message } from "../../http/respond.ts";
import { noGithubClient } from "./authflow.ts";
import { withAttachments } from "../../mech/util/attachment-text.ts";
import { slug } from "../slug.ts";
import { titleFor } from "./title.ts";
import { renderSaid } from "../../platform/text/lang.ts";
import type { Said } from "../../contracts/said.ts";
import { roleFor, type Ctx } from "../../mech/ctx.ts";
import { sediment } from "../../mech/knowledge/lessons.ts";
import { escalation, event, grp as grps, note, project, slice, task } from "../../platform/persistence/schema.ts";
import { outputLanguage } from "../../contracts/config.ts";

/** What the boss first asked for, for this group. */
async function firstIdea(db: DB, groupId: number): Promise<string> {
  const [first] = await db
    .select({ body: event.body })
    .from(event)
    .where(and(eq(event.grp_id, groupId), eq(event.kind, "boss_say")))
    .orderBy(asc(event.seq))
    .limit(1);
  return first?.body ?? "";
}

/**
 * A requirement, from the sentence the boss typed to the branch coming back.
 *
 * The boss's four buttons live here — approve the card, pause, park, drop — and
 * so does what each of them costs. `postGroupControl` is one route because the
 * panel has one row of buttons, not because the eight actions behind it are one
 * thing.
 */

export const IdeaBody = z.object({
  project_id: z.number().int().positive(),
  text: z.string().trim().min(1, "empty idea").max(20_000),
  name: z.string().max(80).optional(),
  attachments: z.array(AttachmentSchema).max(20).optional(),
});

export const postIdea = (async (ctx, _req, _p, b) => {
  // A caller that named it keeps its name and gets no title: only the panel form
  // leaves `name` off, and only its prose is worth reading a title out of.
  const { name, title } = b.name
    ? { name: slug(b.name).slice(0, 40), title: null }
    : await titleFor(ctx, b.project_id, b.text);
  // Attachments go on the blackboard as paths next to the words they came with, so
  // whoever plans this reads them in the same breath as the idea.
  const grp = await newGroup(ctx, {
    projectId: b.project_id,
    name,
    title,
    idea: b.text,
    note: withAttachments(b.text, b.attachments),
  });
  // With another group already holding paths, the boundary has to be cut before
  // anyone plans work inside it — otherwise the plan is written against paths the
  // group turns out not to own.
  const others = await ctx.db
    .select({ id: grps.id, name: grps.name, owns_json: grps.owns_json })
    .from(grps)
    // `CLAIMING` bound as parameters, which is what the suppression this replaces
    // spent four lines explaining `CLAIMING_SQL` already was.
    .where(and(eq(grps.project_id, b.project_id), ne(grps.id, grp.id), inArray(grps.status, CLAIMING)));
  if (others.length > 0) {
    // Every undeclared active group, not just the new one. The first group in a
    // project needs no boundary — but the moment a second appears, an undeclared
    // group beside a declared one is the exact situation the rule exists to
    // prevent, reached from the other direction.
    const undeclared = others.filter((o) => parseOwns(o.owns_json).length === 0);
    const needBoundary = [
      { id: grp.id, name, idea: b.text },
      ...(await Promise.all(
        undeclared.map(async (o) => ({ id: o.id, name: o.name, idea: await firstIdea(ctx.db, o.id) })),
      )),
    ];
    // `boundary` and nothing else. `applyPayloadCards` keeps the *last* builder
    // that fired and `idea` is after `boundary` in that list, so sending both
    // replaced the whole boundary card — the `orch owns <id> --path …` commands
    // this turn exists to issue — with "The boss wants: …". The requirement is
    // already the first row of `needBoundary`, so nothing is lost by dropping it.
    await ctx.sched.enqueue("agent_turn", {
      grp_id: grp.id,
      priority: 6,
      payload: { role: roleFor(ctx, "cut_boundary"), boundary: needBoundary },
    });
  }

  // After the Architect's, when there is one: the boundary has to be cut before
  // anyone plans work inside it.
  await ctx.sched.enqueue("agent_turn", {
    grp_id: grp.id,
    payload: { role: roleFor(ctx, "plan_requirement"), idea: b.text },
  });
  await ctx.sched.tick();
  return json({ grp_id: grp.id, channel_id: grp.channelId, boundaryNeeded: others.length > 0 });
}) satisfies Handler<z.infer<typeof IdeaBody>>;

export const DraftDecision = IdParams.extend({
  decision: z.enum(["approve", "reject"]),
});

/** The edited card on an approve, the reason on a reject. Neither is required. */
export const DraftDecisionBody = z.object({
  card: z.string().max(20_000).optional(),
  reason: z.string().max(8000).optional(),
  attachments: z.array(AttachmentSchema).max(20).optional(),
});

/**
 * The boss sent the card back.
 *
 * PLANNING, not DRAFT: left in DRAFT it still counted as a decision waiting on
 * the boss, still showed the rejected card, and `Approve and start` still worked on it — one
 * stray click approves the very plan that was just sent back. `approved_at` goes
 * with it, or the next card to reach DRAFT starts itself on the strength of a yes
 * the boss said to a plan that no longer exists.
 */
async function sendBack(ctx: Ctx, grpId: number, b: z.infer<typeof DraftDecisionBody>): Promise<void> {
  const fact = withAttachments(`boss sent the DRAFT back: ${b.reason ?? ""}`, b.attachments);
  const [owner] = await ctx.db.select({ project_id: grps.project_id }).from(grps).where(eq(grps.id, grpId));
  const projectId = owner?.project_id ?? null;
  // Back to PLANNING, which is what the group actually is now. Left in DRAFT it
  // still counted as a decision waiting on the boss, still showed the rejected
  // card, and `Approve and start` still worked on it — one stray click approves the very
  // plan that was just sent back.
  //
  // Clearing approved_at as well: sending a plan back withdraws the approval, or
  // the next card to reach DRAFT would start itself on the strength of a yes the
  // boss said to a plan that no longer exists.
  const why = withAttachments(b.reason ?? "respec", b.attachments);
  await ctx.bus.transaction(async (tx) => {
    await addNote(tx, { projectId, grpId, kind: "fact", lang: outputLanguage(ctx.config), body: fact });
    await tx
      .update(grps)
      .set({ status: "PLANNING", approved_at: null })
      .where(and(eq(grps.id, grpId), eq(grps.status, "DRAFT")));
    await ctx.bus.emit({ grpId, author: "boss", kind: "boss_say", intent: "request", body: why });
    await ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      payload: { role: roleFor(ctx, "plan_requirement"), respec: why },
    });
  });
  await sediment(ctx, projectId, ctx.config.feedbackSedimentThreshold);
  await ctx.sched.tick();
}

/**
 * The boss said yes, but a boundary is in the way.
 *
 * A refusal used to end here and the click was gone: the group sat in DRAFT with
 * nothing recording the yes, and nobody re-ran it when the group holding the
 * paths merged. One click has to be final, so the approval is written and the
 * Architect is put back on the boundary it forgot to cut.
 */
async function heldForBoundary(ctx: Ctx, grpId: number, why: Said): Promise<void> {
  // A refusal used to end here, and the click was gone: the group sat in DRAFT
  // with nothing recording that the boss had said yes, and nobody re-ran it when
  // the group holding the paths merged. One click has to be final.
  await ctx.db.update(grps).set({ approved_at: Date.now() }).where(eq(grps.id, grpId));
  // Put the Architect back on it — the boundary is its job, and it was observed
  // cutting one group's paths and forgetting the other's.
  // The project is read rather than sub-queried: this handler already names the
  // group, and the builder has no operand form for a scalar subquery.
  const [mine] = await ctx.db.select({ project_id: grps.project_id }).from(grps).where(eq(grps.id, grpId));
  const undeclared = mine
    ? await ctx.db
        .select({ id: grps.id, name: grps.name })
        .from(grps)
        .where(
          and(
            eq(grps.project_id, mine.project_id),
            inArray(grps.status, CLAIMING),
            // `owns_json` is NOT NULL, so the `IS NULL` half has never matched.
            // Kept because removing a branch is not what this change is for.
            or(isNull(grps.owns_json), eq(grps.owns_json, [])),
          ),
        )
    : [];
  if (undeclared.length) {
    await ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      priority: 7,
      payload: {
        role: roleFor(ctx, "cut_boundary"),
        boundary: await Promise.all(undeclared.map(async (g) => ({ ...g, idea: await firstIdea(ctx.db, g.id) }))),
      },
    });
    await ctx.sched.tick();
  }
  await ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    // `why` verbatim — a descriptor cannot nest in another. "approval recorded,
    // starts by itself" is not lost: `approved_at` is set two lines up and the
    // card reads "Approved · Awaiting boundary" from `heldApproved` in
    // `shared/select.ts`. What the event has to add is *which* boundary.
    say: why,
  });
}

export const postDraftDecision = (async (ctx, _req, params, b) => {
  const grpId = params.id;
  const approve = params.decision === "approve";

  if (!approve) {
    await sendBack(ctx, grpId, b);
    return message("sent back");
  }

  // The boss usually approves what the Dispatcher filed; an edited card in the
  // request body is the edit-then-approve path.
  const [filed] = await ctx.db
    .select({ body: note.body })
    .from(note)
    // Raw on the right: jsonb containment has no Drizzle operator.
    .where(and(eq(note.grp_id, grpId), sql`${note.frontmatter_json} @> '{"draft_card": true}'::jsonb`))
    // Both keys: `at` is a millisecond clock, and a card shares one with whatever
    // the same request wrote beside it.
    .orderBy(desc(note.at), desc(note.id))
    .limit(1);
  const card = b.card ?? filed?.body;

  if (card) {
    const v = validateDraftCard(card);
    if (!v.ok) return badText(v.error);
    // Four tables point at a slice, not one. Clearing only `task` left `job`,
    // `note` and `slice.depends_on` holding references, so re-approving a group
    // that had already run died on `FOREIGN KEY constraint failed` — see
    // `SLICE_REFS`.
    await dropSlices(ctx.db, grpId);
    // A cap, per difficulty, written at birth. Until this, `budget_tokens` was
    // never INSERTed anywhere, so it was NULL on every row and both admission
    // checks in scheduler.ts had never stopped a single turn. It matters more now
    // that reviewers run on a CLI with no tool whitelist: the whitelist used to be
    // what bounded how much of the repo a review could read, and this is what
    // replaces it. The boss can raise any of them from the requirement page.
    // One task per slice, up front. Without something to claim the writer
    // improvises an id, `task done` never lands, and the whole review pipeline
    // silently never fires — which is exactly what the live run showed.
    //
    // Serially, and in order: `seq` is the slice's position and the task rows
    // point at the ids these hand back.
    const at = Date.now();
    for (const [i, sl] of v.slices.entries()) {
      const [row] = await ctx.db
        .insert(slice)
        .values({
          grp_id: grpId,
          seq: i + 1,
          title: sl.title,
          accept_spec: sl.accept,
          difficulty: sl.difficulty,
          budget_tokens: ctx.config.sliceBudgetTokens?.[sl.difficulty] ?? ctx.config.sliceBudgetTokens?.normal ?? null,
          created_at: at,
        })
        .returning({ id: slice.id });
      await ctx.db.insert(task).values({ grp_id: grpId, slice_id: row!.id, title: sl.title, created_at: at });
    }
  }
  // Boundaries before work. Two groups discovering at merge time that they were
  // both editing one file have already paid for the work twice.
  //
  // The slices above are written either way: without them there is nothing for the
  // automatic start to run once the boundary clears, and an edited card would be
  // lost between the two clicks.
  const start = await canStart(ctx.db, grpId);
  if (!start.ok) {
    const why = start.reason ?? msg`the boundary still overlaps`;
    await heldForBoundary(ctx, grpId, why);
    // 200, not 422: the boss did decide, and a red error toast says the opposite.
    // Both halves rendered into one language and joined as strings — not one key
    // with the other rendered into its values. Joining two rendered sentences is
    // safe because nothing renders the result again; a descriptor carrying one is
    // not, because the panel renders the outer in the language *it* reads.
    const lang = outputLanguage(ctx.config);
    return message(
      `${renderSaid(lang, msg`Approval recorded — it starts by itself once the boundary clears.`)} ${renderSaid(lang, why)}`,
    );
  }

  const err = await startGroup(ctx, grpId);
  return err ? badText(err) : message("ok");
}) satisfies Handler<z.infer<typeof DraftDecisionBody>, z.infer<typeof DraftDecision>>;

/**
 * Wind a merged group up. One path, whether the boss said so or `gh` did.
 *
 * Dissolving is the most irreversible thing on the panel — the group leaves every
 * view — so it must never rest on a guess about whether the branch is in main.
 */
export async function landGroup(ctx: Ctx, grpId: number, by: string): Promise<number[]> {
  const stale = await landed(ctx.db, grpId);
  await ctx.bus.emit({ grpId, author: by, kind: "state_change", say: msg`merged into main` });

  // Turn this group's retro into lessons while the branch is fresh. This is
  // the only mechanism by which the twentieth group is smarter than the
  // first, so it runs on the way out, not "later".
  await ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    payload: {
      role: roleFor(ctx, "compress_context"),
      rejection:
        "This group just merged. Read its retro and journals, then update the project's " +
        "lesson list (`orch journal add --kind lesson`) with anything that would have changed " +
        "a decision. Refresh the onboarding pack if this changed how the project is built or tested.",
    },
  });
  for (const id of stale) {
    // Named from the project rather than written into the sentence: a group on
    // `develop` was being told to rebase onto a branch its repository has not got.
    const base = await baseBranchOf(ctx.db, id, ctx.config.baseBranchFallbacks);
    await ctx.sched.enqueue("agent_turn", {
      grp_id: id,
      payload: {
        role: roleFor(ctx, "write_code"),
        rejection:
          `${base} moved: \`git fetch origin ${base}\` and \`git rebase origin/${base}\` ` +
          `before doing anything else.`,
        rotate: true,
      },
    });
  }
  await ctx.sched.tick();
  return stale;
}

/**
 * The nine things the boss's row of buttons can do.
 *
 * This list used to live in the route's regular expression, where an unknown action
 * was a 404 — routing and validation done by one mechanism, so a typo and a removed
 * feature both came back "not found".
 *
 * `landed` is the one that matters: one mis-click archived a group whose PR was
 * still open, and GitHub is the only source for that.
 */
export const GroupAction = IdParams.extend({
  action: z.enum(["pause", "resume", "park", "wake", "interrupt", "budget", "drop", "newpr", "rebuild"]),
});

/**
 * One body for nine actions, each field optional.
 *
 * A discriminated union would be the honest shape, and it cannot be written:
 * the discriminant is `action`, which is in the path rather than the body. So
 * the schema says what each field must be *if present* and the branch that
 * wants one checks that it is there — which is the same division as everywhere
 * else here, shape in the schema and meaning in the handler.
 */
export const GroupControlBody = z.object({
  tokens: z.number().nullable().optional(),
  why: z.string().max(4000).optional(),
  mode: z.enum(["keep", "rollback"]).optional(),
});

async function changeBudget(ctx: Ctx, grpId: number, tokens: number | null | undefined): Promise<Response> {
  // Budget exhaustion suspends the group, and until this existed there was no
  // route out of it: `Resume` un-paused a group the scheduler refused to admit,
  // so the next tick suspended it again. A limit needs a way to be raised.
  const t = normalizeBudget(tokens);
  const [spent] = await ctx.db
    .select({ spent_tokens: grps.spent_tokens, status: grps.status })
    .from(grps)
    .where(eq(grps.id, grpId));
  if (!spent) return message("no such group", 404);
  const error = budgetError(t, spent.spent_tokens);
  if (error) return error;
  await recordBudget(ctx, grpId, t);
  if (spent.status === "PAUSED") await resume(ctx, grpId);
  await ctx.sched.tick();
  return json({ budget: t });
}

function normalizeBudget(tokens: number | null | undefined): number | null {
  if (tokens == null) return null;
  return Math.round(tokens);
}

function budgetError(tokens: number | null, spent: number): Response | null {
  if (tokens === null) return null;
  if (!(tokens > 0)) return bad(msg`tokens must be a positive number, or null to lift the cap`);
  if (tokens <= spent)
    return bad(msg`already spent ${{ spent }} tokens — a cap at ${{ tokens }} would stop it again immediately`);
  return null;
}

async function recordBudget(ctx: Ctx, grpId: number, tokens: number | null): Promise<void> {
  const description = tokens === null ? "budget cap lifted" : `budget raised to ${tokens} tokens`;
  await ctx.db.update(grps).set({ budget_tokens: tokens }).where(eq(grps.id, grpId));
  await ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    body: description,
  });
  // Raising the cap is the answer to the question the watchdog asked, so it
  // also closes it: a stale "out of budget" row in `To do` is worse than none.
  await ctx.db
    .update(escalation)
    .set({
      chain_state: "answered",
      answered_by: "boss",
      answer: tokens === null ? "cap lifted" : `raised to ${tokens}`,
      answered_at: Date.now(),
    })
    // `isNull`: an unanswered row is what this closes, and `= NULL` matches none.
    // `dedupe_key`, not `question LIKE 'budget:%'` — the watchdog had to glue a
    // `budget: ` prefix onto the front of a translated sentence to keep that
    // pattern working, which is the seam this column removes.
    .where(
      and(
        eq(escalation.grp_id, grpId),
        eq(escalation.chain_state, "boss"),
        isNull(escalation.answer),
        eq(escalation.dedupe_key, escalationKey.budget),
      ),
    );
}

async function resumeGroup(ctx: Ctx, grpId: number): Promise<Response> {
  // Un-pausing an over-budget group is a no-op the boss cannot see: the
  // scheduler refuses to admit it, so it sits in RUNNING doing nothing.
  const [g] = await ctx.db
    .select({ budget_tokens: grps.budget_tokens, spent_tokens: grps.spent_tokens })
    .from(grps)
    .where(eq(grps.id, grpId));
  if (g?.budget_tokens != null && g.spent_tokens >= g.budget_tokens) {
    return bad(
      msg`out of budget (${{ spent: g.spent_tokens }}/${{ budget: g.budget_tokens }} tokens). Raise the cap first, or it stops again on the next tick.`,
    );
  }
  await resume(ctx, grpId);
  return message("ok");
}

async function replacePr(ctx: Ctx, grpId: number): Promise<Response> {
  // A closed PR normally comes back by being reopened on GitHub, and the
  // watchdog picks that up. But a PR cannot be reopened once its branch has
  // been force-pushed or deleted, and sometimes the boss simply wants a clean
  // one — without this the group is stuck holding a pr_number that openPr
  // treats as "already done", so it could never get another.
  const [g] = await ctx.db
    .select({ name: grps.name, repo: project.repo_path, pr_number: grps.pr_number })
    .from(grps)
    .innerJoin(project, eq(project.id, grps.project_id))
    .where(eq(grps.id, grpId));
  if (!g) return message("no such group", 404);
  if (!ctx.gh) return noGithubClient();
  await ctx.db.update(grps).set({ pr_number: null }).where(eq(grps.id, grpId));
  const r = await openPr({
    ctx,
    gh: ctx.gh,
    grpId,
    title: await prTitle(ctx.db, grpId),
    body: await prBody(ctx.db, grpId, outputLanguage(ctx.config)),
  });
  if ("error" in r) {
    // Put the old number back: a group with no PR and no way to open one is
    // worse off than one whose PR is closed.
    await ctx.db.update(grps).set({ pr_number: g.pr_number }).where(eq(grps.id, grpId));
    return badText(r.error);
  }
  await ctx.db.update(grps).set({ status: "PR_OPEN", paused_at: null, pause_reason: null }).where(eq(grps.id, grpId));
  await joinQueue(ctx.db, grpId);
  // The question `prClosed` filed about *this* PR, by the key it filed under.
  // The `LIKE` over a Chinese sentence fragment this replaces matched any closed-PR question in
  // the group, and a group with no PR number at all still ran it — closing a
  // question about some other PR is worse than leaving this one open.
  if (g.pr_number !== null) {
    await ctx.db
      .update(escalation)
      .set({ chain_state: "answered", answered_by: "boss", answer: `opened #${r.number} instead` })
      .where(
        and(
          eq(escalation.grp_id, grpId),
          isNull(escalation.answer),
          eq(escalation.dedupe_key, escalationKey.prClosed(g.pr_number)),
        ),
      );
  }
  await ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    say: msg`opened PR #${{ pr: r.number }} to replace the closed one`,
    meta: { pr: r.number },
  });
  return json({ number: r.number });
}

async function dropRequirement(ctx: Ctx, grpId: number, why: string | undefined): Promise<Response> {
  // `Don't proceed`. A requirement that turned out to be a duplicate, or that someone
  // else already fixed, had no way off the board: `Return for re-decomposition` sends it back to the
  // Dispatcher, which writes another card for work nobody wants. The paths it
  // held stayed held, so a group waiting on them waited forever.
  const [g] = await ctx.db.select({ status: grps.status, name: grps.name }).from(grps).where(eq(grps.id, grpId));
  if (!g) return message("no such group", 404);
  if (g.status === "DISSOLVED") return message("ok");
  await dropGroup(ctx, grpId, why ?? "");
  // Its paths are free the moment it leaves ACTIVE, so anything the boss
  // already approved behind it can start now.
  return json({ started: await sweepApproved(ctx) });
}

async function rebuildSandbox(ctx: Ctx, grpId: number): Promise<Response> {
  // Throw the container away; the next turn builds a fresh one and
  // `restoreWorkspace` puts the checkout and the dependencies back (the branch
  // itself lives in the boss's repo, so nothing on it is at risk). The way out
  // of a container that is wedged, is missing a mount the boss has just
  // allowed, or is holding a credential that has since been replaced.
  await killSandbox(ctx, { grp: grpId });
  // The old lines described a container that no longer exists.
  clearSandboxLog(grpId);
  await ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    say: msg`container discarded; the next turn rebuilds it — clone and install. The branch lives in the host repo`,
  });
  await ctx.sched.tick();
  return message("ok");
}

export const postGroupControl = (async (ctx, req, params, b) => {
  const grpId = params.id;
  const action = params.action;
  switch (action) {
    case "budget":
      return changeBudget(ctx, grpId, b.tokens);
    case "pause": {
      // Reports how many turns it is waiting on: PAUSING is honest, PAUSED
      // would not be while something is still in flight.
      const waiting = await pause(ctx, grpId);
      return json({ status: waiting ? "PAUSING" : "PAUSED", waiting });
    }
    case "resume":
      return resumeGroup(ctx, grpId);
    case "park":
      await park(ctx, grpId, "you parked it");
      return message("ok");
    case "newpr":
      return replacePr(ctx, grpId);
    case "drop":
      return dropRequirement(ctx, grpId, b.why);
    case "wake":
      await unpark(ctx, grpId);
      return message("ok");
    case "rebuild":
      return rebuildSandbox(ctx, grpId);
    case "interrupt": {
      const mode = b.mode ?? "keep";
      const out = await interrupt(ctx, grpId, mode);
      return json(out);
    }
  }
}) satisfies Handler<z.infer<typeof GroupControlBody>, z.infer<typeof GroupAction>>;
