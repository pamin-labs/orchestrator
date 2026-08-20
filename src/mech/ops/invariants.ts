import type { Ctx } from "../../mech/ctx.ts";
import { settlePausing } from "../flow/intercept.ts";
import { joinQueue } from "../flow/mergequeue.ts";
import { reopenTasks, startNextSlice } from "../flow/review.ts";
import { clearEscalation } from "../git/github.ts";
import { parseRepo } from "../../contracts/repository.ts";
import { repoHeld } from "../git/repository.ts";
import { and, eq, exists, inArray, isNotNull, isNull, ne, notExists, notInArray, type SQL } from "drizzle-orm";
import { agent, escalation, grp, job, project, slice, task } from "../../platform/persistence/schema.ts";
import {
  ESCALATION_STATES,
  GRP_STATES,
  JOB_STATES,
  LEASE_STATES,
  SERVER_STATES,
  SLICE_STATES,
  TASK_STATES,
  PROJECT_STATES,
  UTIL_STATES,
  type EscalationState,
  type GrpState,
  type JobState,
  type LeaseState,
  type ProjectState,
  type ServerHealthState,
  type SliceState,
  type TaskState,
  type UtilState,
  ACTIVE_JOB_STATES,
} from "../../contracts/states.ts";

/**
 * One row per state, and the row has to say who pushes it.
 *
 * Every rule in `watchdog.ts` was bought with an incident, and they share one
 * shape: a transition exactly one code path fires, which when it does not fire
 * leaves the state final and *looking healthy* — RUNNING, an agent listed, no
 * error anywhere the boss looks.
 */
/**
 * As a table derived from the state machine, "we found another one" becomes "the
 * table has an empty cell": `invariants.test.ts` asserts every state in
 * `contracts/states.ts` has a row, so adding a state fails the build until someone
 * fills it in. The repairs themselves are two lines each.
 *
 * What does **not** belong here: the watchdog's *detectors* — timeout, no
 * progress, circling, budget, env_suspect. Those answer "is this healthy", which
 * is a different question from "is anybody driving this".
 */

interface Invariant<S extends string> {
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
  /** Idempotent repair, awaited every tick. Absent when `driver` needs no help. */
  repair?: (ctx: Ctx) => Promise<void>;
}

const rows = <S extends string>(...r: Invariant<S>[]) => r;

/**
 * The two correlated subqueries these repairs keep asking for.
 *
 * Both name `grp.id` from the enclosing query, which is what makes them EXISTS
 * tests rather than lists: "does this row have a pending slice", "is anything
 * still queued for it". `ACTIVE_JOB_STATES` goes in as an `inArray` — the
 * `json_each(?)` binding it needed under SQLite has no equivalent here and no
 * purpose either.
 */
const sliceOf = (ctx: Ctx, ...extra: (SQL | undefined)[]) =>
  ctx.db
    .select({ id: slice.id })
    .from(slice)
    .where(and(eq(slice.grp_id, grp.id), ...extra));

const activeJobOf = (ctx: Ctx, ...extra: (SQL | undefined)[]) =>
  ctx.db
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.grp_id, grp.id), inArray(job.state, [...ACTIVE_JOB_STATES]), ...extra));

const GRP_INVARIANTS = rows<GrpState>(
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
    repair: async (ctx) => {
      // A slice left `pending` with nothing in flight. startNextSlice is only ever
      // called at the end of something else — a group starting, autoAdvance, an
      // acceptance — so when none of those fires again nobody starts it, and
      // RUNNING with an empty queue is indistinguishable from working.
      for (const g of await ctx.db
        .select({ id: grp.id })
        .from(grp)
        .where(
          and(
            eq(grp.status, "RUNNING"),
            exists(sliceOf(ctx, eq(slice.status, "pending"))),
            notExists(sliceOf(ctx, notInArray(slice.status, ["pending", "accepted"]))),
            notExists(activeJobOf(ctx)),
          ),
        )) {
        await startNextSlice(ctx, g.id);
      }

      // Every slice accepted and no PR. The branch review is enqueued from exactly
      // two places — the last acceptance, and writing a retro — and neither fires
      // again after the Auditor sends the branch back. Not while the boss is being
      // asked: pr_retries is spent by then and shipping would walk past them.
      for (const g of await ctx.db
        .select({ id: grp.id })
        .from(grp)
        .where(
          and(
            eq(grp.status, "RUNNING"),
            isNull(grp.pr_number),
            exists(sliceOf(ctx)),
            notExists(sliceOf(ctx, ne(slice.status, "accepted"))),
            notExists(activeJobOf(ctx)),
            notExists(
              ctx.db
                .select({ id: escalation.id })
                .from(escalation)
                .where(
                  and(eq(escalation.grp_id, grp.id), isNull(escalation.answer), eq(escalation.chain_state, "boss")),
                ),
            ),
          ),
        )) {
        await ctx.sched.enqueue("reconcile", { grp_id: g.id, priority: 5 });
      }
    },
  },
  {
    state: "PAUSING",
    must: "it becomes PAUSED as soon as nothing is in flight",
    driver: "settlePausing, from the watchdog tick rather than the turn's own exit path",
    repair: async (ctx) => {
      await settlePausing(ctx);
    },
  },
  {
    state: "PAUSED",
    must: "paused_at and pause_reason are set, or no timer and no resume is about this group",
    driver: "the boss answering, resume, or the park timer",
    repair: async (ctx) => {
      // Three callers write PAUSING without a timestamp; settle() stamps it now,
      // but a row that predates that fix would stay invisible forever. A missing
      // reason is the same failure one door over: `credentialChanged` resumes by
      // reason, so a row without one is a row nothing will ever start again.
      // Two statements rather than one with `coalesce`: each fills only the column
      // it names, which is what the coalesce was for.
      await ctx.db
        .update(grp)
        .set({ paused_at: Date.now() })
        .where(and(eq(grp.status, "PAUSED"), isNull(grp.paused_at)));
      await ctx.db
        .update(grp)
        .set({ pause_reason: "unknown" })
        .where(and(eq(grp.status, "PAUSED"), isNull(grp.pause_reason)));
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
    driver:
      "the Scribe filing `orch pr` publishes it; then pollPrs — merged winds it up, closed pauses it, reopened puts it back",
    repair: async (ctx) => {
      // Audited, queued, and no PR: the Scribe's turn died, or ended without
      // filing a message. Its own liveness is the scheduler's — a job that fails
      // is retried — so this only fires once nothing is left to run for the
      // group, and then publishes with what the record can say by itself.
      //
      // `merge_seq IS NOT NULL` is what makes this safe: a group is PR_OPEN from
      // the moment the branch gate passes, which is *before* the audit, and the
      // Auditor's turn is enqueued with a null `grp_id` so it does not show up in
      // the query below. A place in the merge queue is only handed out by a
      // passed audit.
      for (const g of await ctx.db
        .select({ id: grp.id })
        .from(grp)
        .where(
          and(
            eq(grp.status, "PR_OPEN"),
            isNull(grp.pr_number),
            isNotNull(grp.merge_seq),
            notExists(activeJobOf(ctx, eq(job.kind, "agent_turn"))),
          ),
        )) {
        ctx.publishBranch?.(g.id);
      }
      // waiting_merge reads merge_seq_at, so a null one is invisible to it: finished
      // work with no place in the order and nothing looking at it.
      for (const g of await ctx.db
        .select({ id: grp.id })
        .from(grp)
        .where(and(eq(grp.status, "PR_OPEN"), isNotNull(grp.pr_number), isNull(grp.merge_seq)))) {
        await joinQueue(ctx.db, g.id);
      }
    },
  },
  {
    state: "DISSOLVED",
    must: "nothing is queued for it, its paths are free, and its sandbox is gone",
    // Terminal, but not inert: a mail landing after the drop enqueues a turn that
    // no dissolved status can dispatch, and it sits pending in every count. The
    // sandbox is the other half — two containers per group, held until a TTL a
    // day away, against every group that comes next.
    driver: "watchdog rule 9 cancels what is still queued; rule 17 kills the sandbox; ownership frees the paths",
  },
);

const SLICE_INVARIANTS = rows<SliceState>(
  {
    state: "pending",
    must: "it starts once the slice before it is accepted",
    driver: "startNextSlice, plus the RUNNING repair above when nothing fires it",
  },
  {
    state: "running",
    must: "an engineer turn is queued or running, and the writer has a card it can claim",
    driver: "watchdog rule 8",
    repair: async (ctx) => {
      // A retry that left every task `done`. The turn keeps being dispatched and
      // keeps ending the same way — an empty task list, a claim refused, a question
      // to the boss — because there is nothing in the group the writer may touch.
      // Six groups at once, and every one of them read as RUNNING with an engineer
      // on it. sendBack reopens them now; this catches the rows it already stranded,
      // and any other path that ever flips a slice back without looking at its cards.
      const taskOf = (...extra: (SQL | undefined)[]) =>
        ctx.db
          .select({ id: task.id })
          .from(task)
          .where(and(eq(task.slice_id, slice.id), ...extra));
      for (const s of await ctx.db
        .select({ id: slice.id })
        .from(slice)
        .where(and(eq(slice.status, "running"), exists(taskOf()), notExists(taskOf(ne(task.status, "done")))))) {
        await reopenTasks(ctx.db, s.id);
      }

      // The other half of the same deadlock: the card is claimed, but by an agent
      // that no longer exists to close it. `task done` compares against the row id,
      // so a rehired writer is a stranger to its own group's work.
      await ctx.db
        .update(task)
        .set({ owner_agent_id: null })
        .where(
          and(
            ne(task.status, "done"),
            inArray(task.owner_agent_id, ctx.db.select({ id: agent.id }).from(agent).where(eq(agent.state, "retired"))),
          ),
        );
    },
  },
  { state: "gate", must: "a gate job is queued or running", driver: "runReview; watchdog rule 8 if the queue empties" },
  { state: "qa", must: "a qa turn is queued or running", driver: "handToQa; watchdog rule 8" },
  {
    state: "awaiting_boss",
    must: "the boss is reminded, and nothing else moves the slice",
    driver: "boss accepts or rejects; waiting_slice nudges after 4h",
  },
  { state: "accepted", must: "the next slice starts, or the branch goes to review", driver: null },
  {
    state: "rejected",
    must: "an engineer turn carries the rejection back",
    driver: "postSliceDecision; watchdog rule 8",
  },
);

const TASK_INVARIANTS = rows<TaskState>(
  {
    state: "pending",
    must: "the active writer can claim or complete it while its slice is running",
    driver: "the writer through orch task claim or orch task done; watchdog rule 8 keeps that turn moving",
  },
  {
    state: "in_progress",
    must: "its active owner completes it, or a replacement writer can reclaim it",
    driver: "orch task done; the SLICE.running repair clears ownership left by a retired agent",
  },
  { state: "done", must: "it stays closed until a rejected slice explicitly reopens its tasks", driver: null },
);

const JOB_INVARIANTS = rows<JobState>(
  { state: "pending", must: "it is dispatched once its group and pool have room", driver: "Scheduler.tick" },
  {
    state: "running",
    must: "it ends, or something ends it",
    driver:
      "the executor; watchdog rule 1 kills a turn past its wall clock, and reclaimOrphans frees one whose process died with the server",
  },
  { state: "done", must: "whatever it was doing arranged what comes next", driver: null },
  {
    state: "failed",
    must: "it is retried once, and then it is the boss's problem",
    driver: "watchdog rule 8 requeues it once, then files a blocker",
  },
  { state: "cancelled", must: "nothing is waiting on it", driver: null },
);

/**
 * The utility container.
 *
 * The only container bound for GitHub writes, so when it is absent every branch
 * stops reaching the remote — and that has the shape this table exists for: groups
 * keep working, keep committing, keep looking healthy.
 *
 * Survivable because its absence is cheap and self-correcting (`ensureSandbox`
 * builds one on the next call) and both ways it fails to return are reported.
 */
const UTIL_INVARIANTS = rows<UtilState>(
  {
    state: "down",
    must: "the next push builds one, and if it cannot, something says why",
    driver:
      "ensureSandbox builds it on demand; the sandbox hold reports a server that cannot open containers, " +
      "and pushBranch's caller reports a push that had nowhere to go",
  },
  {
    state: "up",
    must: "its TTL is renewed while this server lives, and it is rebuilt when the GitHub credential changes",
    driver:
      "watchdog rule 18 renews it with the group and project containers; rule 17b kills it when a credential " +
      "is newer than its sidecar, and the next push rebuilds it",
  },
);

/**
 * A project's GitHub reachability.
 *
 * The hold exists because an expired token makes every group fail at once, each
 * reporting a different error, and retrying cannot help. It then has the deadlock
 * this table is for: a held project runs no turns, so it makes no GitHub calls, so
 * nothing would ever clear it — the clock is what breaks that.
 *
 * The repair below is the other half: the hold is in memory, the question is not.
 */
const PROJECT_INVARIANTS = rows<ProjectState>(
  { state: "reachable", must: "GitHub answers for this project's owner/repo", driver: null },
  {
    state: "repo_held",
    must: "no agent_turn dispatches for this project, and exactly one open question says why",
    driver:
      "REPO_HOLD_MS lapses and lets one turn re-test; any GitHub answer clears the hold and revokes the " +
      "question; saving a credential forgets the hold at once, so a boss who just fixed it does not wait",
    repair: async (ctx) => {
      for (const p of await ctx.db
        .select({ id: project.id, remote: project.remote })
        .from(project)
        .where(isNotNull(project.remote))) {
        // `p.remote` is still typed nullable — the predicate is a runtime fact and
        // not a type — so this reads it rather than asserting past it.
        const slug = p.remote === null ? null : parseRepo(p.remote);
        if (slug && !(await repoHeld(ctx.db, p.id))) await clearEscalation(ctx.db, slug);
      }
    },
  },
);

/**
 * The sandbox server. One host dependency, three failure states, three answers.
 *
 * It earns rows here because the states are indistinguishable from the panel and
 * the wrong answer to each is worse than doing nothing: restarting a server that
 * is refusing produces a restart loop, and waiting for a server that is absent
 * produces a fleet that never moves.
 */
const SERVER_INVARIANTS = rows<ServerHealthState>(
  {
    state: "up",
    must: "every container is opened through it, and its config is the one we mount against",
    driver: null,
  },
  {
    state: "absent",
    must: "something restarts it, or the boss is told it will not come back",
    driver:
      "watchdog rule 19 restarts it from the argv it was last seen running, backing off 30s/2m/8m, " +
      "up to SERVER_RESTART_CAP; then it stops and files a blocker, because a fourth try is not evidence",
  },
  {
    state: "refusing",
    must: "it is NOT restarted, and the reason reaches the boss",
    driver:
      "preflight's reachable() names it (bad key, an HTTP status) and the hold in sandbox.ts stops the " +
      "fleet dispatching. Nothing automatic touches it: a restart here is a restart loop",
  },
  {
    state: "stale_config",
    must: "the drift is reported with the line that fixes it, because nothing else notices",
    driver:
      "preflight's allowed_host_paths check compares the server's own config against what we mount and " +
      "prints the line to add; checkSkillsMount catches the case that mounts an empty directory anyway",
  },
);

const LEASE_INVARIANTS = rows<LeaseState>(
  {
    state: "queued",
    must: "a lease job is queued for it, and the agent is waiting on the answer",
    driver:
      "Scheduler.tick dispatches it. The backstop is the route's own deadline, not watchdog rule 8 — " +
      "that rule requeues `agent_turn` only, so a lease job cancelled or dropped out from under a " +
      "waiter never reaches runLease and nothing else would ever answer it",
  },
  {
    state: "running",
    must: "it reaches done or failed — every path through runLease calls finishLease",
    driver:
      "runLease, which wraps its whole body: a throw becomes exit 126 rather than a promise nobody " +
      "resolves. The route's own deadline is the backstop for the paths that never reach it, such as " +
      "a job cancelled out from under it",
  },
  { state: "done", must: "the waiter is resolved and the agent is idle again", driver: null },
  { state: "failed", must: "the agent has the exit code and the digest to act on", driver: null },
);

const ESCALATION_INVARIANTS = rows<EscalationState>(
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
/**
 * Every table, not two of them.
 *
 * This ran GRP and SLICE and skipped the other six, so `PROJECT.repo_held`'s repair
 * — written, reviewed, covered by `uncovered()` — had never executed once. That is
 * this file's own failure from the other side: not a state with nobody driving it,
 * but a driver nobody calls, and both look like a healthy system.
 *
 * `uncovered()` checks every state has a row; nothing checked that every row runs.
 */
export const INVARIANT_TABLES = {
  grp: GRP_INVARIANTS,
  slice: SLICE_INVARIANTS,
  task: TASK_INVARIANTS,
  job: JOB_INVARIANTS,
  escalation: ESCALATION_INVARIANTS,
  util: UTIL_INVARIANTS,
  project: PROJECT_INVARIANTS,
  server: SERVER_INVARIANTS,
  lease: LEASE_INVARIANTS,
} satisfies Record<string, readonly Invariant<string>[]>;

/**
 * Every repair, awaited one at a time.
 *
 * Sequentially and deliberately: the repairs write overlapping rows — two of them
 * update `grp` — and a tick that fired them all at once would race itself for no
 * gain, on work that is idempotent and runs every 30 seconds anyway. Awaited
 * because a repair nobody waits for is the failure this whole table is against:
 * it would throw into an empty tick and read as a fleet with nothing to fix.
 */
export async function runInvariants(ctx: Ctx): Promise<void> {
  for (const table of Object.values(INVARIANT_TABLES)) {
    for (const invariant of table) await invariant.repair?.(ctx);
  }
}

/** States with no row. The test fails on a non-empty result; nothing else calls it. */
export function uncovered(): {
  grp: string[];
  slice: string[];
  task: string[];
  job: string[];
  escalation: string[];
  util: string[];
  project: string[];
  server: string[];
  lease: string[];
} {
  const has = (rs: { state: string }[], s: string) => rs.some((r) => r.state === s);
  return {
    grp: GRP_STATES.filter((s) => !has(INVARIANT_TABLES.grp, s)),
    slice: SLICE_STATES.filter((s) => !has(INVARIANT_TABLES.slice, s)),
    task: TASK_STATES.filter((s) => !has(INVARIANT_TABLES.task, s)),
    job: JOB_STATES.filter((s) => !has(INVARIANT_TABLES.job, s)),
    escalation: ESCALATION_STATES.filter((s) => !has(INVARIANT_TABLES.escalation, s)),
    util: UTIL_STATES.filter((s) => !has(INVARIANT_TABLES.util, s)),
    project: PROJECT_STATES.filter((s) => !has(INVARIANT_TABLES.project, s)),
    server: SERVER_STATES.filter((s) => !has(INVARIANT_TABLES.server, s)),
    lease: LEASE_STATES.filter((s) => !has(INVARIANT_TABLES.lease, s)),
  };
}
