import type { Ctx } from "../api.ts";
import type { Config } from "../config.ts";
import { runGates, recordGate, gateState } from "./gate.ts";
import { reconcile } from "./reconcile.ts";
import { changedSince, type GitRunner } from "./worktree.ts";
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
  base_sha: string | null;
  retries: number;
}

export function loadSlice(ctx: Ctx, sliceId: number): SliceRow | null {
  return (
    ctx.db
      .query<SliceRow, [number]>(
        "SELECT id, grp_id, seq, title, accept_spec, base_sha, retries FROM slice WHERE id = ?",
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
  if (repo && grp?.worktree && slice.base_sha) {
    changed = await changedSince(git, repo, grp.worktree, slice.base_sha);
  }
  const rec = reconcile({ claims, changedFiles: changed });
  recordGate(ctx.db, sliceId, "reconcile", rec.pass ? "pass" : "fail");
  if (!rec.pass) {
    ctx.bus.emit({
      grpId: slice.grp_id,
      author: "orchestrator",
      kind: "gate_result",
      body: `reconcile failed on S${slice.seq}: ${rec.reason}`,
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
  });
  recordGate(ctx.db, sliceId, "gate", out.pass ? "pass" : "fail");
  ctx.bus.emit({
    grpId: slice.grp_id,
    author: "orchestrator",
    kind: "gate_result",
    body: `gate ${out.pass ? "pass" : "fail"} on S${slice.seq}`,
    meta: { slice_id: sliceId, results: out.results.map((r) => ({ name: r.name, pass: r.pass })) },
  });
  if (!out.pass) return { pass: false, feedback: out.feedback };

  if (rec.unclaimed.length) {
    // Not a defect, but the reviewer should know what else moved.
    ctx.bus.emit({
      grpId: slice.grp_id,
      author: "orchestrator",
      kind: "gate_result",
      body: `also changed, unclaimed: ${rec.unclaimed.slice(0, 10).join(", ")}`,
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
    ctx.db.run(
      `INSERT INTO escalation (grp_id, severity, question, created_at)
       VALUES (?, 'blocker', ?, unixepoch() * 1000)`,
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
      body: `S${slice.seq} failed ${from} ${retries}x — probably the acceptance criteria, not the code`,
      meta: { slice_id: sliceId },
    });
    return;
  }

  ctx.bus.emit({
    grpId: slice.grp_id,
    author: "orchestrator",
    kind: "state_change",
    body: `S${slice.seq} sent back by ${from} (attempt ${retries})`,
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
export function handToBoss(deps: ReviewDeps, sliceId: number): void {
  const { ctx } = deps;
  const slice = loadSlice(ctx, sliceId);
  if (!slice) return;
  recordGate(ctx.db, sliceId, "qa", "pass");
  ctx.db.run("UPDATE slice SET status = 'awaiting_boss' WHERE id = ?", [sliceId]);

  // Retire the group's sessions at the slice boundary. This is the primary
  // rotation trigger, not the token ceiling: a slice is a natural semantic
  // break, so the handoff is cheap, and a session that keeps growing costs more
  // on every remaining turn even at the cached rate.
  ctx.db.run(
    "UPDATE agent SET session_id = NULL, session_tokens = 0 WHERE grp_id = ? AND state != 'retired'",
    [slice.grp_id],
  );
  ctx.bus.emit({
    grpId: slice.grp_id,
    author: "orchestrator",
    kind: "state_change",
    body: `S${slice.seq} "${slice.title}" is ready for you`,
    meta: { slice_id: sliceId, gates: gateState(ctx.db, sliceId) },
  });
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
  });
  if (!gateOut.pass) {
    ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "gate_result",
      body: `branch gate failed:\n${gateOut.feedback}`,
    });
    ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      payload: { role: "engineer", rejection: gateOut.feedback, rotate: true },
    });
    ctx.sched.tick();
    return;
  }

  ctx.db.run("UPDATE grp SET status = 'PR_OPEN' WHERE id = ?", [grpId]);
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
  ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    payload: { role: "pm", rejection: `The Auditor sent the branch back: ${note}`, rotate: true },
  });
  ctx.sched.tick();
}

/**
 * Start the next slice that is ready to be worked.
 *
 * Called on approval and after every acceptance, because nothing else would:
 * approving a plan that then sits still is the most confusing possible failure —
 * it looks like the system ignored you.
 */
export function startNextSlice(ctx: Ctx, grpId: number): number | null {
  const busy = ctx.db
    .query<{ c: number }, [number]>(
      "SELECT count(*) AS c FROM slice WHERE grp_id = ? AND status NOT IN ('pending','accepted')",
    )
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
