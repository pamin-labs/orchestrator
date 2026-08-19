import type { DB } from "../../platform/persistence/database.ts";
import type { Ctx } from "../../mech/ctx.ts";
import { addNote } from "../util/rows.ts";
import { rebaseOntoBase, rollbackTo } from "../git/gitops.ts";
import { sandboxGit } from "../git/checkout.ts";
import { WORK } from "../sandbox/sandbox.ts";
import { abortJob } from "../../platform/process/running-turns.ts";
import { say } from "../../platform/text/lang.ts";
import { GRP_TERMINAL_STATES } from "../../contracts/states.ts";

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

/**
 * Why a group stopped, so that starting it again can be about that reason.
 *
 * `paused_at` recorded when and never why, and eight sites wrote it for eight
 * causes. The bulk resume in `credentialChanged` therefore matched every PAUSED row:
 * a boss who paused by hand and then signed into GitHub watched the group restart.
 *
 * `auth` carries its runtime: a claude token going bad is not a reason to restart a
 * group that stopped on codex.
 */
export type PauseReason =
  | "boss"
  | "budget"
  | "blocked"
  | "ratelimit"
  | "escalation"
  | "merge"
  | "unknown"
  | `auth:${string}`;

/**
 * Why a group stopped, and the columns that reason owns.
 *
 * Thirteen sites wrote this UPDATE by hand and each had to remember three things:
 * the status, the timestamp every watchdog timer keys on, and the reason every
 * scoped resume keys on. Three callers wrote PAUSING with no `paused_at` and their
 * groups became invisible to the park timer, the nudge and the unpark at once, while
 * looking perfectly healthy. A field you have to remember is a field somebody will
 * not.
 */
/**
 * No bus emit: every caller says its own sentence, in its own words, and a generic
 * "paused" underneath each of them would be the same event twice.
 */
export interface Hold {
  reason: PauseReason;
  /** PAUSED straight away rather than PAUSING while an in-flight turn lands. */
  settled?: boolean;
  /** Only move a group currently in this state. Omitted, move it from any. */
  from?: "RUNNING" | "PR_OPEN";
  /** `ratelimit`: unix ms the quota window reopens. */
  until?: number;
  /** `blocked`: the group this one is waiting on. */
  on?: number;
  /** `merge`: it is also leaving the merge queue. */
  leaveQueue?: boolean;
}

export function hold(db: DB, grpId: number, h: Hold): void {
  const sets = [
    `status = '${h.settled ? "PAUSED" : "PAUSING"}'`,
    // Where to resume to. `COALESCE` so the PAUSING → PAUSED step does not
    // overwrite it with `PAUSING`, and so a second hold keeps the original.
    "paused_from = COALESCE(paused_from, status)",
    "paused_at = unixepoch() * 1000",
    "pause_reason = ?",
  ];
  const args: (string | number)[] = [h.reason];
  if (h.until !== undefined) {
    sets.push("rl_resets_at = ?");
    args.push(h.until);
  }
  if (h.on !== undefined) {
    sets.push("blocked_on = ?");
    args.push(h.on);
  }
  if (h.leaveQueue) sets.push("merge_seq = NULL, merge_seq_at = NULL");
  args.push(grpId);
  // A dissolved group is over, and nothing may restart it. `dropGroup` leaves the
  // budget columns alone, so the budget rule kept matching and moved DISSOLVED to
  // PAUSED — which is in `WRITING`, so the dead group's paths stayed claimed and
  // the next group that wanted them never started.
  const terminal = GRP_TERMINAL_STATES.map((state) => `'${state}'`).join(", ");
  db.run(
    `UPDATE grp SET ${sets.join(", ")} WHERE id = ? AND status NOT IN (${terminal})${
      h.from ? ` AND status = '${h.from}'` : ""
    }`,
    args,
  );
}

/**
 * Start it again, and clear everything the stop was about.
 *
 * `rl_resets_at` and `blocked_on` are always cleared, not sometimes: two of the four
 * resume sites cleared one and two cleared neither, and a RUNNING group carrying
 * either says two things at once.
 *
 * `only` scopes it to one cause. Without it the bulk resume matched every PAUSED
 * row, so signing into GitHub restarted a group paused by hand.
 */
/**
 * `from` defaults to the two paused states, and PARKED is deliberately not among
 * them: a parked group has had its session dropped and its base may have moved
 * under it, so it comes back through `unpark`, which rebases first. Answering its
 * question must not skip that.
 */
const STOPPED = ["PAUSED", "PAUSING"] as const;

export function release(
  ctx: Ctx,
  grpId: number | null,
  opts: { only?: PauseReason; from?: readonly string[] } = {},
): void {
  const states = (opts.from ?? STOPPED).map((x) => `'${x}'`).join(", ");
  const where =
    grpId === null ? "pause_reason = ?" : `id = ? AND status IN (${states})${opts.only ? " AND pause_reason = ?" : ""}`;
  ctx.db.run(
    `UPDATE grp SET status = COALESCE(paused_from, 'RUNNING'), paused_from = NULL,
       paused_at = NULL, pause_reason = NULL, rl_resets_at = NULL, blocked_on = NULL
     WHERE ${where}`,
    grpId === null ? [opts.only!] : opts.only ? [grpId, opts.only] : [grpId],
  );
}

/** L2. Returns the number of turns still in flight that we are waiting on. */
export function pause(ctx: Ctx, grpId: number, reason: PauseReason = "boss"): number {
  hold(ctx.db, grpId, { reason, from: "RUNNING" });
  const inFlight = runningJobs(ctx.db, grpId).length;
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
  const groups = ctx.db.query<{ id: number }, []>("SELECT id FROM grp WHERE status = 'PAUSING'").all();
  let settled = 0;
  for (const g of groups) {
    if (runningJobs(ctx.db, g.id).length === 0) {
      settle(ctx, g.id);
      settled++;
    }
  }
  return settled;
}

function settle(ctx: Ctx, grpId: number): void {
  // Stamp here, not at every caller: three of them write PAUSING without a
  // timestamp, and every watchdog timer keys off `paused_at` — a group that
  // arrives here with NULL is never parked, never nudged, never unparked. Same
  // argument for the reason: a PAUSED row with no reason is one no resume can
  // ever be about, so it gets the only honest value there is.
  ctx.db.run(
    `UPDATE grp SET status = 'PAUSED', paused_at = coalesce(paused_at, unixepoch() * 1000),
       pause_reason = coalesce(pause_reason, 'unknown')
     WHERE id = ? AND status = 'PAUSING'`,
    [grpId],
  );
  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config.language, "group.paused"),
  });
}

export function resume(ctx: Ctx, grpId: number): void {
  release(ctx, grpId);
  ctx.bus.emit({ grpId, author: "boss", kind: "state_change", body: say(ctx.config.language, "group.resumed") });
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
  grpId: number,
  mode: InterruptMode = "keep",
): Promise<{ killed: number; rolledBackTo?: string }> {
  const jobs = runningJobs(ctx.db, grpId);
  let killed = 0;
  for (const j of jobs) {
    // A turn runs in the group's sandbox, not on this machine, so there is no
    // pid to signal — stopping it means abandoning the stream we are reading.
    if (abortJob(j.id)) killed++;
    ctx.db.run("UPDATE job SET state = 'cancelled', error = ?, ended_at = unixepoch() * 1000 WHERE id = ?", [
      `interrupted (${mode})`,
      j.id,
    ]);
  }
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE grp_id = ? AND state = 'running'", [grpId]);
  // Not `hold`: an interrupt keeps whatever cause already stopped it — the boss
  // interrupting a group that was already waiting on an answer is still waiting
  // on that answer.
  ctx.db.run(
    "UPDATE grp SET status = 'PAUSED', paused_at = unixepoch() * 1000, pause_reason = coalesce(pause_reason, 'boss') WHERE id = ? AND status IN ('RUNNING','PAUSING')",
    [grpId],
  );

  let rolledBackTo: string | undefined;
  if (mode === "rollback") {
    const sha = jobs.map((j) => j.checkpoint_sha).find(Boolean) ?? undefined;
    // The group's own checkout, where the checkpoint was taken. This used to be
    // gated on `grp.worktree`, a column nothing writes, so "interrupt and roll
    // back" only ever interrupted.
    if (sha) {
      const back = await rollbackTo(sandboxGit(ctx, { grp: grpId }), WORK, sha);
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
          body: `interrupted, but the rollback to ${sha.slice(0, 8)} failed: ${back.error}. The checkout is dirty.`,
        });
      }
    }
  } else if (killed > 0) {
    // Tell the next turn, or it will be confused by its own leftovers.
    addNote(ctx.db, {
      grpId,
      kind: "fact",
      lang: "zh",
      body: "上一个 turn 被强制打断，worktree 里可能有未完成的改动。先 `git diff` 看一眼再继续，不要假设它是完整的。",
    });
  }

  ctx.bus.emit({
    grpId,
    author: "boss",
    kind: "state_change",
    body: `interrupted (${mode}), killed ${killed}${rolledBackTo ? `, rolled back to ${rolledBackTo.slice(0, 8)}` : ""}`,
    meta: { mode, killed, ...(rolledBackTo ? { rolledBackTo } : {}) },
  });
  return { killed, ...(rolledBackTo ? { rolledBackTo } : {}) };
}

interface RunningJob {
  id: number;
  pid: number | null;
  checkpoint_sha: string | null;
}

function runningJobs(db: DB, grpId: number): RunningJob[] {
  return db
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
  ctx.db.run("UPDATE agent SET session_id = NULL, session_tokens = 0 WHERE grp_id = ? AND state != 'retired'", [grpId]);
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
export async function unpark(ctx: Ctx, grpId: number): Promise<void> {
  const r = await rebaseOntoBase(sandboxGit(ctx, { grp: grpId }), WORK);
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
  // From PARKED, the one state `release` will not leave on its own — the rebase
  // above is the reason. Anything that wakes a parked group without it starts a
  // turn on a base that moved while the group was asleep.
  release(ctx, grpId, { from: ["PARKED"] });
  ctx.bus.emit({ grpId, author: "boss", kind: "state_change", body: "woken up" });
  ctx.sched.tick();
}
