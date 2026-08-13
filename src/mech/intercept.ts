import type { Ctx } from "../api.ts";
import { rollbackTo, type GitRunner } from "./worktree.ts";
import { say } from "../lang.ts";

/**
 * Three levels of getting in the way, all of them operations on the job queue.
 *
 *   L1 insert   your message becomes an event; the next turn is told         no cost
 *   L2 barrier  stop dispatching, wait for the in-flight turn to land        no cost
 *   L3 hard     kill the running process                                     loses one turn
 *
 * There is no fourth level. A turn that is mid-flight cannot be steered, only
 * killed, and the UI says PAUSING rather than PAUSED so that stays honest.
 */

export type InterruptMode = "keep" | "rollback";

/** L2. Returns the number of turns still in flight that we are waiting on. */
export function pause(ctx: Ctx, grpId: number): number {
  ctx.db.run(
    "UPDATE grp SET status = 'PAUSING', paused_at = unixepoch() * 1000 WHERE id = ? AND status = 'RUNNING'",
    [grpId],
  );
  const inFlight = runningJobs(ctx, grpId).length;
  ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    body: inFlight ? `pausing — waiting for ${inFlight} turn(s) to land` : "paused",
  });
  if (inFlight === 0) settle(ctx, grpId);
  return inFlight;
}

/**
 * PAUSING becomes PAUSED once nothing is in flight.
 *
 * Called from the watchdog tick rather than from the turn's own completion path,
 * so a crashed turn cannot leave a group stuck in PAUSING forever.
 */
export function settlePausing(ctx: Ctx): number {
  const groups = ctx.db
    .query<{ id: number }, []>("SELECT id FROM grp WHERE status = 'PAUSING'")
    .all();
  let settled = 0;
  for (const g of groups) {
    if (runningJobs(ctx, g.id).length === 0) {
      settle(ctx, g.id);
      settled++;
    }
  }
  return settled;
}

function settle(ctx: Ctx, grpId: number): void {
  // Stamp here, not at every caller: three of them write PAUSING without a
  // timestamp, and every watchdog timer keys off `paused_at` — a group that
  // arrives here with NULL is never parked, never nudged, never unparked.
  ctx.db.run(
    "UPDATE grp SET status = 'PAUSED', paused_at = coalesce(paused_at, unixepoch() * 1000) WHERE id = ? AND status = 'PAUSING'",
    [grpId],
  );
  ctx.bus.emit({ grpId, author: "orchestrator", kind: "state_change", body: say(ctx.config?.language, "group.paused") });
}

export function resume(ctx: Ctx, grpId: number): void {
  ctx.db.run(
    "UPDATE grp SET status = 'RUNNING', paused_at = NULL WHERE id = ? AND status IN ('PAUSED', 'PAUSING')",
    [grpId],
  );
  ctx.bus.emit({ grpId, author: "boss", kind: "state_change", body: say(ctx.config?.language, "group.resumed") });
  ctx.sched.tick();
}

/**
 * L3. Kill whatever this group is running.
 *
 * `keep` leaves the half-finished work in the worktree and tells the next turn
 * it was interrupted — a half-done change usually has value. `rollback` returns
 * to the checkpoint taken before the turn started, which is the only reason that
 * checkpoint exists.
 */
export async function interrupt(
  ctx: Ctx,
  git: GitRunner,
  grpId: number,
  mode: InterruptMode = "keep",
): Promise<{ killed: number; rolledBackTo?: string }> {
  const jobs = runningJobs(ctx, grpId);
  let killed = 0;
  for (const j of jobs) {
    if (j.pid) {
      try {
        process.kill(j.pid, "SIGTERM");
        killed++;
      } catch {
        // Already gone; the job will settle on its own.
      }
    }
    ctx.db.run("UPDATE job SET state = 'cancelled', error = ?, ended_at = unixepoch() * 1000 WHERE id = ?", [
      `interrupted (${mode})`,
      j.id,
    ]);
  }
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE grp_id = ? AND state = 'running'", [grpId]);
  ctx.db.run(
    "UPDATE grp SET status = 'PAUSED', paused_at = unixepoch() * 1000 WHERE id = ? AND status IN ('RUNNING','PAUSING')",
    [grpId],
  );

  let rolledBackTo: string | undefined;
  if (mode === "rollback") {
    const sha = jobs.map((j) => j.checkpoint_sha).find(Boolean) ?? undefined;
    const grp = ctx.db
      .query<{ worktree: string | null; project_id: number }, [number]>(
        "SELECT worktree, project_id FROM grp WHERE id = ?",
      )
      .get(grpId);
    const repo = grp
      ? ctx.db
          .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
          .get(grp.project_id)?.repo_path
      : undefined;
    if (sha && repo && grp?.worktree) {
      const back = await rollbackTo(git, repo, grp.worktree, sha);
      if (back.ok) rolledBackTo = sha;
      else {
        // "Interrupt and roll back" that only interrupted leaves a dirty tree
        // the boss believes is clean, which is the worse of the two states.
        ctx.bus.emit({
          grpId,
          author: "orchestrator",
          kind: "escalation",
          intent: "inform",
          severity: "blocker",
          body: `interrupted, but the rollback to ${sha.slice(0, 8)} failed: ${back.error}. The worktree is dirty.`,
        });
      }
    }
  } else if (killed > 0) {
    // Tell the next turn, or it will be confused by its own leftovers.
    ctx.db.run(
      `INSERT INTO note (grp_id, kind, lang, body, at)
       VALUES (?, 'fact', 'zh', ?, unixepoch() * 1000)`,
      [
        grpId,
        "上一个 turn 被强制打断，worktree 里可能有未完成的改动。先 `git diff` 看一眼再继续，不要假设它是完整的。",
      ],
    );
  }

  ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    body: `interrupted (${mode}), killed ${killed}${rolledBackTo ? `, rolled back to ${rolledBackTo.slice(0, 8)}` : ""}`,
    meta: { mode, killed, rolledBackTo },
  });
  return { killed, rolledBackTo };
}

interface RunningJob {
  id: number;
  pid: number | null;
  checkpoint_sha: string | null;
}

function runningJobs(ctx: Ctx, grpId: number): RunningJob[] {
  return ctx.db
    .query<RunningJob, [number]>(
      "SELECT id, pid, checkpoint_sha FROM job WHERE grp_id = ? AND state = 'running' AND kind = 'agent_turn'",
    )
    .all(grpId);
}

/**
 * Park: the group is waiting on the boss and should stop holding resources.
 *
 * Not an approval step — pure resource reclamation. The worktree and every
 * checkpoint stay exactly where they are, so nothing is lost.
 */
export function park(ctx: Ctx, grpId: number, reason: string): void {
  const cancelled = ctx.sched.cancelPending(grpId, `parked: ${reason}`);
  ctx.db.run(
    "UPDATE agent SET session_id = NULL, session_tokens = 0 WHERE grp_id = ? AND state != 'retired'",
    [grpId],
  );
  ctx.db.run("UPDATE grp SET status = 'PARKED' WHERE id = ?", [grpId]);
  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    body: `parked (${reason}); ${cancelled} queued turn(s) dropped, worktree untouched`,
    meta: { cancelled },
  });
}

/** Wake a parked group. Rebasing on the way back in avoids a stale baseline. */
export async function unpark(ctx: Ctx, git: GitRunner, grpId: number): Promise<void> {
  const grp = ctx.db
    .query<{ worktree: string | null; project_id: number }, [number]>(
      "SELECT worktree, project_id FROM grp WHERE id = ?",
    )
    .get(grpId);
  const repo = grp
    ? ctx.db
        .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
        .get(grp.project_id)?.repo_path
    : undefined;
  if (repo && grp?.worktree) {
    const { rebaseOntoBase } = await import("./worktree.ts");
    const r = await rebaseOntoBase(git, repo, grp.worktree);
    if (r.code !== 0) {
      // A conflicting rebase is the boss's call, not something to paper over.
      ctx.bus.emit({
        grpId,
        author: "orchestrator",
        kind: "escalation",
        intent: "ask",
        severity: "blocker",
        body: `rebase onto the base branch failed while waking up:\n${r.out.slice(0, 500)}`,
      });
      return;
    }
  }
  ctx.db.run("UPDATE grp SET status = 'RUNNING', paused_at = NULL WHERE id = ?", [grpId]);
  ctx.bus.emit({ grpId, author: "boss", kind: "state_change", body: "woken up" });
  ctx.sched.tick();
}
