import type { DB } from "./db.ts";
import { isRunning } from "./runtime/running.ts";

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
  /** Why it ended, when it ended badly. Read to tell a dead turn from a dead server. */
  error?: string | null;
}

/** Runs a job to completion. Throwing marks the job failed. */
export type Executor = (job: Job) => Promise<void>;

export interface SchedulerOptions {
  /** Max groups with an in-flight agent_turn. Default 3 (see PLAN.md §11). */
  maxGroups?: number;
  /**
   * Slots for the Runner pool, per resource tag. Leases never consume group slots.
   *
   * A plain number is the whole pool, as before. A map is one pool per tag, with
   * `default` covering resources that carry no tag — because the pool size is a
   * property of what the resource contends for, not of leases in general: a
   * headless browser wants 1 (each one is a real Chromium), while `typecheck`
   * wants as many as the machine has cores. One global number could only ever be
   * the minimum of those, which is the browser's, which starves everything else.
   */
  leaseSlots?: number | Record<string, number>;
  /** Kinds that are cheap bookkeeping and bypass the group slot pool. */
  now?: () => number;
  /**
   * Is the machine able to reach the providers right now?
   *
   * Injected, like `pollUsage` on the watchdog, so no unit test needs a network.
   * Default is "yes": a scheduler nobody told about the network must not stop.
   */
  online?: () => boolean;
}

export const DEFAULT_POOL = "default";
/** Resources tagged with this run one at a time per repository. */
export const REPO_POOL = "repo";

/** `2` and `{default: 2}` mean the same thing; the rest is per tag. */
export function poolSizes(slots: number | Record<string, number> | undefined): Record<string, number> {
  if (slots === undefined) return { [DEFAULT_POOL]: 1 };
  if (typeof slots === "number") return { [DEFAULT_POOL]: slots };
  return { [DEFAULT_POOL]: 1, ...slots };
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
  private readonly pools: Record<string, number>;
  private readonly now: () => number;
  private readonly online: () => boolean;
  private draining = false;

  constructor(
    private db: DB,
    private exec: Executor,
    opts: SchedulerOptions = {},
  ) {
    this.maxGroups = opts.maxGroups ?? 3;
    this.pools = poolSizes(opts.leaseSlots);
    this.now = opts.now ?? (() => Date.now());
    this.online = opts.online ?? (() => true);
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
    const taken: Record<string, number> = {};
    for (const j of this.runningJobs()) {
      if (j.kind === "lease") for (const p of this.poolsOf(j)) taken[p] = (taken[p] ?? 0) + 1;
      else if (!FREE_KINDS.has(j.kind)) busyGroups.add(j.grp_id ?? 0);
    }

    const out: Job[] = [];
    for (const job of pending) {
      if (job.kind === "lease") {
        // Every pool the resource is tagged with has to have room: a lease that
        // is both `browser` and `heavy` waits for whichever is tighter.
        const want = this.poolsOf(job);
        if (want.some((p) => (taken[p] ?? 0) >= (this.pools[p] ?? this.pools[DEFAULT_POOL]!))) continue;
        for (const p of want) taken[p] = (taken[p] ?? 0) + 1;
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
      // Offline is the third gate of the same shape as the two below, and for the
      // same reason: a turn that cannot possibly work should not be started. It
      // costs nothing to wait — a held job has no process behind it — and it
      // lifts by itself when the probe says the network is back, so the boss is
      // not left with a fleet to restart by hand.
      if (job.kind === "agent_turn" && !this.online()) continue;
      if (job.kind === "agent_turn" && this.providerHeld(job)) continue;
      if (job.kind === "agent_turn" && this.credentialMissing(job)) continue;
      busyGroups.add(slot);
      out.push(job);
    }
    return out;
  }

  /**
   * Which pools a lease job draws from.
   *
   * The tags live on the resource, not on the job, so this is a lookup — and an
   * unknown tag falls back to `default` rather than to "unlimited": a typo in a
   * tag name must not silently uncap the pool it meant to name.
   */
  private poolsOf(job: Job): string[] {
    let leaseId = 0;
    try {
      leaseId = Number(JSON.parse(job.payload_json ?? "{}").lease_id ?? 0);
    } catch {}
    if (!leaseId) return [DEFAULT_POOL];
    const row = this.db
      .query<{ tags_json: string; project_id: number | null }, [number]>(
        `SELECT r.tags_json, (SELECT project_id FROM grp WHERE id = l.grp_id) AS project_id
         FROM lease l JOIN resource r ON r.name = l.resource WHERE l.id = ?`,
      )
      .get(leaseId);
    let tags: string[] = [];
    try {
      tags = JSON.parse(row?.tags_json ?? "[]");
    } catch {}
    if (!tags.length) return [DEFAULT_POOL];
    // `repo` is one pool per repository, not one pool globally: two projects'
    // gates have nothing to race over, and serialising them would make every
    // extra project slower for nothing. See the tag's comment in api.ts.
    return tags.map((t) => (t === REPO_POOL ? `${REPO_POOL}:${row?.project_id ?? 0}` : t));
  }

  private runningJobs(): Job[] {
    return this.db
      .query<Job, []>(
        `SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state
         FROM job WHERE state = 'running'`,
      )
      .all();
  }

  /**
   * Is this turn's provider out of quota right now?
   *
   * A rate limit is an account-level fact, so it holds every agent on that CLI —
   * including standing ones, which have no group to pause. Holding here rather
   * than failing the turn is what keeps it free: a held job is simply not picked
   * up, so there is no process, no retry loop and no quota spent proving the wall
   * is still there. It lifts by clock, on the reset time the CLI itself reported.
   *
   * A job whose agent does not exist yet cannot be held: nothing has chosen a
   * provider for it. It will be hired, run once, and hold the provider itself.
   */
  private providerHeld(job: Job): boolean {
    if (!job.agent_id) return false;
    const row = this.db
      .query<{ hold_until: number | null }, [number]>(
        `SELECT u.hold_until FROM agent a JOIN usage_snapshot u ON u.runtime = a.runtime
         WHERE a.id = ?`,
      )
      .get(job.agent_id);
    return !!row?.hold_until && row.hold_until > this.now();
  }

  /**
   * Is there a credential for this turn's provider at all?
   *
   * Same shape as a rate-limit hold, and for the same reason: without it every
   * group spends a turn discovering the wall, one at a time, and the only sign
   * is a queue full of failures that all say 401. A turn that cannot possibly
   * work should not be dispatched — preflight and the settings page are where
   * this is said out loud, and both name the command that fixes it.
   *
   * An unhired job has not chosen a provider yet, so the question becomes
   * whether *any* credential exists: with none, nothing it could be hired onto
   * would run either.
   */
  private credentialMissing(job: Job): boolean {
    const runtime = job.agent_id
      ? (this.db
          .query<{ runtime: string }, [number]>("SELECT runtime FROM agent WHERE id = ?")
          .get(job.agent_id)?.runtime ?? null)
      : null;
    const n = runtime
      ? this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM runtime_auth WHERE runtime = ?").get(runtime)
      : this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runtime_auth").get();
    return (n?.n ?? 0) === 0;
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
 * A job is an orphan when this process is no longer reading its turn, or when it
 * has been "running" longer than any turn is allowed to.
 *
 * "Reading it" replaced "its pid is alive" when turns moved into sandboxes: the
 * CLI is not a child of this process any more, so liveness is about the stream,
 * not about a process table. After a restart nothing is being read, which is the
 * right answer — the command inside the sandbox runs on into the void until its
 * own timeout, and the requeued turn sees whatever it wrote.
 *
 * Returns the reclaimed jobs so the caller can put them back: freeing the slot
 * only un-wedges the *queue*. The work itself was still dropped — the slice stayed
 * `running`, so `startNextSlice` counted the group busy and never queued anything
 * again. Same silence, one layer down.
 */
export function reclaimOrphans(
  db: DB,
  opts: { maxAgeMs?: number; alive?: (jobId: number) => boolean; now?: () => number } = {},
): Job[] {
  const maxAge = opts.maxAgeMs ?? 3_600_000;
  const now = opts.now ?? (() => Date.now());
  const alive = opts.alive ?? isRunning;

  const running = db
    .query<Job & { started_at: number | null }, []>(
      `SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state, started_at
       FROM job WHERE state = 'running'`,
    )
    .all();

  const reclaimed: Job[] = [];
  for (const j of running) {
    const tooOld = j.started_at !== null && now() - j.started_at > maxAge;
    if (!tooOld && alive(j.id)) continue;

    const why = tooOld
      ? `orphaned: still running after ${Math.round(maxAge / 60000)} min`
      : "orphaned: nothing is reading this turn any more";
    db.run(
      `UPDATE job SET state = 'failed', ended_at = ?, error = ? WHERE id = ? AND state = 'running'`,
      [now(), why, j.id],
    );
    // The reason travels with the row: resumeReclaimed reads it to tell a turn that
    // died of its own doing from one the server took down on its way out.
    reclaimed.push({ ...j, state: "failed", error: why });
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
    // `resumed` stops a turn that takes the server down with it from being
    // resurrected forever — but an orphan died because the *server* went away, not
    // because of anything it did, and that must not spend its one chance. Six
    // groups sat stopped after a restart with a fix already in main, each holding a
    // turn that was only ever killed by the restart itself, and every one of them
    // needed a human to say "go on then".
    //
    // `offline:` is the same argument. The network went away; the turn did
    // nothing wrong, and spending its one retry on that would leave the group
    // stopped after the connection came back.
    const orphaned = /^(orphaned|offline):/.test(j.error ?? "");
    if (payload?.resumed && !orphaned) continue;
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
