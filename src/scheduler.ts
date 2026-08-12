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
    if (!DISPATCHABLE.has(grp.status)) return false;
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
