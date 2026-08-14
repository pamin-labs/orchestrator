import type { Ctx } from "../api.ts";
import { settlePausing } from "./intercept.ts";
import { joinQueue } from "./mergequeue.ts";
import { reopenTasks, startNextSlice } from "./review.ts";
import {
  ESCALATION_STATES,
  GRP_STATES,
  JOB_STATES,
  SLICE_STATES,
  type EscalationState,
  type GrpState,
  type JobState,
  type SliceState,
} from "./states.ts";

/**
 * One row per state, and the row has to say who pushes it.
 *
 * Every rule in `watchdog.ts` was bought with an incident: six groups on a stale
 * base, six behind a bad `--settings` path, a group whose every slice was accepted
 * and which then had nobody left to hand the branch to. They have one shape —
 * a transition that exactly one code path fires, and when that path does not fire,
 * the state is final and *looks healthy*: RUNNING, an agent listed, no error
 * anywhere the boss looks.
 *
 * Writing them as a table derived from the state machine turns "we found another
 * one" into "the table has an empty cell". `test/invariants.test.ts` asserts every
 * state in `states.ts` has a row, so adding a state fails the build until someone
 * fills it in. That is the whole point of this file; the repairs themselves are
 * two lines each.
 *
 * What does NOT belong here: the watchdog's *detectors* — turn timeout, no
 * progress, circling, budget, env_suspect. Those answer "is this healthy", which
 * is a different question from "is anybody driving this". Keeping them apart is
 * what stops this table from becoming a second dumping ground.
 */

export interface Invariant<S extends string> {
  state: S;
  /** What has to be true, in one line, for a reader deciding whether it still holds. */
  must: string;
  /**
   * Who pushes it out of this state. `null` means nothing has to: the state is
   * terminal, or a human is deliberately being waited on and a nudge covers it.
   * The string is prose, and it is checked by nothing — but an empty one is the
   * question this table exists to force.
   */
  driver: string | null;
  /** Idempotent repair, run every tick. Absent when `driver` needs no help. */
  repair?: (ctx: Ctx) => void;
}

const rows = <S extends string>(...r: Invariant<S>[]) => r;

export const GRP_INVARIANTS = rows<GrpState>(
  {
    state: "PLANNING",
    must: "a dispatcher turn is queued or running until a DRAFT card exists",
    driver: "watchdog rule 8: a live group with an empty queue gets its last turn back",
  },
  {
    state: "DRAFT",
    must: "the card is waiting on the boss, and the boss is reminded",
    driver: "boss approval; sweepApproved retries a group held by a boundary, waiting_card nudges",
  },
  {
    state: "RUNNING",
    must: "exactly one slice is in flight, or the branch is on its way to a PR",
    driver: "the slice pipeline; watchdog rule 8 for an empty queue",
    repair: (ctx) => {
      // A slice left `pending` with nothing in flight. startNextSlice is only ever
      // called at the end of something else — a group starting, autoAdvance, an
      // acceptance — so when none of those fires again nobody starts it, and
      // RUNNING with an empty queue is indistinguishable from working.
      for (const g of ctx.db
        .query<{ id: number }, []>(
          `SELECT g.id FROM grp g
           WHERE g.status = 'RUNNING'
             AND EXISTS (SELECT 1 FROM slice WHERE grp_id = g.id AND status = 'pending')
             AND NOT EXISTS (SELECT 1 FROM slice WHERE grp_id = g.id AND status NOT IN ('pending','accepted'))
             AND NOT EXISTS (SELECT 1 FROM job WHERE grp_id = g.id AND state IN ('pending','running'))`,
        )
        .all()) {
        startNextSlice(ctx, g.id);
      }

      // Every slice accepted and no PR. The branch review is enqueued from exactly
      // two places — the last acceptance, and writing a retro — and neither fires
      // again after the Auditor sends the branch back. Not while the boss is being
      // asked: pr_retries is spent by then and shipping would walk past them.
      for (const g of ctx.db
        .query<{ id: number }, []>(
          `SELECT g.id FROM grp g
           WHERE g.status = 'RUNNING' AND g.pr_number IS NULL
             AND EXISTS (SELECT 1 FROM slice WHERE grp_id = g.id)
             AND NOT EXISTS (SELECT 1 FROM slice WHERE grp_id = g.id AND status != 'accepted')
             AND NOT EXISTS (SELECT 1 FROM job WHERE grp_id = g.id AND state IN ('pending','running'))
             AND NOT EXISTS (SELECT 1 FROM escalation
                             WHERE grp_id = g.id AND answer IS NULL AND chain_state = 'boss')`,
        )
        .all()) {
        ctx.sched.enqueue("reconcile", { grp_id: g.id, priority: 5 });
      }
    },
  },
  {
    state: "PAUSING",
    must: "it becomes PAUSED as soon as nothing is in flight",
    driver: "settlePausing, from the watchdog tick rather than the turn's own exit path",
    repair: (ctx) => void settlePausing(ctx),
  },
  {
    state: "PAUSED",
    must: "paused_at is set, or every timer keyed on it is blind to this group",
    driver: "the boss answering, resume, or the park timer",
    repair: (ctx) => {
      // Three callers write PAUSING without a timestamp; settle() stamps it now,
      // but a row that predates that fix would stay invisible forever.
      ctx.db.run("UPDATE grp SET paused_at = unixepoch() * 1000 WHERE status = 'PAUSED' AND paused_at IS NULL");
    },
  },
  {
    state: "PARKED",
    must: "the boss can still find it, and it is holding no slot",
    driver: "boss wakes it; waiting_parked nudges after 4h",
  },
  {
    state: "PR_OPEN",
    must: "it has a number, a place in the merge queue, and something reading GitHub",
    driver: "pollPrs — merged winds it up, closed pauses it, reopened puts it back",
    repair: (ctx) => {
      // waiting_merge reads merge_seq_at, so a null one is invisible to it: finished
      // work with no place in the order and nothing looking at it.
      for (const g of ctx.db
        .query<{ id: number }, []>(
          "SELECT id FROM grp WHERE status = 'PR_OPEN' AND pr_number IS NOT NULL AND merge_seq IS NULL",
        )
        .all()) {
        joinQueue(ctx.db, g.id);
      }
    },
  },
  {
    state: "DISSOLVED",
    must: "nothing is queued for it, its paths are free, and its worktree is gone",
    // Terminal, but not inert: a mail landing after the drop enqueues a turn that
    // no dissolved status can dispatch, and it sits pending in every count. The
    // worktree is the other half — nothing removed one for the first six months,
    // so twelve dead checkouts sat on disk holding their branches.
    driver: "watchdog rule 9 cancels what is still queued; rule 17 removes the worktree; ownership frees the paths",
  },
);

export const SLICE_INVARIANTS = rows<SliceState>(
  {
    state: "pending",
    must: "it starts once the slice before it is accepted",
    driver: "startNextSlice, plus the RUNNING repair above when nothing fires it",
  },
  {
    state: "running",
    must: "an engineer turn is queued or running, and the writer has a card it can claim",
    driver: "watchdog rule 8",
    repair: (ctx) => {
      // A retry that left every task `done`. The turn keeps being dispatched and
      // keeps ending the same way — an empty task list, a claim refused, a question
      // to the boss — because there is nothing in the group the writer may touch.
      // Six groups at once, and every one of them read as RUNNING with an engineer
      // on it. sendBack reopens them now; this catches the rows it already stranded,
      // and any other path that ever flips a slice back without looking at its cards.
      for (const s of ctx.db
        .query<{ id: number }, []>(
          `SELECT s.id FROM slice s
           WHERE s.status = 'running'
             AND EXISTS (SELECT 1 FROM task t WHERE t.slice_id = s.id)
             AND NOT EXISTS (SELECT 1 FROM task t WHERE t.slice_id = s.id AND t.status != 'done')`,
        )
        .all()) {
        reopenTasks(ctx, s.id);
      }

      // The other half of the same deadlock: the card is claimed, but by an agent
      // that no longer exists to close it. `task done` compares against the row id,
      // so a rehired writer is a stranger to its own group's work.
      ctx.db.run(
        `UPDATE task SET owner_agent_id = NULL
         WHERE status != 'done'
           AND owner_agent_id IN (SELECT id FROM agent WHERE state = 'retired')`,
      );
    },
  },
  { state: "self_review", must: "the engineer's own pass is recorded before reconcile", driver: "the same turn" },
  { state: "gate", must: "a gate job is queued or running", driver: "runReview; watchdog rule 8 if the queue empties" },
  { state: "qa", must: "a qa turn is queued or running", driver: "handToQa; watchdog rule 8" },
  {
    state: "awaiting_boss",
    must: "the boss is reminded, and nothing else moves the slice",
    driver: "boss accepts or rejects; waiting_slice nudges after 4h",
  },
  { state: "accepted", must: "the next slice starts, or the branch goes to review", driver: null },
  { state: "rejected", must: "an engineer turn carries the rejection back", driver: "postSliceDecision; watchdog rule 8" },
);

export const JOB_INVARIANTS = rows<JobState>(
  { state: "pending", must: "it is dispatched once its group and pool have room", driver: "Scheduler.tick" },
  {
    state: "running",
    must: "it ends, or something ends it",
    driver: "the executor; watchdog rule 1 kills a turn past its wall clock, and reclaimOrphans frees one whose process died with the server",
  },
  { state: "done", must: "whatever it was doing arranged what comes next", driver: null },
  {
    state: "failed",
    must: "it is retried once, and then it is the boss's problem",
    driver: "watchdog rule 8 requeues it once, then files a blocker",
  },
  { state: "cancelled", must: "nothing is waiting on it", driver: null },
);

export const ESCALATION_INVARIANTS = rows<EscalationState>(
  {
    state: "pm",
    must: "the role it is with has a turn queued to answer it",
    driver: "route() enqueues the turn; answering or abstaining moves it on",
  },
  { state: "architect", must: "same, one level up", driver: "route(); abstain climbs to the CoS" },
  { state: "cos", must: "same, one level up", driver: "route(); abstain climbs to the boss" },
  {
    state: "boss",
    must: "it is in the queue and the boss is reminded, or the work went past it",
    driver:
      "the boss answers; batchForBoss notifies and waiting_* nudges after 4h; " +
      "watchdog rule 16 revokes it once the group reaches PR_OPEN or DISSOLVED, " +
      "where there is no longer anyone to unblock",
  },
  { state: "answered", must: "the caller is unblocked and the group resumed", driver: null },
  { state: "revoked", must: "the boss took it back and is answering it themselves", driver: null },
);

/**
 * Run every repair, every tick. Ordering does not matter: each one is a SELECT of
 * rows that are wrong and a write that makes them right, so running them twice is
 * the same as running them once.
 */
export function runInvariants(ctx: Ctx): void {
  for (const i of [...GRP_INVARIANTS, ...SLICE_INVARIANTS]) i.repair?.(ctx);
}

/** States with no row. The test fails on a non-empty result; nothing else calls it. */
export function uncovered(): { grp: string[]; slice: string[]; job: string[]; escalation: string[] } {
  const has = (rs: { state: string }[], s: string) => rs.some((r) => r.state === s);
  return {
    grp: GRP_STATES.filter((s) => !has(GRP_INVARIANTS, s)),
    slice: SLICE_STATES.filter((s) => !has(SLICE_INVARIANTS, s)),
    job: JOB_STATES.filter((s) => !has(JOB_INVARIANTS, s)),
    escalation: ESCALATION_STATES.filter((s) => !has(ESCALATION_INVARIANTS, s)),
  };
}
