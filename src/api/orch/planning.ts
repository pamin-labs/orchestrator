import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { z } from "zod";
import { addNote } from "../../mech/util/rows.ts";
import { SplitRequirements } from "../../contracts/orch.ts";
import { roleFor, type Ctx } from "../../mech/ctx.ts";
import type { Caller } from "../../http/agent-auth.ts";
import type { AgentHandler } from "../../http/handler.ts";
import { bad, json, message } from "../../http/respond.ts";
import { say } from "../../platform/text/lang.ts";
import { hold } from "../../mech/flow/intercept.ts";
import { newGroup } from "../../mech/flow/newgroup.ts";
import { CLAIMING, canStart, claimsShared, overlaps, parseOwns, sharedFor } from "../../mech/flow/ownership.ts";
import { extractClaimedFiles } from "../../mech/flow/reconcile.ts";
import { sweepApproved } from "../../mech/flow/start.ts";
import { baseBranch, baseRefFor, sandboxGit, treeFiles } from "../../mech/git/checkout.ts";
import { execIn, WORK } from "../../mech/sandbox/sandbox.ts";
import { shq } from "../../platform/process/shell.ts";
import { validateDraftCard } from "../../mech/util/validate.ts";
import { GroupRef } from "../../contracts/fields.ts";
import { mayAct, resolveGroup } from "./access.ts";
import { slug } from "../slug.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { channel, grp as grps, note as notes, project, slice } from "../../platform/persistence/schema.ts";

function actingGroup(ctx: Ctx, caller: Caller, ref: z.infer<typeof GroupRef> | null | undefined): number | Response {
  const groupId = resolveGroup(ctx, ref, caller.grp_id);
  if (!groupId) return bad("which group? pass its id or name");
  return mayAct(ctx.db, caller, groupId) ? groupId : message("not your group", 403);
}

/**
 * Who may write the plan: the role that splits a requirement, or the one that
 * leads the group once it is running and owns the work in flight.
 */
const plans = (ctx: Ctx, a: Caller): boolean =>
  a.role === roleFor(ctx, "plan_requirement") || a.role === roleFor(ctx, "lead_group");

/**
 * What a group does with its own plan: file the DRAFT card, fan out into
 * several groups, propose that the work is already done, report a path it may
 * not touch, and declare which paths it owns.
 *
 * All five are verbs an agent calls and all five can create or dissolve a
 * group, which is why they are one file: the invariant that a group has exactly
 * one owner of any path is enforced across them, not inside any one of them.
 */

/**
 * The Dispatcher files its DRAFT card.
 *
 * Validated here rather than trusted, and the group only becomes DRAFT once a
 * card exists — the boss should never be asked to approve nothing.
 */
/**
 * The card, unparsed.
 *
 * `validateDraftCard` owns its shape — the sections, the 12-line cap, the
 * slice-count rule — and its refusals are written to teach a dispatcher what to
 * write next. A second opinion here could only be a weaker one.
 */
export const DraftBody = z.object({ group_id: GroupRef.optional(), card: z.string().min(1).max(20_000) });

export const postDraft = (async (ctx, _req, a, _p, b) => {
  if (!plans(ctx, a)) return bad(`${a.role} does not file DRAFT cards`);

  const v = validateDraftCard(b.card);
  if (!v.ok) return bad(v.error);

  const grpId = actingGroup(ctx, a, b.group_id);
  if (grpId instanceof Response) return grpId;
  const grp = orm(ctx.db).select({ project_id: grps.project_id }).from(grps).where(eq(grps.id, grpId)).get();
  if (!grp) return bad(`no group ${grpId}`);

  // Paths the card names that are not in the repo.
  //
  // Not a refusal — a card that plans a new file names it, and that is the whole
  // point of planning. But a plan written from memory of a codebase rather than
  // from reading it names files that were never there, and that is the cheapest
  // detectable symptom of the one failure with no deterministic line under it
  // (docs/project/plan.md §13 risk ①): a decomposition pointed the wrong way. The boss gets the
  // list beside the card and decides which it is, in the same 20 seconds.
  //
  // Against the base ref rather than what is on disk: the host checkout sits on
  // whatever branch the boss last had out, so `existsSync` was asking a working
  // tree nobody planned against, and the answer moved when the boss switched
  // branches. `ls-tree` of the base is the same thing the group will be cut from.
  const remote = orm(ctx.db)
    .select({ remote: project.remote })
    .from(project)
    .where(eq(project.id, grp.project_id))
    .get()?.remote;
  const claimed = extractClaimedFiles([b.card]);
  let missingPaths: string[] = [];
  if (remote && claimed.length) {
    // Out of the utility container's mirror, not a checkout on this host: there
    // is none since step 6, and asking one that was not there threw rather than
    // returning a code — which is how this handler used to 500 with the DRAFT
    // card unfiled and nothing saying so.
    const inBase = new Set(await treeFiles(ctx, remote, await baseBranch(ctx, grp.project_id)));
    if (inBase.size) missingPaths = claimed.filter((p) => !inBase.has(p)).slice(0, 8);
  }

  ctx.db.transaction(() => {
    addNote(ctx.db, {
      projectId: grp.project_id,
      grpId,
      kind: "fact",
      lang: ctx.config.language,
      body: b.card,
      frontmatterJson: JSON.stringify({
        draft_card: true,
        ...(missingPaths.length ? { unknownPaths: missingPaths } : {}),
      }),
    });
    orm(ctx.db).update(grps).set({ status: "DRAFT" }).where(eq(grps.id, grpId)).run();
    // Planning is over, so anything still queued for this group is moot — and DRAFT
    // is not dispatchable, so it would otherwise sit pending forever and then fire
    // after approval against a plan it never saw.
    const dropped = ctx.sched.cancelPending(grpId, "planning finished");
    ctx.bus.emit({
      grpId,
      author: a.role,
      kind: "state_change",
      body: `DRAFT card filed: ${v.goal}${dropped ? ` (${dropped} planning turn(s) dropped)` : ""}`,
      meta: { slices: v.slices.length, objection: v.objection },
    });
  })();
  ctx.notifyBoss?.(0, `DRAFT ready: ${v.goal}`, "advisory");
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof DraftBody>>;

/**
 * One idea, several requirements.
 *
 * What lands in the box is often not one thing. Until this existed the shape of
 * the system forced all of it into ONE requirement — one DRAFT card, one 目标 line,
 * one branch, one Engineer working serially, one PR. The Dispatcher could drop
 * most of it or write a 目标 that was not true, and `checkSplit` would not object,
 * because four unrelated slices genuinely do have four acceptance criteria.
 */
/**
 * A requirement is the unit of a PR and of acceptance, so unrelated work must be
 * unrelated requirements: separate branches, boundaries, separately mergeable and
 * rejectable. Splitting **is** decomposition, which makes it the Dispatcher's job
 * — so it gets a verb rather than a prompt telling it to cope.
 *
 * Only before work exists: after a card is approved there is a branch and a
 * checkout, and re-cutting then is `respec`.
 */
const MAX_SPLIT = 6;

export const SplitBody = z.object({
  group_id: GroupRef,
  requirements: SplitRequirements.optional(),
  why: z.string().max(4000).optional(),
});

export const postSplit = (async (ctx, _req, a, _p, b) => {
  if (!plans(ctx, a)) return bad(`${a.role} does not split requirements`);

  const gid = actingGroup(ctx, a, b.group_id);
  if (gid instanceof Response) return gid;
  const grp = orm(ctx.db)
    .select({ project_id: grps.project_id, name: grps.name, status: grps.status, branch: grps.branch })
    .from(grps)
    .where(eq(grps.id, gid))
    .get();
  if (!grp) return message("no such group", 404);
  if (grp.status !== "PLANNING") {
    return bad(
      `${grp.name} is ${grp.status}, not PLANNING. A split only makes sense before a card is approved; ` +
        `after that the branch exists and re-cutting the work is the boss's respec, not yours.`,
    );
  }
  const hasWork = orm(ctx.db).select({ c: count() }).from(slice).where(eq(slice.grp_id, gid)).get()!.c;
  if (hasWork > 0 || grp.branch) return bad(`${grp.name} already has slices or a branch; split before that`);

  const items = (b.requirements ?? []).filter((r) => r?.idea?.trim());
  if (items.length < 2) {
    return bad("a split needs at least 2 requirements. If it is one thing, just file the card with `orch draft`.");
  }
  if (items.length > MAX_SPLIT) {
    return bad(
      `${items.length} is too many for one split (max ${MAX_SPLIT}). Group what shares an acceptance path, ` +
        `and ask the boss which of the rest matters first.`,
    );
  }

  // What the boss originally said, so nothing typed in that box is lost — including
  // the attachment paths, which live in the first note.
  const original = orm(ctx.db)
    .select({ id: notes.id, body: notes.body })
    .from(notes)
    .where(and(eq(notes.grp_id, gid), eq(notes.kind, "fact")))
    // Both keys, oldest first: `at` is a millisecond clock, and the first thing the
    // boss typed shares one with whatever the same request wrote beside it.
    .orderBy(asc(notes.at), asc(notes.id))
    .limit(1)
    .get();

  const made = ctx.db.transaction(() => {
    const created: { id: number; name: string }[] = [];
    for (const item of items) {
      // Slugged even when the agent supplied it. A group name becomes a branch
      // (`orch/<name>`), a path under docs/journal and an argument to host git —
      // "whatever 40 characters an agent felt like" is not a shape any of those want.
      const name = slug(item.name?.trim() || item.idea);
      const child = newGroup(ctx, {
        projectId: grp.project_id,
        name,
        idea: item.idea.trim(),
        note: `${item.idea.trim()}\n\n（从「${grp.name}」拆出来的一条${original ? `，原始整段见 note #${original.id}` : ""}）`,
      });
      ctx.sched.enqueue("agent_turn", {
        grp_id: child.id,
        priority: 5,
        payload: { role: roleFor(ctx, "plan_requirement"), idea: item.idea.trim() },
      });
      created.push({ id: child.id, name });
    }

    // The container is done: its pending turns would re-plan work that has moved. No
    // retro — it never did any work, and demanding one for a bookkeeping group would
    // teach the agents that retros are paperwork.
    ctx.sched.cancelPending(gid, "split into separate requirements");
    orm(ctx.db).update(grps).set({ status: "DISSOLVED" }).where(eq(grps.id, gid)).run();
    orm(ctx.db).update(channel).set({ status: "archived" }).where(eq(channel.grp_id, gid)).run();
    ctx.bus.emit({
      grpId: gid,
      author: a.role,
      kind: "state_change",
      body: `拆成 ${created.length} 个独立需求：${created.map((m) => m.name).join("、")}${b.why ? ` —— ${b.why}` : ""}`,
      meta: { split: created.map((m) => m.id) },
    });
    return created;
  })();
  ctx.sched.tick();
  return json({ requirements: made });
}) satisfies AgentHandler<z.infer<typeof SplitBody>>;

/**
 * "This is already done." The one thing a planner could not say.
 *
 * A requirement that is a duplicate, or that someone fixed between the boss typing
 * it and the Dispatcher reading the code, has no exit: the Dispatcher digs in,
 * slices it, and files a card for work that does not need doing. The only thing
 * between that and a group burning a day is the boss's twenty seconds on the DRAFT
 * card — the one judgement in the system with no deterministic line under it.
 */
/**
 * This is not the agent dissolving the group, and it cannot be: "there is nothing
 * to do here" is the most attractive thing a tired model can conclude, and no
 * prompt survives being the cheap way out. So it is a proposal, it costs evidence
 * the server checks itself — a commit really in the repo, a group that really
 * exists — and the boss presses the button.
 */
export const DropBody = z.object({
  group_id: GroupRef.optional(),
  // Checked for length below, with the message that says what it has to contain.
  why: z.string().max(4000).default(""),
  commit: z.string().max(200).optional(),
  duplicate: GroupRef.optional(),
});

function duplicateEvidence(ctx: Ctx, gid: number, ref: z.infer<typeof GroupRef>): string | Response {
  const duplicateId = resolveGroup(ctx, ref);
  if (!duplicateId) return bad(`no group ${ref}`);
  if (duplicateId === gid) return bad("a group cannot be a duplicate of itself");
  const duplicate = orm(ctx.db).select({ name: grps.name }).from(grps).where(eq(grps.id, duplicateId)).get()!;
  return `duplicate of ${duplicate.name} (grp ${duplicateId})`;
}

async function commitEvidence(ctx: Ctx, gid: number, sha: string): Promise<string | Response> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return bad("--commit takes a sha, 7 to 40 hex characters");
  const git = sandboxGit(ctx, { grp: gid });
  const commit = await git(["cat-file", "-t", sha], WORK);
  if (commit.code !== 0 || commit.out.trim() !== "commit") return bad(`${sha} is not a commit in this repo`);
  const projectId = orm(ctx.db)
    .select({ project_id: grps.project_id })
    .from(grps)
    .where(eq(grps.id, gid))
    .get()?.project_id;
  if (!projectId) return bad("no such group");
  const base = await baseRefFor(ctx, projectId);
  const merged = await git(["merge-base", "--is-ancestor", sha, base], WORK);
  return merged.code === 0
    ? `already landed in ${sha.slice(0, 8)}`
    : bad(`${sha.slice(0, 8)} is a real commit but is not on ${base} yet`);
}

async function dropEvidence(ctx: Ctx, gid: number, body: z.infer<typeof DropBody>): Promise<string | Response> {
  if (body.duplicate != null) return duplicateEvidence(ctx, gid, body.duplicate);
  if (!body.commit) return bad("give evidence: --duplicate <group> or --commit <sha>");
  return commitEvidence(ctx, gid, body.commit.trim());
}

export const postDrop = (async (ctx, _req, a, _p, b) => {
  if (!plans(ctx, a) && a.role !== roleFor(ctx, "cut_boundary")) return bad(`${a.role} does not propose dropping work`);
  const gid = actingGroup(ctx, a, b.group_id);
  if (gid instanceof Response) return gid;
  const why = b.why.trim();
  if (why.length < 10) return bad("--why has to say what already covers it, in a sentence");

  // Evidence the server can check. A sentence alone is a model's opinion of its
  // own workload, which is exactly what must not be able to close a requirement.
  const evidence = await dropEvidence(ctx, gid, b);
  if (evidence instanceof Response) return evidence;

  ctx.db.transaction(() => {
    // The project came from a subquery here and is looked up instead: `addNote`
    // takes a value, and a caller that already has the group id can find it.
    addNote(ctx.db, {
      projectId:
        orm(ctx.db).select({ project_id: grps.project_id }).from(grps).where(eq(grps.id, gid)).get()?.project_id ??
        null,
      grpId: gid,
      kind: "decision",
      lang: ctx.config.language,
      body: `${why}\n\n证据：${evidence}`,
      frontmatterJson: JSON.stringify({ drop_proposal: 1 }),
    });
    // DRAFT, so the group stops being dispatchable and the boss is asked. Left in
    // PLANNING the Dispatcher would be woken again and re-propose the same thing.
    orm(ctx.db)
      .update(grps)
      .set({ status: "DRAFT" })
      .where(and(eq(grps.id, gid), eq(grps.status, "PLANNING")))
      .run();
    ctx.bus.emit({
      grpId: gid,
      author: a.role,
      kind: "decision",
      intent: "decision",
      body: `建议作废：${why}（${evidence}）`,
      meta: { drop_proposal: true, evidence },
    });
  })();
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof DropBody>>;

/**
 * "I am blocked by something I am not allowed to touch."
 *
 * Seen whole: a gate failed on a missing line in `tsconfig.json`, which the group
 * does not own, so the sandbox refused the write. There was no verb for opening a
 * requirement about it, and `orch mail` is a message that creates no work — so the
 * agent rewrote its own code three times, hit the retry ceiling, escalated, and
 * stopped. The boss got a blocker with no button on it.
 */
/**
 * The evidence is the path itself: the server checks the file exists and is
 * genuinely outside this group's boundary. "I cannot reach it" is a fact about the
 * repository, not a claim about how hard the work is — which is what separates
 * this from a way out of difficult work.
 *
 * Where it goes is decided here, not by the agent: a live group that owns the path
 * gets it as an addition; if nobody owns it, it becomes a requirement the boss
 * approves like any other.
 */
export const BlockedBody = z.object({
  group_id: GroupRef.optional(),
  path: z.string().max(400).default(""),
  why: z.string().max(4000).default(""),
});

type BlockedGroup = { project_id: number; name: string; owns_json: string };
type PathOwner = { id: number; name: string; owns_json: string };

function pathOwner(db: DB, projectId: number, blockedGroupId: number, path: string): PathOwner | null {
  return (
    orm(db)
      .select({ id: grps.id, name: grps.name, owns_json: grps.owns_json })
      .from(grps)
      // `CLAIMING` is the state list itself, bound as parameters. The suppression
      // this replaces existed to explain that `CLAIMING_SQL` interpolated no input.
      .where(and(eq(grps.project_id, projectId), ne(grps.id, blockedGroupId), inArray(grps.status, CLAIMING)))
      .all()
      .find((group) => parseOwns(group.owns_json).some((glob) => overlaps(glob, path))) ?? null
  );
}

function waitsOn(db: DB, start: number, target: number): boolean {
  let group: number | null = start;
  for (let hops = 0; group && hops < 32; hops++) {
    if (group === target) return true;
    group =
      orm(db).select({ blocked_on: grps.blocked_on }).from(grps).where(eq(grps.id, group)).get()?.blocked_on ?? null;
  }
  return false;
}

function routeBlockedPath(
  ctx: Ctx,
  caller: Caller,
  group: BlockedGroup,
  groupId: number,
  path: string,
  why: string,
  owner: PathOwner | null,
): { target: number; handedTo: string } {
  if (owner) {
    ctx.bus.emit({
      grpId: owner.id,
      author: caller.role,
      kind: "say",
      intent: "request",
      body: `${group.name} 被 ${path} 挡住了，那是你们的路径：${why}`,
      meta: { from_group: groupId, path },
    });
    ctx.sched.enqueue("agent_turn", {
      grp_id: owner.id,
      priority: 6,
      payload: {
        role: roleFor(ctx, "lead_group"),
        rejection: `Another group is blocked on ${path}, which is inside your boundary: ${why}\n\nAdd it to this group's work.`,
      },
    });
    return { target: owner.id, handedTo: owner.name };
  }

  // A shared file belongs to no group on purpose. The grant names this one path
  // for this one group, so every other group remains outside the boundary.
  const name = slug(`${path} ${why}`).slice(0, 40) || `fix-${groupId}`;
  const grant = claimsShared([path], sharedFor(ctx.db, group.project_id));
  const idea = `${why}\n\n（${group.name} 报的：${path} 不在它的边界内，它改不了）`;
  const created = newGroup(ctx, {
    projectId: group.project_id,
    name,
    idea,
    author: caller.role,
    owns: [path],
    sharedGrant: grant,
  });
  ctx.sched.enqueue("agent_turn", {
    grp_id: created.id,
    priority: 6,
    payload: { role: roleFor(ctx, "plan_requirement"), idea },
  });
  return { target: created.id, handedTo: "a new requirement" };
}

export const postBlocked = (async (ctx, _req, a, _p, b) => {
  const gid = actingGroup(ctx, a, b.group_id);
  if (gid instanceof Response) return gid;
  const path = b.path.trim().replace(/^\.\//, "");
  const why = b.why.trim();
  if (!path) return bad("--path <file> — which file you cannot change");
  if (why.length < 10) return bad("--why has to say what is wrong with it, in a sentence");

  const me = orm(ctx.db)
    .select({ project_id: grps.project_id, name: grps.name, owns_json: grps.owns_json })
    .from(grps)
    .where(eq(grps.id, gid))
    .get();
  if (!me) return bad("no such group");
  // In the group's own checkout, not the host's. The caller named this path from
  // inside `/work`, and the host main checkout sits on whatever the boss last had
  // out — so a file the group created, or one that exists only on its branch,
  // came back as "not a file in this repo", which is both wrong and misleading.
  const seen = await execIn(ctx, { grp: gid }, `test -e ${shq(`${WORK}/${path}`)}`);
  if (seen.code !== 0) return bad(`${path} is not a file in your checkout`);
  // The whole justification. Inside its own boundary the group is expected to fix
  // it, and saying otherwise is the cheap way out of difficult work.
  if (parseOwns(me.owns_json).some((o) => overlaps(o, path))) {
    return bad(`${path} is inside your own boundary — fix it`);
  }

  const owner = pathOwner(ctx.db, me.project_id, gid, path);

  // Two groups each waiting on the other is two groups that never move again, and
  // nothing downstream would notice: both are PAUSED for a stated reason, and the
  // reason is each other.
  if (owner && waitsOn(ctx.db, owner.id, gid)) {
    return bad(`${owner.name} is already waiting on you — one of you has to go first`);
  }
  const routed = ctx.db.transaction(() => {
    const destination = routeBlockedPath(ctx, a, me, gid, path, why, owner);

    // Stop, and say what it is waiting for. PAUSED rather than a spin: a group with
    // nothing it can legally do should not hold a concurrency slot.
    hold(ctx.db, gid, { reason: "blocked", settled: true, on: destination.target });
    ctx.sched.cancelPending(gid, `blocked on ${path}`);
    ctx.bus.emit({
      grpId: gid,
      author: a.role,
      kind: "state_change",
      body: say(ctx.config.language, "group.blocked", { path, target: String(destination.target) }),
      meta: { blocked_on: destination.target, path },
    });
    return destination;
  })();
  ctx.sched.tick();
  return json({ blocked_on: routed.target, handedTo: routed.handedTo });
}) satisfies AgentHandler<z.infer<typeof BlockedBody>>;

export const OwnsBody = z.object({
  group_id: GroupRef.optional(),
  paths: z.array(z.string().min(1).max(400)).min(1, "give at least one path glob").max(200),
});

export const postOwns = (async (ctx, _req, a, _p, b) => {
  if (a.role !== roleFor(ctx, "cut_boundary")) return bad(`${a.role} does not cut boundaries`);
  const gid = actingGroup(ctx, a, b.group_id);
  if (gid instanceof Response) return gid;

  const check = ctx.db.transaction(() => {
    orm(ctx.db)
      .update(grps)
      .set({ owns_json: JSON.stringify(b.paths) })
      .where(eq(grps.id, gid))
      .run();
    const result = canStart(ctx.db, gid);
    ctx.bus.emit({
      grpId: gid,
      author: roleFor(ctx, "cut_boundary"),
      kind: "decision",
      intent: "decision",
      body: `owns ${b.paths.join(", ")}${result.ok ? "" : ` — still blocked: ${result.reason}`}`,
      meta: { paths: b.paths, ok: result.ok },
    });
    return result;
  })();
  // A re-cut can free a group other than the one it touched, so the whole project
  // is swept. Without this the boss's approval sat waiting on a boundary that had
  // already been drawn.
  await sweepApproved(ctx);
  return check.ok ? message("ok") : bad(check.reason ?? "boundary still overlaps");
}) satisfies AgentHandler<z.infer<typeof OwnsBody>>;
