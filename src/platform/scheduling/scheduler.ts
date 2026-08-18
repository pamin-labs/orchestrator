import { z } from "zod";
import type { DB } from "../../platform/persistence/database.ts";
import { jsonOr } from "../../contracts/json.ts";
import { isRunning, track, untrack } from "../../platform/process/running-turns.ts";
import { type GrpState, isDispatchableGrpState, type JobState } from "../../contracts/states.ts";
import { requestContext } from "../../platform/observability/request-context.ts";
import { observeJob } from "../../platform/observability/metrics.ts";
import { startChildTrace, withActiveSpan } from "../../platform/observability/traces.ts";
import { errText } from "../../platform/process/text.ts";

export type { JobState } from "../../contracts/states.ts";

const JobKindSchema = z.enum(["agent_turn", "lease", "watchdog", "digest", "notify", "gate", "reconcile"]);
export type JobKind = z.infer<typeof JobKindSchema>;

const Id = z.number().int().positive();
const Sequence = z.number().int().nonnegative();
const Resumable = z.object({ resumed: z.boolean().optional() });

export const AgentTurnPayloadSchema = Resumable.extend({
  role: z.string().optional(),
  idea: z.string().optional(),
  respec: z.string().optional(),
  rejection: z.string().optional(),
  rotate: z.boolean().optional(),
  mail: z
    .object({
      from: z.string(),
      from_group: Id.nullable().optional(),
      intent: z.string(),
      body: z.string(),
    })
    .optional(),
  escalation: Id.optional(),
  boundary: z.union([Id, z.array(z.object({ id: Id, name: z.string(), idea: z.string().optional() }))]).optional(),
  conflict: z.boolean().optional(),
  audit: Id.optional(),
  audit_branch: z.string().nullable().optional(),
  audit_group: z.string().optional(),
  scribe: Id.optional(),
  review: Id.optional(),
  skills: z.array(z.string()).optional(),
  digest: z.object({ channel_id: Id, from: Sequence, to: Sequence }).optional(),
  sediment: z.array(z.string()).optional(),
  project_id: Id.optional(),
}).strict();

const EmptyPayloadSchema = Resumable.strict();
const JobPayloadSchemas = {
  agent_turn: AgentTurnPayloadSchema,
  lease: Resumable.extend({ lease_id: Id.optional() }).strict(),
  watchdog: EmptyPayloadSchema,
  digest: EmptyPayloadSchema,
  notify: EmptyPayloadSchema,
  gate: EmptyPayloadSchema,
  reconcile: EmptyPayloadSchema,
} as const satisfies Record<JobKind, z.ZodType>;

export type JobPayload<K extends JobKind> = z.infer<(typeof JobPayloadSchemas)[K]>;

export interface StoredJob {
  id: number;
  kind: string;
  grp_id: number | null;
  agent_id: number | null;
  slice_id: number | null;
  payload_json: string;
  priority: number;
  state: JobState;
  error?: string | null;
  correlation_id?: string | null;
  trace_id?: string | null;
  parent_span_id?: string | null;
}

type RunningJob = StoredJob & { started_at: number | null };

export type Job<K extends JobKind = JobKind> = {
  [P in K]: Omit<StoredJob, "kind"> & { kind: P; payload: JobPayload<P> };
}[K];

/** Runs a job to completion. Throwing marks the job failed. */
export type Executor = (job: Job) => Promise<void>;

export type EnqueueFields<K extends JobKind> = {
  grp_id?: number | null;
  agent_id?: number | null;
  slice_id?: number | null;
  payload?: JobPayload<K>;
  priority?: number;
  correlationId?: string | null;
  traceId?: string | null;
  parentSpanId?: string | null;
};

/** First set value wins: the explicit field, then the ambient request, then the fallback. */
const first = <T>(...vals: readonly (T | null | undefined)[]): T | undefined =>
  vals.find((v): v is T => v !== null && v !== undefined);

function enqueueTrace<K extends JobKind>(fields: EnqueueFields<K>) {
  const context = requestContext.getStore();
  return {
    correlationId: first(fields.correlationId, context?.requestId) ?? crypto.randomUUID(),
    traceId: first(fields.traceId, context?.traceId) ?? crypto.randomUUID().replaceAll("-", ""),
    parentSpanId: first(fields.parentSpanId, context?.spanId) ?? null,
  };
}

function decodeJob(row: StoredJob): Job {
  const kind = JobKindSchema.parse(row.kind);
  const raw: unknown = JSON.parse(row.payload_json);
  switch (kind) {
    case "agent_turn":
      return { ...row, kind, payload: JobPayloadSchemas.agent_turn.parse(raw) };
    case "lease":
      return { ...row, kind, payload: JobPayloadSchemas.lease.parse(raw) };
    case "watchdog":
      return { ...row, kind, payload: JobPayloadSchemas.watchdog.parse(raw) };
    case "digest":
      return { ...row, kind, payload: JobPayloadSchemas.digest.parse(raw) };
    case "notify":
      return { ...row, kind, payload: JobPayloadSchemas.notify.parse(raw) };
    case "gate":
      return { ...row, kind, payload: JobPayloadSchemas.gate.parse(raw) };
    case "reconcile":
      return { ...row, kind, payload: JobPayloadSchemas.reconcile.parse(raw) };
  }
}

export interface SchedulerOptions {
  /** Max groups with an in-flight agent_turn. Default 3 (see docs/project/plan.md §11). */
  maxGroups?: number | (() => number);
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
  leaseSlots?: number | Record<string, number> | (() => number | Record<string, number> | undefined);
  /** Kinds that are cheap bookkeeping and bypass the group slot pool. */
  now?: () => number;
  /**
   * Is the machine able to reach the providers right now?
   *
   * Injected, like `pollUsage` on the watchdog, so no unit test needs a network.
   * Default is "yes": a scheduler nobody told about the network must not stop.
   */
  online?: () => boolean;
  /**
   * Can a container be opened right now?
   *
   * Separate from `online` and deliberately not folded into it: one is about
   * this machine reaching the providers, the other about docker and the sandbox
   * server being up. Conflating them would make both comments wrong the first
   * time only one of them was true.
   */
  sandboxReady?: () => boolean;
  /**
   * Has GitHub stopped accepting us for this project?
   *
   * The fourth gate of the same shape, and the first that is **per project**:
   * `online`, `sandboxReady` and `providerHeld` are all facts about the machine
   * or the account, while a dead GitHub credential is a fact about one
   * repository. One project's revoked org access must not stop a project whose
   * credential is fine. Injected like the others, so no unit test needs a
   * network — `repoHeld` in `github.ts` is what the server passes.
   */
  repoHeld?: (projectId: number) => boolean;
}

const DEFAULT_POOL = "default";
/** Resources tagged with this run one at a time per repository. */
const REPO_POOL = "repo";

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

function groupStateAdmits(status: GrpState, job: Job): boolean {
  if (isDispatchableGrpState(status)) return true;
  return (
    status === "DRAFT" &&
    job.kind === "agent_turn" &&
    job.payload.role !== undefined &&
    PLANNING_ROLES.has(job.payload.role)
  );
}

function hasBudget(row: { budget_tokens: number | null; spent_tokens: number }): boolean {
  return row.budget_tokens === null || row.spent_tokens < row.budget_tokens;
}

/** Housekeeping kinds: not attributed to a group's writer slot. */
const FREE_KINDS = new Set<JobKind>(["watchdog", "notify", "digest"]);

/**
 * Which writer slot a job occupies. One in-flight job per slot.
 *
 * For a group it is the group: that is the "one writer per group" rule, and the
 * L2 barrier falls out of it. A group-less job belongs to a standing agent, and
 * those used to collapse onto slot 0 — so Architect, CoS, Dispatcher and
 * Librarian, who share nothing, took turns waiting for each other. Measured on
 * this database: Dispatcher averaged 4309s of queueing, CoS 1752s, for turns
 * that touch no common state. Negative keys can never collide with a group id,
 * so an agent still serialises against itself (it cannot write two transcripts
 * at once) while the four of them run in parallel. They still count towards
 * `maxGroups`, which was the actual reason slot 0 existed.
 */
function slotOf(job: Pick<Job, "grp_id" | "agent_id">): number {
  return job.grp_id ?? -(job.agent_id ?? 0);
}

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
  /**
   * Read per tick, not captured at construction.
   *
   * Both are settings the boss can change while the fleet is running, and the
   * scheduler outlives every one of those changes — a value frozen here would
   * have meant restarting the server to raise a concurrency limit. Same shape as
   * `now` and `online` below, which are injected for the same reason.
   */
  private readonly maxGroups: () => number;
  private readonly pools: () => Record<string, number>;
  private readonly now: () => number;
  private readonly online: () => boolean;
  private readonly sandboxReady: () => boolean;
  private readonly repoHeld: (projectId: number) => boolean;
  private draining = false;
  private accepting = true;

  private readonly db: DB;
  private readonly exec: Executor;

  constructor(db: DB, exec: Executor, opts: SchedulerOptions = {}) {
    this.db = db;
    this.exec = exec;
    const groups = opts.maxGroups ?? 3;
    this.maxGroups = typeof groups === "function" ? groups : () => groups;
    const slots = opts.leaseSlots;
    this.pools = typeof slots === "function" ? () => poolSizes(slots()) : () => poolSizes(slots);
    this.now = opts.now ?? (() => Date.now());
    this.online = opts.online ?? (() => true);
    this.sandboxReady = opts.sandboxReady ?? (() => true);
    this.repoHeld = opts.repoHeld ?? (() => false);
  }

  enqueue<K extends JobKind>(kind: K, fields: EnqueueFields<K> = {}): number {
    const payload = JobPayloadSchemas[kind].parse(fields.payload ?? {});
    const trace = enqueueTrace(fields);
    const row = this.db
      .query<
        { id: number },
        [string, number | null, number | null, number | null, string, number, number, string, string, string | null]
      >(
        `INSERT INTO job
           (kind, grp_id, agent_id, slice_id, payload_json, priority, enqueued_at,
            correlation_id, trace_id, parent_span_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        kind,
        fields.grp_id ?? null,
        fields.agent_id ?? null,
        fields.slice_id ?? null,
        JSON.stringify(payload),
        fields.priority ?? 0,
        this.now(),
        trace.correlationId,
        trace.traceId,
        trace.parentSpanId,
      )!;
    return row.id;
  }

  /** Dispatch everything currently eligible. Safe to call often; never reentrant. */
  tick(): void {
    if (!this.accepting || this.draining) return;
    this.draining = true;
    try {
      for (const job of this.eligible()) this.start(job);
    } finally {
      this.draining = false;
    }
  }

  /** Stop admitting queued work while allowing in-flight jobs to settle. */
  quiesce(): void {
    this.accepting = false;
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
    const rows = this.db
      .query<StoredJob, []>(
        `SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state,
                correlation_id, trace_id, parent_span_id
         FROM job WHERE state = 'pending' ORDER BY priority DESC, id`,
      )
      .all();
    if (rows.length === 0) return [];
    const pending = this.decode(rows);

    // Standing agents (Architect, CoS, Librarian) have no group, but their turns
    // cost the same money and CPU as anyone's — so they take a slot too. Letting
    // them bypass the pool was how a "no slots" configuration still spawned agents.
    const { busyGroups, taken } = this.capacity();

    const out: Job[] = [];
    for (const job of pending) {
      if (this.claimCapacity(job, busyGroups, taken)) out.push(job);
    }
    return out;
  }

  private claimCapacity(job: Job, busyGroups: Set<number>, taken: Record<string, number>): boolean {
    if (job.kind === "lease") return this.claimLeaseCapacity(job, taken);
    if (FREE_KINDS.has(job.kind)) return true;
    return this.claimWriterCapacity(job, busyGroups);
  }

  private claimWriterCapacity(job: Job, busyGroups: Set<number>): boolean {
    const slot = slotOf(job);
    if (!this.writerSlotAvailable(slot, busyGroups)) return false;
    if (!this.groupAdmitsJob(job) || !this.jobReady(job)) return false;
    busyGroups.add(slot);
    return true;
  }

  private groupAdmitsJob(job: Job): boolean {
    return job.grp_id === null || this.admits(job);
  }

  private jobReady(job: Job): boolean {
    return job.kind !== "agent_turn" || this.agentTurnReady(job);
  }

  private capacity(): { busyGroups: Set<number>; taken: Record<string, number> } {
    const busyGroups = new Set<number>();
    const taken: Record<string, number> = {};
    for (const job of this.runningJobs()) {
      if (job.kind === "lease") {
        for (const pool of this.poolsOf(job)) taken[pool] = (taken[pool] ?? 0) + 1;
      } else if (!FREE_KINDS.has(job.kind)) {
        busyGroups.add(slotOf(job));
      }
    }
    return { busyGroups, taken };
  }

  private claimLeaseCapacity(job: Job<"lease">, taken: Record<string, number>): boolean {
    // Every pool the resource is tagged with has to have room: a lease that is
    // both `browser` and `heavy` waits for whichever is tighter.
    const wanted = this.poolsOf(job);
    const limits = this.pools();
    // `repo:<project>` must not inherit `default`, which ships as 2. The pool is
    // keyed per project so that it can be one — falling back to `default` is what
    // let two gates of one repository run side by side, the thing the `repo` tag
    // exists to make structurally impossible (`start.ts`).
    const limitOf = (pool: string): number =>
      pool.startsWith(`${REPO_POOL}:`) ? (limits[REPO_POOL] ?? 1) : (limits[pool] ?? limits[DEFAULT_POOL]!);
    if (wanted.some((pool) => (taken[pool] ?? 0) >= limitOf(pool))) return false;
    for (const pool of wanted) taken[pool] = (taken[pool] ?? 0) + 1;
    return true;
  }

  private writerSlotAvailable(slot: number, busyGroups: Set<number>): boolean {
    return !busyGroups.has(slot) && busyGroups.size < this.maxGroups();
  }

  private agentTurnReady(job: Job<"agent_turn">): boolean {
    if (!this.online() || !this.sandboxReady()) return false;
    return !this.providerHeld(job) && !this.credentialMissing(job) && !this.repoLockedOut(job);
  }

  /**
   * Which pools a lease job draws from.
   *
   * The tags live on the resource, not on the job, so this is a lookup — and an
   * unknown tag falls back to `default` rather than to "unlimited": a typo in a
   * tag name must not silently uncap the pool it meant to name.
   */
  private poolsOf(job: Job<"lease">): string[] {
    const leaseId = job.payload.lease_id ?? 0;
    if (!leaseId) return [DEFAULT_POOL];
    const row = this.db
      .query<{ tags_json: string; project_id: number | null }, [number]>(
        `SELECT r.tags_json, (SELECT project_id FROM grp WHERE id = l.grp_id) AS project_id
         FROM lease l JOIN resource r ON r.name = l.resource WHERE l.id = ?`,
      )
      .get(leaseId);
    const tags = jsonOr(row?.tags_json, z.array(z.string()), []);
    if (!tags.length) return [DEFAULT_POOL];
    // `repo` is one pool per repository, not one pool globally: two projects'
    // gates have nothing to race over, and serialising them would make every
    // extra project slower for nothing. See the tag's comment in api.ts.
    return tags.map((t) => (t === REPO_POOL ? `${REPO_POOL}:${row?.project_id ?? 0}` : t));
  }

  private runningJobs(): Job[] {
    return this.decode(
      this.db
        .query<StoredJob, []>(
          `SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state,
                  correlation_id, trace_id, parent_span_id
           FROM job WHERE state = 'running'`,
        )
        .all(),
    );
  }

  /** Invalid persisted control data is a failed job, never an omitted instruction. */
  private decode(rows: StoredJob[]): Job[] {
    const jobs: Job[] = [];
    for (const row of rows) {
      try {
        jobs.push(decodeJob(row));
      } catch (error) {
        this.db.run("UPDATE job SET state = 'failed', ended_at = ?, error = ? WHERE id = ? AND state = ?", [
          this.now(),
          `invalid ${row.kind} payload: ${error instanceof Error ? error.message : String(error)}`,
          row.id,
          row.state,
        ]);
      }
    }
    return jobs;
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
  private providerHeld(job: Job<"agent_turn">): boolean {
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
  private credentialMissing(job: Job<"agent_turn">): boolean {
    const runtime = job.agent_id
      ? (this.db.query<{ runtime: string }, [number]>("SELECT runtime FROM agent WHERE id = ?").get(job.agent_id)
          ?.runtime ?? null)
      : null;
    const n = runtime
      ? this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM runtime_auth WHERE runtime = ?").get(runtime)
      : this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runtime_auth").get();
    return (n?.n ?? 0) === 0;
  }

  /**
   * Has GitHub locked this turn's project out?
   *
   * Only `agent_turn`, like `online` and `sandboxReady`: a lease is a gate or a
   * typecheck in the group's own container and mostly needs no network at all,
   * so holding those would stop work that would have succeeded.
   *
   * A job with no group belongs to no project and cannot be held — there is
   * nothing to look up, and defaulting to held would stop housekeeping over
   * somebody else's credential.
   */
  private repoLockedOut(job: Job<"agent_turn">): boolean {
    if (!job.grp_id) return false;
    const row = this.db
      .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
      .get(job.grp_id);
    return !!row && this.repoHeld(row.project_id);
  }

  /** Admission check: group status is a barrier, budget is a hard stop. */
  private admits(job: Job): boolean {
    return this.groupAdmits(job) && this.sliceAdmits(job);
  }

  private groupAdmits(job: Job): boolean {
    const grp = this.db
      .query<{ status: GrpState; budget_tokens: number | null; spent_tokens: number }, [number]>(
        "SELECT status, budget_tokens, spent_tokens FROM grp WHERE id = ?",
      )
      .get(job.grp_id!);
    if (!grp) return false;
    return groupStateAdmits(grp.status, job) && hasBudget(grp);
  }

  private sliceAdmits(job: Job): boolean {
    if (job.slice_id === null) return true;
    const slice = this.db
      .query<{ budget_tokens: number | null; spent_tokens: number }, [number]>(
        "SELECT budget_tokens, spent_tokens FROM slice WHERE id = ?",
      )
      .get(job.slice_id);
    // Budget is per-slice so overspend is caught early, not at group level.
    return !slice || hasBudget(slice);
  }

  private start(job: Job): void {
    const claimed = this.db.run("UPDATE job SET state = 'running', started_at = ? WHERE id = ? AND state = 'pending'", [
      this.now(),
      job.id,
    ]);
    if (claimed.changes === 0) return; // someone else took it

    const trace = startChildTrace(job.trace_id, job.parent_span_id);
    const lifecycle = new AbortController();
    const cancel = () => lifecycle.abort(new Error(`job ${job.id} cancelled`));
    track(job.id, cancel);
    const context = {
      requestId: job.correlation_id ?? crypto.randomUUID(),
      traceId: trace.traceId,
      spanId: trace.spanId,
      method: "JOB",
      path: `job:${job.kind}`,
      jobId: job.id,
      grpId: job.grp_id,
      agentId: job.agent_id,
      signal: lifecycle.signal,
    };
    // The job's own scope. A job with no group is system work — the watchdog, a
    // digest — and NULL is the right answer there. A job that has one belongs to
    // that group's project, and the column is looked up rather than left NULL:
    // the panel's project scope filters on it, and a span exported over OTLP
    // reaches a collector that has never heard of our `grp` table.
    const scope = {
      grpId: job.grp_id,
      sliceId: job.slice_id,
      projectId:
        job.grp_id === null
          ? null
          : (this.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(job.grp_id)
              ?.project_id ?? null),
    };
    // `withActiveSpan` is what makes the executor's spans children of this one.
    // Without it they would each come out a root and the trace would be a pile
    // of unrelated spans rather than a breakdown of where the job's time went.
    const p = requestContext
      .run(context, () => withActiveSpan(trace, () => this.exec({ ...job, state: "running" })))
      .then(() => {
        observeJob(job.kind, true, trace, scope);
        this.settle(job.id, "done");
      })
      .catch((error: unknown) => {
        observeJob(job.kind, false, trace, scope);
        this.settle(job.id, "failed", errText(error));
      })
      // `settle` writes to the database, so the handler above can throw as well —
      // a handle closed during shutdown, a job row that is no longer there. This
      // chain is detached, so an escape from it is an unhandled rejection that
      // surfaces against whatever happens to be running when it lands, with no
      // relationship to the job that caused it. There is nothing left to record
      // by then: the row this wanted to write to is the thing that is gone.
      .catch(() => {})
      .finally(() => {
        untrack(job.id, cancel);
        this.inflight.delete(job.id);
        // A finished job frees its slot and usually queues what comes next, and
        // nothing dispatched either. Sixteen `enqueue` sites had no `tick()`
        // after them and the omission looked exactly like the deliberate ones —
        // both waited for the watchdog timer, up to `watchdogIntervalMs`, on
        // work whose whole point was that something noticed it was stuck. The
        // watchdog is itself a job, so its own sweep queued into that wait too.
        //
        // Here rather than inside `enqueue`: staging a batch and dispatching it
        // in priority order is a real property, and an enqueue that dispatched
        // on the spot would send the first job before the second one exists.
        //
        // Guarded for the same reason the `catch` above it is: this chain is
        // detached, so it can land after the database is closed on shutdown, and
        // an escape from here surfaces against whatever happens to be running
        // with no relationship to the job that caused it.
        try {
          this.tick();
        } catch {}
      });
    this.inflight.set(job.id, p);
  }

  /** A job never stays in `running`: it always lands in a terminal state. */
  private settle(id: number, state: JobState, error?: string): void {
    this.db.run("UPDATE job SET state = ?, ended_at = ?, error = ? WHERE id = ? AND state = 'running'", [
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
function failOrphan(db: DB, row: RunningJob, endedAt: number, reason: string): Job | null {
  db.run(`UPDATE job SET state = 'failed', ended_at = ?, error = ? WHERE id = ? AND state = 'running'`, [
    endedAt,
    reason,
    row.id,
  ]);
  try {
    return { ...decodeJob(row), state: "failed", error: reason };
  } catch (error) {
    db.run("UPDATE job SET error = ? WHERE id = ?", [
      `invalid ${row.kind} payload: ${error instanceof Error ? error.message : String(error)}`,
      row.id,
    ]);
    return null;
  }
}

export function reclaimOrphans(
  db: DB,
  opts: { maxAgeMs?: number; alive?: (jobId: number) => boolean; now?: () => number } = {},
): Job[] {
  const maxAge = opts.maxAgeMs ?? 3_600_000;
  const now = opts.now ?? (() => Date.now());
  const alive = opts.alive ?? isRunning;

  const running = db
    .query<RunningJob, []>(
      `SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state, started_at,
              correlation_id, trace_id, parent_span_id
       FROM job WHERE state = 'running'`,
    )
    .all();

  const reclaimed: Job[] = [];
  let stopped = false;
  for (const j of running) {
    const tooOld = j.started_at !== null && now() - j.started_at > maxAge;
    if (!tooOld && alive(j.id)) continue;
    stopped = true;

    const why = tooOld
      ? `orphaned: still running after ${Math.round(maxAge / 60000)} min`
      : "orphaned: nothing is reading this turn any more";
    // The reason travels with the row: resumeReclaimed distinguishes a turn
    // that died by itself from one the server abandoned on shutdown.
    const job = failOrphan(db, j, now(), why);
    if (job) reclaimed.push(job);
  }

  // Agents believe they are mid-turn too, and a blocked agent is skipped forever.
  if (stopped) {
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
function reclaimedJob(row: Job | StoredJob): Job | null {
  try {
    return "payload" in row ? row : decodeJob(row);
  } catch {
    // Reclaimed rows are already terminal; malformed payloads cannot be replayed.
    return null;
  }
}

function resumeJob(sched: Scheduler, j: Job): boolean {
  if (FREE_KINDS.has(j.kind)) return false;
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
  if (j.payload.resumed && !orphaned) return false;
  // Every kind that reaches here resumes with its own payload plus the stamp:
  // the free kinds were filtered above, and gate/reconcile payloads are
  // `Resumable` only, so the spread loses nothing.
  sched.enqueue(j.kind, {
    grp_id: j.grp_id,
    agent_id: j.agent_id,
    slice_id: j.slice_id,
    priority: j.priority,
    ...(j.correlation_id === undefined ? {} : { correlationId: j.correlation_id }),
    ...(j.trace_id === undefined ? {} : { traceId: j.trace_id }),
    ...(j.parent_span_id === undefined ? {} : { parentSpanId: j.parent_span_id }),
    payload: { ...j.payload, resumed: true },
  });
  return true;
}

export function resumeReclaimed(sched: Scheduler, jobs: readonly (Job | StoredJob)[]): number {
  let requeued = 0;
  for (const row of jobs) {
    const job = reclaimedJob(row);
    if (job && resumeJob(sched, job)) requeued++;
  }
  return requeued;
}
