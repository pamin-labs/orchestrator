import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import type { Ctx } from "../../mech/ctx.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { agent, grp, job } from "../../platform/persistence/schema.ts";
import { addNote } from "../util/rows.ts";
import { rebaseOntoBase, rollbackTo } from "../git/gitops.ts";
import { sandboxGit } from "../git/checkout.ts";
import { WORK } from "../sandbox/sandbox.ts";
import { abortJob } from "../../platform/process/running-turns.ts";
import { say } from "../../platform/text/lang.ts";
import { GRP_TERMINAL_STATES, type GrpState } from "../../contracts/states.ts";

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
  orm(db)
    .update(grp)
    .set({
      status: h.settled ? "PAUSED" : "PAUSING",
      // Where to resume to. `COALESCE` so the PAUSING → PAUSED step does not
      // overwrite it with `PAUSING`, and so a second hold keeps the original.
      // Reads the row as it was: SQLite evaluates every SET right-hand side
      // against the original values, whatever order the assignments are in.
      paused_from: sql`COALESCE(${grp.paused_from}, ${grp.status})`,
      paused_at: sql`unixepoch() * 1000`,
      pause_reason: h.reason,
      // The three optional assignments, spread rather than pushed onto a list of
      // SQL fragments. Omitting a key leaves the column alone, which is what not
      // pushing the fragment did.
      ...(h.until !== undefined ? { rl_resets_at: h.until } : {}),
      ...(h.on !== undefined ? { blocked_on: h.on } : {}),
      ...(h.leaveQueue ? { merge_seq: null, merge_seq_at: null } : {}),
    })
    .where(
      and(
        eq(grp.id, grpId),
        // A dissolved group is over, and nothing may restart it. `dropGroup` leaves
        // the budget columns alone, so the budget rule kept matching and moved
        // DISSOLVED to PAUSED — which is in `WRITING`, so the dead group's paths
        // stayed claimed and the next group that wanted them never started.
        // Spread: `inArray` takes a ReadonlyArray but `notInArray` does not, and
        // `GRP_TERMINAL_STATES` is an `as const` tuple.
        notInArray(grp.status, [...GRP_TERMINAL_STATES]),
        h.from ? eq(grp.status, h.from) : undefined,
      ),
    )
    .run();
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
  opts: { only?: PauseReason; from?: readonly GrpState[] } = {},
): void {
  // Two shapes, as before: a bulk resume matches on cause alone, a targeted one on
  // the group plus its state, and only then also on cause. `and()` drops the
  // `undefined` arm, and never sees an empty list — the id is always present.
  const where =
    grpId === null
      ? eq(grp.pause_reason, opts.only!)
      : and(
          eq(grp.id, grpId),
          inArray(grp.status, opts.from ?? STOPPED),
          opts.only ? eq(grp.pause_reason, opts.only) : undefined,
        );
  orm(ctx.db)
    .update(grp)
    .set({
      status: sql`COALESCE(${grp.paused_from}, 'RUNNING')`,
      paused_from: null,
      paused_at: null,
      pause_reason: null,
      rl_resets_at: null,
      blocked_on: null,
    })
    .where(where)
    .run();
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
  const groups = orm(ctx.db).select({ id: grp.id }).from(grp).where(eq(grp.status, "PAUSING")).all();
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
  orm(ctx.db)
    .update(grp)
    .set({
      status: "PAUSED",
      paused_at: sql`coalesce(${grp.paused_at}, unixepoch() * 1000)`,
      pause_reason: sql`coalesce(${grp.pause_reason}, 'unknown')`,
    })
    .where(and(eq(grp.id, grpId), eq(grp.status, "PAUSING")))
    .run();
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
    orm(ctx.db)
      .update(job)
      .set({ state: "cancelled", error: `interrupted (${mode})`, ended_at: sql`unixepoch() * 1000` })
      .where(eq(job.id, j.id))
      .run();
  }
  orm(ctx.db)
    .update(agent)
    .set({ state: "idle" })
    .where(and(eq(agent.grp_id, grpId), eq(agent.state, "running")))
    .run();
  // Not `hold`: an interrupt keeps whatever cause already stopped it — the boss
  // interrupting a group that was already waiting on an answer is still waiting
  // on that answer.
  orm(ctx.db)
    .update(grp)
    .set({
      status: "PAUSED",
      paused_at: sql`unixepoch() * 1000`,
      pause_reason: sql`coalesce(${grp.pause_reason}, 'boss')`,
    })
    .where(and(eq(grp.id, grpId), inArray(grp.status, ["RUNNING", "PAUSING"])))
    .run();

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
  return orm(db)
    .select({ id: job.id, pid: job.pid, checkpoint_sha: job.checkpoint_sha })
    .from(job)
    .where(and(eq(job.grp_id, grpId), eq(job.state, "running"), eq(job.kind, "agent_turn")))
    .all();
}

/**
 * Park: the group is waiting on the boss and should stop holding resources.
 *
 * Not an approval step — pure resource reclamation. The worktree and every
 * checkpoint stay exactly where they are, so nothing is lost.
 */
export function park(ctx: Ctx, grpId: number, reason: string): void {
  const cancelled = ctx.sched.cancelPending(grpId, `parked: ${reason}`);
  orm(ctx.db)
    .update(agent)
    .set({ session_id: null, session_tokens: 0 })
    .where(and(eq(agent.grp_id, grpId), ne(agent.state, "retired")))
    .run();
  orm(ctx.db).update(grp).set({ status: "PARKED" }).where(eq(grp.id, grpId)).run();
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
