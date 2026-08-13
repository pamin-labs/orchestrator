import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../api.ts";
import type { Config } from "../config.ts";
import { say } from "../lang.ts";
import { runGates, recordGate, gateState } from "./gate.ts";
import { extractClaimedFiles, reconcile } from "./reconcile.ts";
import { changedSince, filesAt, type GitRunner } from "./worktree.ts";
import { joinQueue, position } from "./mergequeue.ts";

/**
 * Slice-level review, in the one order that makes sense.
 *
 *   self-review (in the writer's own turn)  ->  reconcile  ->  gate  ->  QA  ->  boss
 *
 * The two deterministic layers come first because they are free and certain, and
 * because letting a reviewer look at work whose claims are false, or whose tests
 * do not compile, wastes the expensive judgement on the wrong question.
 */

export interface ReviewDeps {
  ctx: Ctx;
  cfg: Config;
  git: GitRunner;
  /** Wired by the server: opens the PR once a branch passes its audit. */
  onAuditPass?: (grpId: number) => void;
}

export interface SliceRow {
  id: number;
  grp_id: number;
  seq: number;
  title: string;
  accept_spec: string;
  difficulty: string;
  base_sha: string | null;
  retries: number;
}

export function loadSlice(ctx: Ctx, sliceId: number): SliceRow | null {
  return (
    ctx.db
      .query<SliceRow, [number]>(
        "SELECT id, grp_id, seq, title, accept_spec, difficulty, base_sha, retries FROM slice WHERE id = ?",
      )
      .get(sliceId) ?? null
  );
}

/**
 * Run the deterministic half. Returns the feedback to send back on failure.
 *
 * Nothing here consults a model, so the verdict is reproducible and the boss can
 * be told exactly why a slice was sent back.
 */
export async function runDeterministicReview(
  deps: ReviewDeps,
  sliceId: number,
): Promise<{ pass: boolean; feedback: string }> {
  const { ctx, cfg, git } = deps;
  const slice = loadSlice(ctx, sliceId);
  if (!slice) return { pass: false, feedback: "slice disappeared" };

  const grp = ctx.db
    .query<{ project_id: number; worktree: string | null }, [number]>(
      "SELECT project_id, worktree FROM grp WHERE id = ?",
    )
    .get(slice.grp_id);
  const repo = grp
    ? ctx.db
        .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
        .get(grp.project_id)?.repo_path
    : undefined;

  // --- reconcile: what was claimed against what git shows for THIS slice
  const claims = ctx.db
    .query<{ claim_json: string | null }, [number]>(
      "SELECT claim_json FROM task WHERE slice_id = ? AND status = 'done'",
    )
    .all(sliceId)
    .map((r) => safeJson(r.claim_json));

  let changed: string[] = [];
  let absent: string[] = [];
  if (repo && grp?.worktree && slice.base_sha) {
    changed = await changedSince(git, repo, grp.worktree, slice.base_sha);
    // A path that is in neither the branch point nor the worktree: a scratch file
    // created and then deleted inside this slice. Git has no record of it either
    // way, so it cannot be a delivery — and it must not be scored as a lie.
    const known = new Set(await filesAt(git, repo, grp.worktree, slice.base_sha));
    absent = extractClaimedFiles(claims).filter(
      (c) => !known.has(c) && !existsSync(join(grp.worktree!, c)),
    );
  }
  const rec = reconcile({ claims, changedFiles: changed, absent });
  recordGate(ctx.db, sliceId, "reconcile", rec.pass ? "pass" : "fail");
  if (!rec.pass) {
    ctx.bus.emit({
      grpId: slice.grp_id,
      author: "orchestrator",
      kind: "gate_result",
      body: say(ctx.config?.language, "gate.reconcile", { seq: slice.seq, reason: rec.reason ?? "" }),
      meta: { slice_id: sliceId, phantom: rec.phantom },
    });
    return {
      pass: false,
      feedback:
        `Reconcile failed: ${rec.reason}.\n` +
        `git shows these changed: ${changed.length ? changed.join(", ") : "(nothing)"}.\n` +
        `Either make the change or correct the claim — both are cheaper than a reviewer's time.`,
    };
  }

  // --- gate: exit codes, no opinions
  const out = await runGates({
    db: ctx.db,
    projectId: grp!.project_id,
    cwd: grp?.worktree ?? repo ?? process.cwd(),
    dataDir: cfg.dataDir,
    sliceId,
    timeoutMs: cfg.leaseTimeoutMs,
  });
  recordGate(ctx.db, sliceId, "gate", out.pass ? "pass" : "fail");
  ctx.bus.emit({
    grpId: slice.grp_id,
    author: "orchestrator",
    kind: "gate_result",
    body: say(ctx.config?.language, out.pass ? "gate.pass" : "gate.fail", { seq: slice.seq }),
    meta: { slice_id: sliceId, results: out.results.map((r) => ({ name: r.name, pass: r.pass })) },
  });
  if (!out.pass) return { pass: false, feedback: out.feedback };

  if (rec.unclaimed.length) {
    // Not a defect, but the reviewer should know what else moved.
    ctx.bus.emit({
      grpId: slice.grp_id,
      author: "orchestrator",
      kind: "gate_result",
      body: say(ctx.config?.language, "gate.unclaimed", {
        seq: slice.seq,
        files: rec.unclaimed.slice(0, 10).join(", "),
      }),
      meta: { slice_id: sliceId },
    });
  }
  return { pass: true, feedback: out.feedback };
}

/**
 * Send a slice back to the writer.
 *
 * The retry always starts a FRESH session carrying only the acceptance spec, the
 * failing lines and the current diff. Resuming the old session would drag along
 * a history that is mostly the failed attempt.
 */
export function sendBack(deps: ReviewDeps, sliceId: number, feedback: string, from: string): void {
  const { ctx, cfg } = deps;
  const slice = loadSlice(ctx, sliceId);
  if (!slice) return;

  const retries = slice.retries + 1;
  ctx.db.run("UPDATE slice SET retries = ?, status = 'running' WHERE id = ?", [retries, sliceId]);

  if (retries > cfg.gateRetries) {
    // Looping forever is worse than interrupting the boss. Two failed attempts
    // usually means the acceptance criteria are wrong, not the code.
    // 'boss', not the default 'pm'. The next line pauses the group, so the PM this
    // was addressed to cannot run — the question sat at chain_state='pm' forever,
    // never reached 待你决策, and the only visible symptom was a paused group with
    // no reason attached. Observed on pm-ai-agent: a blocker filed two hours
    // earlier that the boss had no way to see.
    ctx.db.run(
      `INSERT INTO escalation (grp_id, severity, question, chain_state, created_at)
       VALUES (?, 'blocker', ?, 'boss', unixepoch() * 1000)`,
      [
        slice.grp_id,
        `S${slice.seq} "${slice.title}" failed ${from} ${retries} times. Latest:\n${feedback}`,
      ],
    );
    ctx.db.run("UPDATE slice SET status = 'rejected' WHERE id = ?", [sliceId]);
    ctx.db.run("UPDATE grp SET status = 'PAUSING' WHERE id = ? AND status = 'RUNNING'", [slice.grp_id]);
    ctx.bus.emit({
      grpId: slice.grp_id,
      author: "orchestrator",
      kind: "escalation",
      intent: "ask",
      severity: "blocker",
      body: say(ctx.config?.language, "slice.failed", { seq: slice.seq, from, n: retries }),
      meta: { slice_id: sliceId },
    });
    return;
  }

  ctx.bus.emit({
    grpId: slice.grp_id,
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config?.language, "slice.sentback", { seq: slice.seq, from, n: retries }),
    meta: { slice_id: sliceId },
  });
  ctx.sched.enqueue("agent_turn", {
    grp_id: slice.grp_id,
    slice_id: sliceId,
    payload: { role: "engineer", rejection: feedback, rotate: true },
  });
  ctx.sched.tick();
}

/** Deterministic half passed: hand the slice to QA. */
export function handToQa(deps: ReviewDeps, sliceId: number): void {
  const { ctx } = deps;
  const slice = loadSlice(ctx, sliceId);
  if (!slice) return;
  ctx.db.run("UPDATE slice SET status = 'qa' WHERE id = ?", [sliceId]);
  ctx.sched.enqueue("agent_turn", {
    grp_id: slice.grp_id,
    slice_id: sliceId,
    payload: { role: "qa", review: sliceId },
  });
  ctx.sched.tick();
}

/** QA passed: the slice is the boss's to accept. */
export function handToBoss(deps: Pick<ReviewDeps, "ctx">, sliceId: number): void {
  const { ctx } = deps;
  const slice = loadSlice(ctx, sliceId);
  if (!slice) return;
  recordGate(ctx.db, sliceId, "qa", "pass");
  ctx.db.run("UPDATE slice SET status = 'awaiting_boss', awaiting_at = unixepoch() * 1000 WHERE id = ?", [sliceId]);

  // Retire the sessions that carried this slice. A slice is a natural semantic
  // break, so the handoff is cheap, and a session that keeps growing costs more on
  // every remaining turn even at the cached rate.
  //
  // The writer and its reviewer only — not the whole roster. Rotating everyone cost
  // a full prefix rebuild per role per slice: measured over 259 turns, 95% of them
  // started on a cold prefix and cache creation came to 45.5M tokens, which bills
  // like ~570M cached reads. The PM, Dispatcher and Auditor carry group-level
  // context that is still true in the next slice, so throwing it away buys nothing.
  ctx.db.run(
    `UPDATE agent SET session_id = NULL, session_tokens = 0
     WHERE grp_id = ? AND state != 'retired' AND role IN ('engineer','qa')`,
    [slice.grp_id],
  );
  ctx.bus.emit({
    grpId: slice.grp_id,
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config?.language, "slice.ready", { seq: slice.seq, title: slice.title }),
    meta: { slice_id: sliceId, gates: gateState(ctx.db, sliceId) },
  });

  // Trivial work the boss chose not to look at. Every gate still ran — self
  // review, the deterministic gate, an independent QA — so this skips the fourth
  // layer, not the first three. It is announced, never silent: an acceptance
  // nobody can see is indistinguishable from one that did not happen.
  if ((ctx.config?.autoAcceptTiers ?? []).includes(slice.difficulty)) {
    acceptSlice(ctx, sliceId, "orchestrator", say(ctx.config?.language, "slice.autoaccept", { tier: slice.difficulty }));
    return;
  }

  // Approving at night should buy a night of work. Acceptance is what normally
  // starts the next slice, so without this a group does exactly one slice and
  // then waits until morning. The slice still waits to be accepted; only the
  // next one stops waiting.
  if (ctx.config?.autoAdvance) {
    const started = startNextSlice(ctx, slice.grp_id);
    if (started) {
      ctx.bus.emit({
        grpId: slice.grp_id,
        author: "orchestrator",
        kind: "state_change",
        body: say(ctx.config?.language, "group.autoadvance"),
        meta: { slice_id: started },
      });
    }
  }
}

/**
 * A slice is accepted. One path, whoever accepted it.
 *
 * The boss's button and the auto-accept policy must not be two implementations:
 * "what happens when a slice is accepted" is a rule about the pipeline, and a
 * second copy of it would drift the day one of them gained a step.
 */
export function acceptSlice(ctx: Ctx, sliceId: number, by: string, why?: string): void {
  const sl = ctx.db
    .query<{ grp_id: number; seq: number; title: string }, [number]>(
      "SELECT grp_id, seq, title FROM slice WHERE id = ?",
    )
    .get(sliceId);
  if (!sl) return;

  ctx.db.run("UPDATE slice SET status = 'accepted' WHERE id = ?", [sliceId]);
  ctx.bus.emit({
    grpId: sl.grp_id,
    author: by,
    kind: "state_change",
    body: say(ctx.config?.language, "slice.accepted", {
      seq: sl.seq,
      title: sl.title,
      why: why ? `（${why}）` : "",
    }),
    meta: { slice_id: sliceId, by },
  });

  // Accepting one slice is what starts the next.
  startNextSlice(ctx, sl.grp_id);

  // The last acceptance starts PR-level review. Nothing an agent does can trigger
  // it: "satisfied" is the boss's call, or a policy the boss switched on.
  const open = ctx.db
    .query<{ c: number }, [number]>("SELECT count(*) AS c FROM slice WHERE grp_id = ? AND status != 'accepted'")
    .get(sl.grp_id)!.c;
  if (open === 0) ctx.sched.enqueue("reconcile", { grp_id: sl.grp_id, priority: 5 });
  ctx.sched.tick();
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * PR-level review, run once every slice has been accepted by the boss.
 *
 * Deterministic first, same as at slice level: the whole branch is reconciled and
 * gated before the Auditor is asked for judgement.
 */
export async function runPrReview(deps: ReviewDeps, grpId: number): Promise<void> {
  const { ctx, cfg, git } = deps;
  const grp = ctx.db
    .query<{ project_id: number; worktree: string | null; branch: string | null; name: string }, [number]>(
      "SELECT project_id, worktree, branch, name FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!grp) return;

  // A group cannot be wound up without a retro. It is the only long-term memory
  // the system has, and "later" means never once the branch is merged.
  const retro = ctx.db
    .query<{ c: number }, [number]>("SELECT count(*) AS c FROM note WHERE grp_id = ? AND kind = 'retro'")
    .get(grpId)!.c;
  if (retro === 0) {
    ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "state_change",
      body: "no retro yet — the group cannot wind up without one",
    });
    ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      payload: {
        role: "pm",
        rejection:
          "Every slice is accepted, but this group has no retro. Write one now with " +
          "`orch journal add --kind retro`: what got reworked, which assumption was wrong, " +
          "what the next group touching this code needs to know. Max 6 lines.",
      },
    });
    ctx.sched.tick();
    return;
  }

  const gateOut = await runGates({
    db: ctx.db,
    projectId: grp.project_id,
    cwd: grp.worktree ?? process.cwd(),
    dataDir: cfg.dataDir,
    sliceId: 0,
    timeoutMs: cfg.leaseTimeoutMs,
  });
  if (!gateOut.pass) {
    ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "gate_result",
      body: `branch gate failed:\n${gateOut.feedback}`,
    });
    if (branchRework(deps, grpId, "the branch gate", gateOut.feedback)) return;
    ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      payload: { role: "engineer", rejection: gateOut.feedback, rotate: true },
    });
    ctx.sched.tick();
    return;
  }

  // Through, so the count starts again: the next rejection is about the next
  // branch, not this one.
  ctx.db.run("UPDATE grp SET status = 'PR_OPEN', pr_retries = 0 WHERE id = ?", [grpId]);
  // grp_id null on purpose: hiring the Auditor into the group it audits would
  // make it review its own reasoning, and `orch audit` rightly refuses that.
  ctx.sched.enqueue("agent_turn", {
    grp_id: null,
    payload: { role: "auditor", audit: grpId, audit_branch: grp.branch, audit_group: grp.name },
  });
  ctx.sched.tick();
}

/** The Auditor's verdict. Passing means the branch is the boss's to merge. */
export function auditVerdict(deps: ReviewDeps, grpId: number, pass: boolean, note: string): void {
  const { ctx } = deps;
  if (pass) {
    joinQueue(ctx.db, grpId);
    deps.onAuditPass?.(grpId);
    const pos = position(ctx.db, grpId);
    ctx.bus.emit({
      grpId,
      author: "auditor",
      kind: "state_change",
      body:
        pos && pos.position > 1
          ? `audit passed — queued to merge, ${pos.position} of ${pos.total}`
          : "audit passed — ready for you to merge",
      meta: { audit: "pass", ...pos },
    });
    return;
  }
  ctx.db.run("UPDATE grp SET status = 'RUNNING' WHERE id = ?", [grpId]);
  if (branchRework(deps, grpId, "the Auditor", note)) return;
  ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    payload: { role: "pm", rejection: `The Auditor sent the branch back: ${note}`, rotate: true },
  });
  ctx.sched.tick();
}

/**
 * Count a branch-level rejection, and stop when there have been enough.
 *
 * A slice that keeps failing gives up after `gateRetries` and asks the boss. The
 * branch had no counter at all: a red branch gate sent the Engineer round, a
 * rejected audit sent the PM round, and neither loop had an end — the same money
 * spent forever on the same disagreement, with nothing on the boss's screen saying
 * so. PLAN.md's rule is two rounds, then escalate.
 *
 * Returns true when the caller should stop rather than send it round again.
 */
function branchRework(deps: ReviewDeps, grpId: number, from: string, why: string): boolean {
  const { ctx, cfg } = deps;
  const n =
    (ctx.db.query<{ pr_retries: number }, [number]>("SELECT pr_retries FROM grp WHERE id = ?").get(grpId)
      ?.pr_retries ?? 0) + 1;
  ctx.db.run("UPDATE grp SET pr_retries = ? WHERE id = ?", [n, grpId]);
  if (n <= cfg.gateRetries) return false;

  ctx.db.run("UPDATE grp SET status = 'PAUSED', paused_at = unixepoch() * 1000 WHERE id = ?", [grpId]);
  ctx.db.run(
    `INSERT INTO escalation (grp_id, severity, question, chain_state, created_at)
     VALUES (?, 'blocker', ?, 'boss', unixepoch() * 1000)`,
    [grpId, `整个分支被 ${from} 打回 ${n} 次了。多半是验收口径本身有问题，不是代码：\n${why}`],
  );
  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "escalation",
    intent: "ask",
    severity: "blocker",
    body: `branch sent back by ${from} ${n} times — stopping rather than paying for another round`,
  });
  return true;
}

/**
 * Start the next slice that is ready to be worked.
 *
 * Called on approval and after every acceptance, because nothing else would:
 * approving a plan that then sits still is the most confusing possible failure —
 * it looks like the system ignored you.
 */
export function startNextSlice(ctx: Ctx, grpId: number): number | null {
  // A slice sitting on the boss is not occupying the writer. Counting it as busy
  // is correct only when acceptance is what starts the next one.
  const idle = ctx.config?.autoAdvance ? "('pending','accepted','awaiting_boss')" : "('pending','accepted')";
  const busy = ctx.db
    .query<{ c: number }, [number]>(`SELECT count(*) AS c FROM slice WHERE grp_id = ? AND status NOT IN ${idle}`)
    .get(grpId)!.c;
  // One slice at a time per group: the group has one writer, so a second
  // in-flight slice would just queue behind the first anyway — and its review
  // would race the first one's.
  if (busy > 0) return null;

  const next = ctx.db
    .query<{ id: number; seq: number; depends_on: number | null }, [number]>(
      "SELECT id, seq, depends_on FROM slice WHERE grp_id = ? AND status = 'pending' ORDER BY seq LIMIT 1",
    )
    .get(grpId);
  if (!next) return null;

  if (next.depends_on) {
    const dep = ctx.db
      .query<{ status: string }, [number]>("SELECT status FROM slice WHERE id = ?")
      .get(next.depends_on);
    if (dep && dep.status !== "accepted") return null;
  }

  ctx.db.run("UPDATE slice SET status = 'running' WHERE id = ?", [next.id]);
  ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    slice_id: next.id,
    payload: { role: "engineer" },
  });
  ctx.sched.tick();
  return next.id;
}
