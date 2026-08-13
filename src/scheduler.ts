import type { DB } from "./db.ts";

export type JobKind =
  | "agent_turn"
  | "lease"
  | "watchdog"
  | "digest"
  | "notify"
  | "gate"
  | "reconcile";

export type JobState = "pending" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: number;
  kind: JobKind;
  grp_id: number | null;
  agent_id: number | null;
  slice_id: number | null;
  payload_json: string;
  priority: number;
  state: JobState;
}

/** Runs a job to completion. Throwing marks the job failed. */
export type Executor = (job: Job) => Promise<void>;

export interface SchedulerOptions {
  /** Max groups with an in-flight agent_turn. Default 3 (see PLAN.md §11). */
  maxGroups?: number;
  /** Slots for the Runner pool. Leases never consume group slots. */
  leaseSlots?: number;
  /** Kinds that are cheap bookkeeping and bypass the group slot pool. */
  now?: () => number;
}

/**
 * Group statuses that allow dispatching an agent_turn.
 *
 * PLANNING is dispatchable and DRAFT is not, and the distinction matters: the
 * Dispatcher has to run *before* the boss can approve anything, so "planning the
 * work" and "waiting for the boss" cannot be the same state. Everything else is a
 * barrier: PAUSING/PAUSED (intercept L2), PARKED, DRAFT (the card is ready).
 */
const DISPATCHABLE = new Set(["PLANNING", "RUNNING", "PR_OPEN"]);

/**
 * Roles DRAFT does not block.
 *
 * DRAFT means "the card is written, stop spending until the boss says go", and
 * that is about the writers. It was applied to every role, and the contradiction
 * was load-bearing: a refused approval enqueues an Architect turn to cut the
 * boundary, the group is in DRAFT, so that turn never ran — the boundary was
 * never cut, the approval never landed, and the boss was told to click again.
 * Observed on three groups at once, each holding a permanently pending job.
 */
const PLANNING_ROLES = new Set(["dispatcher", "architect", "cos", "librarian"]);

/** Housekeeping kinds: not attributed to a group's writer slot. */
const FREE_KINDS = new Set<JobKind>(["watchdog", "notify", "digest"]);

/**
 * The only thing that can start an agent.
 *
 * Because every turn is dispatched from one serialized point, intercept is
 * always available (insert or cancel a job), park is "cancel this group's
 * pending jobs", and budget halt is one admission check. Three mechanisms,
 * one queue.
 */
export class Scheduler {
  private inflight = new Map<number, Promise<void>>();
  private readonly maxGroups: number;
  private readonly leaseSlots: number;
  private readonly now: () => number;
  private draining = false;

  constructor(
    private db: DB,
    private exec: Executor,
    opts: SchedulerOptions = {},
  ) {
    this.maxGroups = opts.maxGroups ?? 3;
    this.leaseSlots = opts.leaseSlots ?? 1;
    this.now = opts.now ?? (() => Date.now());
  }

  enqueue(
    kind: JobKind,
    fields: {
      grp_id?: number | null;
      agent_id?: number | null;
      slice_id?: number | null;
      payload?: unknown;
      priority?: number;
    } = {},
  ): number {
    const row = this.db
      .query<{ id: number }, [string, number | null, number | null, number | null, string, number, number]>(
        `INSERT INTO job (kind, grp_id, agent_id, slice_id, payload_json, priority, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        kind,
        fields.grp_id ?? null,
        fields.agent_id ?? null,
        fields.slice_id ?? null,
        JSON.stringify(fields.payload ?? {}),
        fields.priority ?? 0,
        this.now(),
      )!;
    return row.id;
  }

  /** Dispatch everything currently eligible. Safe to call often; never reentrant. */
  tick(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const job of this.eligible()) this.start(job);
    } finally {
      this.draining = false;
    }
  }

  /** Resolve once every in-flight job has settled and nothing new is eligible. */
  async drain(): Promise<void> {
    for (;;) {
      this.tick();
      if (this.inflight.size === 0) return;
      await Promise.race(this.inflight.values()).catch(() => {});
    }
  }

  /** park / respec: drop a group's queued work without touching what is running. */
  cancelPending(grpId: number, reason = "cancelled"): number {
    const r = this.db.run(
      `UPDATE job SET state = 'cancelled', ended_at = ?, error = ?
       WHERE grp_id = ? AND state = 'pending'`,
      [this.now(), reason, grpId],
    );
    return r.changes;
  }

  runningCount(): number {
    return this.inflight.size;
  }

  /**
   * Jobs that may start right now, in dispatch order.
   *
   * Rules, in order of application:
   *  - one in-flight agent_turn per group (the group's single writer; makes the
   *    L2 barrier and "no intra-group write conflicts" fall out for free)
   *  - at most `maxGroups` groups with an in-flight agent_turn
   *  - leases draw from their own pool, capped per resource concurrency
   *  - a group must be in a dispatchable status
   *  - budget must not be exhausted (slice budget first, then group)
   */
  private eligible(): Job[] {
    const pending = this.db
      .query<Job, []>(
        `SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state
         FROM job WHERE state = 'pending' ORDER BY priority DESC, id`,
      )
      .all();
    if (pending.length === 0) return [];

    // Standing agents (Architect, CoS, Librarian) have no group, but their turns
    // cost the same money and CPU as anyone's — so they take a slot too, keyed by
    // 0. Letting them bypass the pool was how a "no slots" configuration still
    // spawned agents.
    const busyGroups = new Set<number>();
    let leasesRunning = 0;
    for (const j of this.runningJobs()) {
      if (j.kind === "lease") leasesRunning++;
      else if (!FREE_KINDS.has(j.kind)) busyGroups.add(j.grp_id ?? 0);
    }

    const out: Job[] = [];
    for (const job of pending) {
      if (job.kind === "lease") {
        if (leasesRunning >= this.leaseSlots) continue;
        leasesRunning++;
        out.push(job);
        continue;
      }
      if (FREE_KINDS.has(job.kind)) {
        out.push(job);
        continue;
      }
      const slot = job.grp_id ?? 0;
      if (busyGroups.has(slot)) continue;
      if (busyGroups.size >= this.maxGroups) continue;
      // Only a group-scoped job has a status and a budget to check.
      if (job.grp_id !== null && !this.admits(job)) continue;
      busyGroups.add(slot);
      out.push(job);
    }
    return out;
  }

  private runningJobs(): Job[] {
    return this.db
      .query<Job, []>(
        `SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state
         FROM job WHERE state = 'running'`,
      )
      .all();
  }

  /** Admission check: group status is a barrier, budget is a hard stop. */
  private admits(job: Job): boolean {
    const grp = this.db
      .query<{ status: string; budget_tokens: number | null; spent_tokens: number }, [number]>(
        "SELECT status, budget_tokens, spent_tokens FROM grp WHERE id = ?",
      )
      .get(job.grp_id!);
    if (!grp) return false;
    if (!DISPATCHABLE.has(grp.status)) {
      if (grp.status !== "DRAFT") return false;
      let role: unknown;
      try {
        role = JSON.parse(job.payload_json)?.role;
      } catch {
        return false;
      }
      if (typeof role !== "string" || !PLANNING_ROLES.has(role)) return false;
    }
    if (grp.budget_tokens !== null && grp.spent_tokens >= grp.budget_tokens) return false;

    if (job.slice_id !== null) {
      const s = this.db
        .query<{ budget_tokens: number | null; spent_tokens: number }, [number]>(
          "SELECT budget_tokens, spent_tokens FROM slice WHERE id = ?",
        )
        .get(job.slice_id);
      // Budget is per-slice so overspend is caught early, not at group level.
      if (s && s.budget_tokens !== null && s.spent_tokens >= s.budget_tokens) return false;
    }
    return true;
  }

  private start(job: Job): void {
    const claimed = this.db.run(
      "UPDATE job SET state = 'running', started_at = ? WHERE id = ? AND state = 'pending'",
      [this.now(), job.id],
    );
    if (claimed.changes === 0) return; // someone else took it

    const p = this.exec({ ...job, state: "running" })
      .then(() => this.settle(job.id, "done"))
      .catch((e) => this.settle(job.id, "failed", String(e?.message ?? e)))
      .finally(() => {
        this.inflight.delete(job.id);
      });
    this.inflight.set(job.id, p);
  }

  /** A job never stays in `running`: it always lands in a terminal state. */
  private settle(id: number, state: JobState, error?: string): void {
    this.db.run("UPDATE job SET state = ?, ended_at = ?, error = ? WHERE id = ?", [
      state,
      this.now(),
      error ?? null,
      id,
    ]);
  }
}

/**
 * Reclaim jobs left `running` by a server that is no longer here.
 *
 * A job in `running` holds its group's only slot, and nothing else in that group
 * can ever dispatch while it does. So a crash — or an ordinary restart while a
 * turn was in flight — permanently wedges the group, silently: the queue looks
 * healthy and simply never moves. Observed exactly that way.
 *
 * A job is an orphan when its process is gone, or when it has no pid, or when it
 * has been "running" longer than any turn is allowed to.
 *
 * Returns the reclaimed jobs so the caller can put them back: freeing the slot
 * only un-wedges the *queue*. The work itself was still dropped — the slice stayed
 * `running`, so `startNextSlice` counted the group busy and never queued anything
 * again. Same silence, one layer down.
 */
export function reclaimOrphans(
  db: DB,
  opts: { maxAgeMs?: number; alive?: (pid: number) => boolean; now?: () => number } = {},
): Job[] {
  const maxAge = opts.maxAgeMs ?? 3_600_000;
  const now = opts.now ?? (() => Date.now());
  const alive =
    opts.alive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  const running = db
    .query<Job & { pid: number | null; started_at: number | null }, []>(
      `SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state, pid, started_at
       FROM job WHERE state = 'running'`,
    )
    .all();

  const reclaimed: Job[] = [];
  for (const j of running) {
    const tooOld = j.started_at !== null && now() - j.started_at > maxAge;
    if (j.pid !== null && !tooOld && alive(j.pid)) continue;

    db.run(
      `UPDATE job SET state = 'failed', ended_at = ?, error = ? WHERE id = ? AND state = 'running'`,
      [
        now(),
        j.pid === null
          ? "orphaned: no process was ever recorded"
          : tooOld
            ? `orphaned: still running after ${Math.round(maxAge / 60000)} min`
            : `orphaned: process ${j.pid} is gone`,
        j.id,
      ],
    );
    reclaimed.push({ ...j, state: "failed" });
  }

  // Agents believe they are mid-turn too, and a blocked agent is skipped forever.
  if (reclaimed.length > 0) {
    db.run("UPDATE agent SET state = 'idle' WHERE state = 'running'");
  }
  return reclaimed;
}

/**
 * Put reclaimed turns back on the queue, so a restart costs one turn rather than
 * the group.
 *
 * The slice is left where it was and the same role is re-queued on it: whatever
 * the killed turn wrote is still in the worktree, which is the `keep` half of
 * intercept, reached from the other direction. `resumed` is stamped on the payload
 * so a turn that takes the server down with it cannot be resurrected forever.
 */
export function resumeReclaimed(sched: Scheduler, jobs: Job[]): number {
  let requeued = 0;
  for (const j of jobs) {
    // Housekeeping kinds are re-enqueued by the server's own timer.
    if (FREE_KINDS.has(j.kind)) continue;
    let payload: any = {};
    try {
      payload = JSON.parse(j.payload_json);
    } catch {
      // A payload we cannot read is a payload we cannot re-run faithfully.
      continue;
    }
    if (payload?.resumed) continue;
    sched.enqueue(j.kind, {
      grp_id: j.grp_id,
      agent_id: j.agent_id,
      slice_id: j.slice_id,
      priority: j.priority,
      payload: { ...payload, resumed: true },
    });
    requeued++;
  }
  return requeued;
}
