import { dropSlices } from "../../platform/persistence/database.ts";
import { addNote } from "../../mech/util/rows.ts";
import { interrupt, park, pause, resume, unpark } from "../../mech/flow/intercept.ts";
import { dropGroup, startGroup, sweepApproved } from "../../mech/flow/start.ts";
import { openPr, prBody, prTitle } from "../../mech/git/prwatch.ts";
import { joinQueue, landed } from "../../mech/flow/mergequeue.ts";
import { validateDraftCard } from "../../mech/util/validate.ts";
import { canStart, CLAIMING_SQL, parseOwns } from "../../mech/flow/ownership.ts";
import { killSandbox } from "../../mech/sandbox/sandbox.ts";
import { clearSandboxLog } from "../../mech/sandbox/sandboxlog.ts";
import { z } from "zod";
import { Attachment as AttachmentSchema, IdParams } from "../../contracts/fields.ts";
import { newGroup } from "../../mech/flow/newgroup.ts";
import type { Handler } from "../../http/handler.ts";
import { bad, json, message } from "../../http/respond.ts";
import { withAttachments } from "../../mech/util/attachment-text.ts";
import { slug } from "../slug.ts";
import { say } from "../../platform/text/lang.ts";
import type { Ctx } from "../../mech/ctx.ts";
import type { GrpState } from "../../contracts/states.ts";
import { sediment } from "../../mech/knowledge/lessons.ts";

/** What the boss first asked for, for this group. */
function firstIdea(ctx: Ctx, groupId: number): string {
  return (
    ctx.db
      .query<{ body: string }, [number]>(
        "SELECT body FROM event WHERE grp_id = ? AND kind = 'boss_say' ORDER BY seq LIMIT 1",
      )
      .get(groupId)?.body ?? ""
  );
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
  const name = (b.name ?? slug(b.text)).slice(0, 40);
  // Attachments go on the blackboard as paths next to the words they came with, so
  // whoever plans this reads them in the same breath as the idea.
  const grp = newGroup(ctx, {
    projectId: b.project_id,
    name,
    idea: b.text,
    note: withAttachments(b.text, b.attachments),
  });
  // With another group already holding paths, the boundary has to be cut before
  // anyone plans work inside it — otherwise the plan is written against paths the
  // group turns out not to own.
  // fallow-ignore-next-line security-sink -- `CLAIMING_SQL` is `sql(CLAIMING)` in `mech/flow/ownership.ts`: a module-level constant built once from `GRP_STATES`, a source literal tuple. No value on this path is an input. The ids are bound through `?`.
  const others = ctx.db
    .query<{ id: number; name: string; owns_json: string }, [number, number]>(
      `SELECT id, name, owns_json FROM grp WHERE project_id = ? AND id != ?
         AND status IN ${CLAIMING_SQL}`,
    )
    .all(b.project_id, grp.id);
  if (others.length > 0) {
    // Every undeclared active group, not just the new one. The first group in a
    // project needs no boundary — but the moment a second appears, an undeclared
    // group beside a declared one is the exact situation the rule exists to
    // prevent, reached from the other direction.
    const needBoundary = [
      { id: grp.id, name, idea: b.text },
      ...others
        .filter((o) => parseOwns(o.owns_json).length === 0)
        .map((o) => ({ id: o.id, name: o.name, idea: firstIdea(ctx, o.id) })),
    ];
    ctx.sched.enqueue("agent_turn", {
      grp_id: grp.id,
      priority: 6,
      payload: { role: "architect", boundary: needBoundary, idea: b.text },
    });
  }

  // After the Architect's, when there is one: the boundary has to be cut before
  // anyone plans work inside it.
  ctx.sched.enqueue("agent_turn", { grp_id: grp.id, payload: { role: "dispatcher", idea: b.text } });
  ctx.sched.tick();
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

export const postDraftDecision = (async (ctx, _req, params, b) => {
  const grpId = params.id;
  const approve = params.decision === "approve";

  if (!approve) {
    const fact = withAttachments(`boss sent the DRAFT back: ${b.reason ?? ""}`, b.attachments);
    const projectId =
      ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
        ?.project_id ?? null;
    // Back to PLANNING, which is what the group actually is now. Left in DRAFT it
    // still counted as a decision waiting on the boss, still showed the rejected
    // card, and 批准开工 still worked on it — one stray click approves the very
    // plan that was just sent back.
    //
    // Clearing approved_at as well: sending a plan back withdraws the approval, or
    // the next card to reach DRAFT would start itself on the strength of a yes the
    // boss said to a plan that no longer exists.
    const why = withAttachments(b.reason ?? "respec", b.attachments);
    ctx.db.transaction(() => {
      addNote(ctx.db, { projectId, grpId, kind: "fact", lang: ctx.config.language, body: fact });
      ctx.db.run("UPDATE grp SET status = 'PLANNING', approved_at = NULL WHERE id = ? AND status = 'DRAFT'", [grpId]);
      ctx.bus.emit({ grpId, author: "boss", kind: "boss_say", intent: "request", body: why });
      ctx.sched.enqueue("agent_turn", { grp_id: grpId, payload: { role: "dispatcher", respec: why } });
    })();
    sediment(ctx, projectId, ctx.config.feedbackSedimentThreshold);
    ctx.sched.tick();
    return message("sent back");
  }

  // The boss usually approves what the Dispatcher filed; an edited card in the
  // request body is the "改完批准" path.
  const filed = ctx.db
    .query<{ body: string }, [number]>(
      `SELECT body FROM note WHERE grp_id = ? AND json_extract(frontmatter_json, '$.draft_card') = 1
       ORDER BY at DESC LIMIT 1`,
    )
    .get(grpId)?.body;
  const card = b.card ?? filed;

  if (card) {
    const v = validateDraftCard(card);
    if (!v.ok) return bad(v.error);
    // Four tables point at a slice, not one. Clearing only `task` left `job`,
    // `note` and `slice.depends_on` holding references, so re-approving a group
    // that had already run died on `FOREIGN KEY constraint failed` — see
    // `SLICE_REFS`.
    dropSlices(ctx.db, grpId);
    // A cap, per difficulty, written at birth. Until this, `budget_tokens` was
    // never INSERTed anywhere, so it was NULL on every row and both admission
    // checks in scheduler.ts had never stopped a single turn. It matters more now
    // that reviewers run on a CLI with no tool whitelist: the whitelist used to be
    // what bounded how much of the repo a review could read, and this is what
    // replaces it. The boss can raise any of them from the requirement page.
    const ins = ctx.db.query<{ id: number }, [number, number, string, string, string, number | null]>(
      `INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, budget_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    );
    // One task per slice, up front. Without something to claim the writer
    // improvises an id, `task done` never lands, and the whole review pipeline
    // silently never fires — which is exactly what the live run showed.
    const insTask = ctx.db.prepare(
      "INSERT INTO task (grp_id, slice_id, title, created_at) VALUES (?, ?, ?, unixepoch() * 1000)",
    );
    v.slices.forEach((sl, i) => {
      const row = ins.get(
        grpId,
        i + 1,
        sl.title,
        sl.accept,
        sl.difficulty,
        ctx.config.sliceBudgetTokens?.[sl.difficulty] ?? ctx.config.sliceBudgetTokens?.normal ?? null,
      )!;
      insTask.run(grpId, row.id, sl.title);
    });
  }
  // Boundaries before work. Two groups discovering at merge time that they were
  // both editing one file have already paid for the work twice.
  //
  // The slices above are written either way: without them there is nothing for the
  // automatic start to run once the boundary clears, and an edited card would be
  // lost between the two clicks.
  const start = canStart(ctx.db, grpId);
  if (!start.ok) {
    // A refusal used to end here, and the click was gone: the group sat in DRAFT
    // with nothing recording that the boss had said yes, and nobody re-ran it when
    // the group holding the paths merged. One click has to be final.
    ctx.db.run("UPDATE grp SET approved_at = unixepoch() * 1000 WHERE id = ?", [grpId]);
    // Put the Architect back on it — the boundary is its job, and it was observed
    // cutting one group's paths and forgetting the other's.
    // fallow-ignore-next-line security-sink -- `CLAIMING_SQL` is `sql(CLAIMING)` in `mech/flow/ownership.ts`: a module-level constant built once from `GRP_STATES`, a source literal tuple. No value on this path is an input. The ids are bound through `?`.
    const undeclared = ctx.db
      .query<{ id: number; name: string }, [number]>(
        `SELECT id, name FROM grp
         WHERE project_id = (SELECT project_id FROM grp WHERE id = ?)
           AND status IN ${CLAIMING_SQL}
           AND (owns_json IS NULL OR owns_json = '[]')`,
      )
      .all(grpId);
    if (undeclared.length) {
      ctx.sched.enqueue("agent_turn", {
        grp_id: grpId,
        priority: 7,
        payload: {
          role: "architect",
          boundary: undeclared.map((g) => ({ ...g, idea: firstIdea(ctx, g.id) })),
        },
      });
      ctx.sched.tick();
    }
    ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "state_change",
      body: say(ctx.config.language, "group.approve_held", { why: start.reason ?? "" }),
    });
    // 200, not 422: the boss did decide, and a red error toast says the opposite.
    return message(say(ctx.config.language, "group.approve_held", { why: start.reason ?? "" }));
  }

  const err = await startGroup(ctx, grpId);
  return err ? bad(err) : message("ok");
}) satisfies Handler<z.infer<typeof DraftDecisionBody>, z.infer<typeof DraftDecision>>;

/**
 * Wind a merged group up. One path, whether the boss said so or `gh` did.
 *
 * Dissolving is the most irreversible thing on the panel — the group leaves every
 * view — so it must never rest on a guess about whether the branch is in main.
 */
export function landGroup(ctx: Ctx, grpId: number, by: string): number[] {
  const stale = landed(ctx.db, grpId);
  ctx.bus.emit({ grpId, author: by, kind: "state_change", body: say(ctx.config.language, "group.merged") });

  // Turn this group's retro into lessons while the branch is fresh. This is
  // the only mechanism by which the twentieth group is smarter than the
  // first, so it runs on the way out, not "later".
  ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    payload: {
      role: "librarian",
      rejection:
        "This group just merged. Read its retro and journals, then update the project's " +
        "lesson list (`orch journal add --kind lesson`) with anything that would have changed " +
        "a decision. Refresh the onboarding pack if this changed how the project is built or tested.",
    },
  });
  for (const id of stale) {
    ctx.sched.enqueue("agent_turn", {
      grp_id: id,
      payload: {
        role: "engineer",
        rejection: "main moved: `git fetch origin main` and `git rebase origin/main` before doing anything else.",
        rotate: true,
      },
    });
  }
  ctx.sched.tick();
  return stale;
}

/**
 * The nine things the boss's row of buttons can do.
 *
 * This list used to live in the route's regular expression, where an unknown
 * action was a 404 — the path did not exist, so neither did the answer. That was
 * doing routing and validation with one mechanism, and it made the two failures
 * indistinguishable: a typo and a removed feature both came back "not found".
 *
 * `landed` is the one that matters. It was a button asking the boss to confirm a
 * merge, and one mis-click archived a group whose PR was still open — GitHub is
 * the only source for that, and `pollPrs` already asks it. Naming it here means
 * the refusal can say so.
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

function changeBudget(ctx: Ctx, grpId: number, tokens: number | null | undefined): Response {
  // Budget exhaustion suspends the group, and until this existed there was no
  // route out of it: 继续 un-paused a group the scheduler refused to admit,
  // so the next tick suspended it again. A limit needs a way to be raised.
  const t = normalizeBudget(tokens);
  const spent = ctx.db
    .query<{ spent_tokens: number; status: GrpState }, [number]>("SELECT spent_tokens, status FROM grp WHERE id = ?")
    .get(grpId);
  if (!spent) return message("no such group", 404);
  const error = budgetError(t, spent.spent_tokens);
  if (error) return error;
  recordBudget(ctx, grpId, t);
  if (spent.status === "PAUSED") resume(ctx, grpId);
  ctx.sched.tick();
  return json({ budget: t });
}

function normalizeBudget(tokens: number | null | undefined): number | null {
  if (tokens == null) return null;
  return Math.round(tokens);
}

function budgetError(tokens: number | null, spent: number): Response | null {
  if (tokens === null) return null;
  if (!(tokens > 0)) return bad("tokens must be a positive number, or null to lift the cap");
  if (tokens <= spent) return bad(`already spent ${spent} tokens — a cap at ${tokens} would stop it again immediately`);
  return null;
}

function recordBudget(ctx: Ctx, grpId: number, tokens: number | null): void {
  const description = tokens === null ? "budget cap lifted" : `budget raised to ${tokens} tokens`;
  ctx.db.run("UPDATE grp SET budget_tokens = ? WHERE id = ?", [tokens, grpId]);
  ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    body: description,
  });
  // Raising the cap is the answer to the question the watchdog asked, so it
  // also closes it: a stale "out of budget" row in 等你 is worse than none.
  ctx.db.run(
    `UPDATE escalation SET chain_state = 'answered', answered_by = 'boss', answer = ?, answered_at = unixepoch() * 1000
     WHERE grp_id = ? AND chain_state = 'boss' AND answer IS NULL AND question LIKE 'budget:%'`,
    [tokens === null ? "cap lifted" : `raised to ${tokens}`, grpId],
  );
}

function resumeGroup(ctx: Ctx, grpId: number): Response {
  // Un-pausing an over-budget group is a no-op the boss cannot see: the
  // scheduler refuses to admit it, so it sits in RUNNING doing nothing.
  const g = ctx.db
    .query<{ budget_tokens: number | null; spent_tokens: number }, [number]>(
      "SELECT budget_tokens, spent_tokens FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (g?.budget_tokens != null && g.spent_tokens >= g.budget_tokens) {
    return bad(
      `out of budget (${g.spent_tokens}/${g.budget_tokens} tokens). Raise the cap first, ` +
        `or it stops again on the next tick.`,
    );
  }
  resume(ctx, grpId);
  return message("ok");
}

async function replacePr(ctx: Ctx, grpId: number): Promise<Response> {
  // A closed PR normally comes back by being reopened on GitHub, and the
  // watchdog picks that up. But a PR cannot be reopened once its branch has
  // been force-pushed or deleted, and sometimes the boss simply wants a clean
  // one — without this the group is stuck holding a pr_number that openPr
  // treats as "already done", so it could never get another.
  const g = ctx.db
    .query<{ name: string; repo: string; pr_number: number | null }, [number]>(
      "SELECT g.name, p.repo_path AS repo, g.pr_number FROM grp g JOIN project p ON p.id = g.project_id WHERE g.id = ?",
    )
    .get(grpId);
  if (!g) return message("no such group", 404);
  if (!ctx.gh) return bad("no GitHub client on this server");
  ctx.db.run("UPDATE grp SET pr_number = NULL WHERE id = ?", [grpId]);
  const r = await openPr({
    ctx,
    gh: ctx.gh,
    grpId,
    title: prTitle(ctx.db, grpId),
    body: prBody(ctx.db, grpId),
  });
  if ("error" in r) {
    // Put the old number back: a group with no PR and no way to open one is
    // worse off than one whose PR is closed.
    ctx.db.run("UPDATE grp SET pr_number = ? WHERE id = ?", [g.pr_number, grpId]);
    return bad(r.error);
  }
  ctx.db.run("UPDATE grp SET status = 'PR_OPEN', paused_at = NULL, pause_reason = NULL WHERE id = ?", [grpId]);
  joinQueue(ctx.db, grpId);
  ctx.db.run(
    `UPDATE escalation SET chain_state = 'answered', answered_by = 'boss', answer = ?
     WHERE grp_id = ? AND answer IS NULL AND question LIKE 'PR #%被关掉了%'`,
    [`opened #${r.number} instead`, grpId],
  );
  ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    body: `opened PR #${r.number} to replace the closed one`,
    meta: { pr: r.number },
  });
  return json({ number: r.number });
}

async function dropRequirement(ctx: Ctx, grpId: number, why: string | undefined): Promise<Response> {
  // 不做了. A requirement that turned out to be a duplicate, or that someone
  // else already fixed, had no way off the board: 退回重拆 sends it back to the
  // Dispatcher, which writes another card for work nobody wants. The paths it
  // held stayed held, so a group waiting on them waited forever.
  const g = ctx.db
    .query<{ status: GrpState; name: string }, [number]>("SELECT status, name FROM grp WHERE id = ?")
    .get(grpId);
  if (!g) return message("no such group", 404);
  if (g.status === "DISSOLVED") return message("ok");
  dropGroup(ctx, grpId, why ?? "");
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
  ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    body: say(ctx.config.language, "sandbox.rebuild"),
  });
  ctx.sched.tick();
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
      const waiting = pause(ctx, grpId);
      return json({ status: waiting ? "PAUSING" : "PAUSED", waiting });
    }
    case "resume":
      return resumeGroup(ctx, grpId);
    case "park":
      park(ctx, grpId, "you parked it");
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
