import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { writeHandle } from "../../platform/persistence/database.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { JsonValue, valueOr } from "../../contracts/json.ts";
import {
  agent,
  grp,
  job as jobTable,
  lease,
  resource,
  runtime_auth,
  slice,
  usage_snapshot,
} from "../../platform/persistence/schema.ts";
import { isRunning, track, untrack } from "../../platform/process/running-turns.ts";
import { type GrpState, isDispatchableGrpState, type JobState } from "../../contracts/states.ts";
import { requestContext } from "../../platform/observability/request-context.ts";
import { observeJob } from "../../platform/observability/metrics.ts";
import { startChildTrace, withActiveSpan } from "../../platform/observability/traces.ts";
import { errText } from "../../platform/process/text.ts";
import type { Json } from "../../contracts/json.ts";

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
  payload_json: Json;
  priority: number;
  state: JobState;
  error?: string | null;
  correlation_id?: string | null;
  trace_id?: string | null;
  parent_span_id?: string | null;
  trace_flags?: number | null;
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
    // Null when there is no ambient request: `startChildTrace` reads that as sampled,
    // which is what a job with no parent to inherit from should be.
    traceFlags: context?.traceFlags ?? null,
  };
}

function decodeJob(row: StoredJob): Job {
  const kind = JobKindSchema.parse(row.kind);
  // `payload_json` is `jsonb`, so the driver has already parsed it.
  const raw: unknown = row.payload_json;
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

/** The columns every dispatch read needs, named once so the two agree. */
const JOB_FIELDS = {
  id: jobTable.id,
  kind: jobTable.kind,
  grp_id: jobTable.grp_id,
  agent_id: jobTable.agent_id,
  slice_id: jobTable.slice_id,
  payload_json: jobTable.payload_json,
  priority: jobTable.priority,
  state: jobTable.state,
  correlation_id: jobTable.correlation_id,
  trace_id: jobTable.trace_id,
  parent_span_id: jobTable.parent_span_id,
};

/** Why a stored payload could not be decoded, in the one wording both writers use. */
const payloadError = (kind: string, error: unknown): string =>
  `invalid ${kind} payload: ${error instanceof Error ? error.message : String(error)}`;

export interface SchedulerOptions {
  /** Max groups with an in-flight agent_turn. Default 3 (see docs/project/plan.md §11). */
  maxGroups?: number | (() => number);
  /**
   * Slots for the Runner pool, per resource tag. Leases never consume group slots.
   *
   * A plain number is the whole pool; a map is one pool per tag, with `default`
   * covering untagged resources. Pool size is a property of what the resource
   * contends for: a headless browser wants 1, `typecheck` wants a core each, and
   * one global number could only be the minimum, which starves everything else.
   */
  leaseSlots?: number | Record<string, number> | (() => number | Record<string, number> | undefined);
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
   * The fourth gate of the same shape and the first that is **per project**: one
   * project's revoked access must not stop another. Awaited, unlike the three
   * above, because it is an in-memory map plus one primary-key read beside three
   * the admission check already awaits — not the probe those refuse to block on.
   */
  repoHeld?: (projectId: number) => boolean | Promise<boolean>;
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
 * Roles DRAFT does not block.
 *
 * DRAFT means "the card is written, stop spending until the boss says go", which
 * is about the writers. Applied to every role it deadlocked: a refused approval
 * enqueues an Architect turn to cut the boundary, the group is in DRAFT, so that
 * turn never ran and the boss was told to click again. Three groups at once.
 */
const PLANNING_ROLES = new Set(["dispatcher", "architect", "cos", "librarian"]);

/**
 * Group statuses that allow dispatching an agent_turn.
 *
 * PLANNING is dispatchable and DRAFT is not: the Dispatcher has to run *before*
 * the boss can approve anything, so "planning the work" and "waiting for the
 * boss" cannot be one state. Everything else is a barrier — PAUSING/PAUSED
 * (intercept L2), PARKED, and DRAFT except for the roles above.
 */
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
 * For a group it is the group — the "one writer per group" rule, with the L2
 * barrier falling out of it. A group-less job belongs to a standing agent, keyed
 * **negative** so it can never collide with a group id: the four standing roles
 * run in parallel, each serialised against itself, all counting to `maxGroups`.
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
  private readonly repoHeld: (projectId: number) => boolean | Promise<boolean>;
  private ticking: Promise<void> | undefined;
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

  async enqueue<K extends JobKind>(kind: K, fields: EnqueueFields<K> = {}): Promise<number> {
    // A closed queue writes nothing. `0` is not an id any row has.
    if (!this.accepting) return 0;
    const payload = JobPayloadSchemas[kind].parse(fields.payload ?? {});
    const trace = enqueueTrace(fields);
    // The open transaction when there is one: a job enqueued inside a transaction
    // that then rolls back is work nobody asked for, and on the single-connection
    // driver writing round it deadlocks.
    const [row] = await writeHandle(this.db)
      .insert(jobTable)
      .values({
        kind,
        grp_id: fields.grp_id ?? null,
        agent_id: fields.agent_id ?? null,
        slice_id: fields.slice_id ?? null,
        // The column is `jsonb`, so the validated payload goes in as a value.
        payload_json: JsonValue.parse(payload),
        priority: fields.priority ?? 0,
        enqueued_at: this.now(),
        correlation_id: trace.correlationId,
        trace_id: trace.traceId,
        parent_span_id: trace.parentSpanId,
        trace_flags: trace.traceFlags,
      })
      .returning({ id: jobTable.id });
    return row!.id;
  }

  /**
   * Dispatch everything currently eligible. Safe to call often.
   *
   * Queued behind whatever tick is already running rather than dropped, and the
   * caller waits for its own sweep. Dispatch became asynchronous, so two ticks
   * overlapping is now the ordinary case — a finished job ticks from a detached
   * chain while `drain` is between rounds — and the old "already running, return"
   * guard made `drain` return with a dispatchable job still `pending`.
   */
  tick(): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    const next = (this.ticking ?? Promise.resolve()).then(() => this.sweep());
    // The sequencing handle must never reject: the next caller's sweep runs after
    // this one whether or not it threw. The caller still gets the failure.
    this.ticking = next.catch(() => {});
    return next;
  }

  private async sweep(): Promise<void> {
    const idle = this.inflight.size === 0;
    const ready = await this.eligible();
    for (const job of ready) await this.start(job);
    // A sweep that found nothing *while nothing was running* is the only proof
    // the queue is empty: one that found nothing because the pool was full says
    // the opposite. `drain` reads this and nothing else does.
    this.quiet = idle && ready.length === 0;
  }

  private quiet = false;

  /**
   * Stop admitting work. In-flight jobs settle; nothing new is queued or run.
   *
   * A finished job enqueues its follow-up and ticks from a detached `.finally`,
   * so a scheduler nobody holds any more keeps writing — into a handle that is
   * closing at shutdown, and into the next test's database in a suite. Closing
   * the queue is what makes an abandoned one inert rather than merely idle.
   */
  quiesce(): void {
    this.accepting = false;
  }

  /**
   * Resolve once every in-flight job has settled and nothing new is eligible.
   *
   * It waits for a sweep that found nothing *while nothing was running*. A job
   * can finish between a sweep and the check, so "no work in flight" on its own
   * returned with the follow-up still `pending` — the pool had been full when
   * the last sweep looked, which is the opposite of an empty queue.
   */
  async drain(): Promise<void> {
    this.quiet = false;
    for (;;) {
      await this.tick();
      if (this.quiet) return;
      // A closed queue never goes quiet, because `tick` stops sweeping, so
      // waiting for proof it is empty would spin. What is running still has to
      // settle — that is what `quiesce` promises — but nothing can arrive behind
      // it, so an empty one is the end.
      if (!this.accepting && this.inflight.size === 0) return;
      if (this.inflight.size > 0) await Promise.race(this.inflight.values()).catch(() => {});
    }
  }

  /** park / respec: drop a group's queued work without touching what is running. */
  async cancelPending(grpId: number, reason = "cancelled"): Promise<number> {
    // `.returning()` rather than a driver row count: `DB` is either driver and the
    // two do not report one under the same name.
    // The open transaction, for the reason `enqueue` gives: cancelling inside one
    // that then rolls back must not leave the cancellation behind, and writing
    // round it deadlocks on the single-connection driver.
    const cancelled = await writeHandle(this.db)
      .update(jobTable)
      .set({ state: "cancelled", ended_at: this.now(), error: reason })
      .where(and(eq(jobTable.grp_id, grpId), eq(jobTable.state, "pending")))
      .returning({ id: jobTable.id });
    return cancelled.length;
  }

  /**
   * Jobs that may start right now, in dispatch order.
   *
   * A **batch** decision, not a filter: `busyGroups` and `taken` are mutated as
   * the loop admits each job, so the Nth job's admission depends on the previous
   * N−1 — a check before dequeue rather than a property of an edge, which is why
   * this is not a workflow engine (ADR 003). `claimCapacity` holds the rules.
   */
  private async eligible(): Promise<Job[]> {
    const rows = await this.db
      .select(JOB_FIELDS)
      .from(jobTable)
      .where(eq(jobTable.state, "pending"))
      .orderBy(desc(jobTable.priority), asc(jobTable.id));
    if (rows.length === 0) return [];
    const pending = await this.decode(rows);

    // Standing agents (Architect, CoS, Librarian) have no group, but their turns
    // cost the same money and CPU as anyone's — so they take a slot too. Letting
    // them bypass the pool was how a "no slots" configuration still spawned agents.
    // Running first, because what a lease draws from is looked up for both sets
    // and the load below is one wave over the union.
    const running = await this.runningJobs();
    await this.load(pending, running);
    const { busyGroups, taken } = this.capacity(running);

    const out: Job[] = [];
    for (const job of pending) {
      if (await this.claimCapacity(job, busyGroups, taken)) out.push(job);
    }
    return out;
  }

  private async claimCapacity(job: Job, busyGroups: Set<number>, taken: Record<string, number>): Promise<boolean> {
    if (job.kind === "lease") return this.claimLeaseCapacity(job, taken);
    if (FREE_KINDS.has(job.kind)) return true;
    return this.claimWriterCapacity(job, busyGroups);
  }

  private async claimWriterCapacity(job: Job, busyGroups: Set<number>): Promise<boolean> {
    const slot = slotOf(job);
    if (!this.writerSlotAvailable(slot, busyGroups)) return false;
    if (!this.groupAdmitsJob(job) || !(await this.jobReady(job))) return false;
    busyGroups.add(slot);
    return true;
  }

  private groupAdmitsJob(job: Job): boolean {
    return job.grp_id === null || this.admits(job);
  }

  private async jobReady(job: Job): Promise<boolean> {
    return job.kind !== "agent_turn" || (await this.agentTurnReady(job));
  }

  private capacity(running: readonly Job[]): { busyGroups: Set<number>; taken: Record<string, number> } {
    const busyGroups = new Set<number>();
    const taken: Record<string, number> = {};
    for (const job of running) {
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

  private async agentTurnReady(job: Job<"agent_turn">): Promise<boolean> {
    if (!this.online() || !this.sandboxReady()) return false;
    // Two of the three answer from the tick's own maps now; the third is an
    // injected callback that reads a table this scheduler does not own, so it
    // stays a call — memoised per project rather than per job.
    return !this.providerHeld(job) && !this.credentialMissing(job) && !(await this.repoLockedOut(job));
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
    const row = this.leaseRows.get(leaseId);
    const tags = valueOr(row?.tags_json, z.array(z.string()), []);
    if (!tags.length) return [DEFAULT_POOL];
    // `repo` is one pool per repository, not one pool globally: two projects'
    // gates have nothing to race over, and serialising them would make every
    // extra project slower for nothing. See the tag's comment in api.ts.
    return tags.map((t) => (t === REPO_POOL ? `${REPO_POOL}:${row?.project_id ?? 0}` : t));
  }

  private async runningJobs(): Promise<Job[]> {
    return this.decode(await this.db.select(JOB_FIELDS).from(jobTable).where(eq(jobTable.state, "running")));
  }

  /** Invalid persisted control data is a failed job, never an omitted instruction. */
  private async decode(rows: StoredJob[]): Promise<Job[]> {
    const jobs: Job[] = [];
    for (const row of rows) {
      try {
        jobs.push(decodeJob(row));
      } catch (error) {
        await this.db
          .update(jobTable)
          .set({ state: "failed", ended_at: this.now(), error: payloadError(row.kind, error) })
          .where(and(eq(jobTable.id, row.id), eq(jobTable.state, row.state)));
      }
    }
    return jobs;
  }

  /**
   * Is this turn's provider out of quota right now?
   *
   * A rate limit is an account-level fact, so it holds every agent on that CLI,
   * standing ones included. Holding rather than failing keeps it free: a held job
   * is never picked up, so no process, no retry loop, no quota spent proving the
   * wall. Lifts by the CLI's own reset clock; an unhired job has no provider yet.
   */
  private providerHeld(job: Job<"agent_turn">): boolean {
    const runtime = job.agent_id === null ? undefined : this.agentRuntime.get(job.agent_id);
    if (runtime === undefined) return false;
    const until = this.holdUntil.get(runtime);
    return !!until && until > this.now();
  }

  /**
   * Is there a credential for this turn's provider at all?
   *
   * Same shape as a rate-limit hold and for the same reason: without it every
   * group spends a turn discovering the wall one at a time, and the only sign is
   * a queue of failures that all say 401. An unhired job has not chosen a
   * provider, so the question becomes whether *any* credential exists.
   */
  private credentialMissing(job: Job<"agent_turn">): boolean {
    const runtime = job.agent_id === null ? undefined : this.agentRuntime.get(job.agent_id);
    return runtime === undefined ? this.credentialled.size === 0 : !this.credentialled.has(runtime);
  }

  /**
   * Has GitHub locked this turn's project out?
   *
   * Only `agent_turn`, like `online` and `sandboxReady`: a lease is a gate or a
   * typecheck in the group's own container and mostly needs no network, so
   * holding those would stop work that would have succeeded. A job with no group
   * belongs to no project — defaulting to held would stop housekeeping.
   */
  private async repoLockedOut(job: Job<"agent_turn">): Promise<boolean> {
    if (!job.grp_id) return false;
    // The group's project comes off the tick's own map; `load` already read these
    // rows and now selects the column too.
    const row = this.grpRows.get(job.grp_id);
    if (!row) return false;
    // `repoHeld` reads `project.remote` before it consults its in-memory holds,
    // so it is a statement per call — and every pending turn of one project asks
    // it the same question. Memoised for the tick, the same lifetime and for the
    // same reason as `grpRows`: the hold moves, so nothing here outlives the tick.
    const known = this.repoHolds.get(row.project_id);
    if (known !== undefined) return known;
    const held = await this.repoHeld(row.project_id);
    this.repoHolds.set(row.project_id, held);
    return held;
  }

  /** Admission check: group status is a barrier, budget is a hard stop. */
  private admits(job: Job): boolean {
    return this.groupAdmits(job) && this.sliceAdmits(job);
  }

  /**
   * Everything this tick's queue names, in one wave.
   *
   * Groups and slices were already batched here, from pg-boss's `ignoreGroups`.
   * The rest of the admission check never followed: a pending `agent_turn` asked,
   * one at a time, which provider its agent runs on, whether that provider is
   * held, whether a credential exists for it, and which project its group is in —
   * four statements a job, so five hundred queued turns were two thousand
   * statements before one of them started. A lease asked a fifth, twice.
   */
  /**
   * Five now, whatever the depth. `usage_snapshot` and `runtime_auth` hold one
   * row per provider, so both are read entire rather than filtered.
   *
   * Held for one `eligible()` call only: a cache outliving the tick would be a
   * second copy of these tables, and the check exists because those rows move.
   */
  private async load(pending: readonly Job[], running: readonly Job[]): Promise<void> {
    const ids = <K extends "grp_id" | "slice_id" | "agent_id">(jobs: readonly Job[], key: K): number[] => [
      ...new Set(jobs.map((j) => j[key]).filter((id): id is number => id !== null)),
    ];
    const grpIds = ids(pending, "grp_id");
    const sliceIds = ids(pending, "slice_id");
    // Only the turns need an agent's provider, and only if there are any: a queue
    // of leases must not pay for three statements about credentials.
    const turns = pending.some((j) => j.kind === "agent_turn");
    const agentIds = turns ? ids(pending, "agent_id") : [];
    const leaseIds = [
      ...new Set(
        [...pending, ...running].flatMap((j) => (j.kind === "lease" ? [j.payload.lease_id ?? 0] : [])).filter(Boolean),
      ),
    ];
    const [grpRows, sliceRows, agentRows, holds, credentials, leaseRows] = await Promise.all([
      grpIds.length === 0
        ? []
        : this.db
            .select({
              id: grp.id,
              status: grp.status,
              budget_tokens: grp.budget_tokens,
              spent_tokens: grp.spent_tokens,
              // For `repoLockedOut`, which read this one group at a time.
              project_id: grp.project_id,
            })
            .from(grp)
            .where(inArray(grp.id, grpIds)),
      sliceIds.length === 0
        ? []
        : this.db
            .select({ id: slice.id, budget_tokens: slice.budget_tokens, spent_tokens: slice.spent_tokens })
            .from(slice)
            .where(inArray(slice.id, sliceIds)),
      agentIds.length === 0
        ? []
        : this.db.select({ id: agent.id, runtime: agent.runtime }).from(agent).where(inArray(agent.id, agentIds)),
      turns
        ? this.db
            .select({ runtime: usage_snapshot.runtime, hold_until: usage_snapshot.hold_until })
            .from(usage_snapshot)
        : [],
      turns ? this.db.select({ runtime: runtime_auth.runtime }).from(runtime_auth) : [],
      leaseIds.length === 0
        ? []
        : this.db
            .select({ id: lease.id, tags_json: resource.tags_json, project_id: grp.project_id })
            .from(lease)
            .innerJoin(resource, eq(resource.name, lease.resource))
            .leftJoin(grp, eq(grp.id, lease.grp_id))
            .where(inArray(lease.id, leaseIds)),
    ]);
    this.grpRows = new Map(grpRows.map((r) => [r.id, r]));
    this.sliceRows = new Map(sliceRows.map((r) => [r.id, r]));
    this.agentRuntime = new Map(agentRows.map((r) => [r.id, r.runtime]));
    this.holdUntil = new Map(holds.map((r) => [r.runtime, r.hold_until]));
    this.credentialled = new Set(credentials.map((r) => r.runtime));
    this.leaseRows = new Map(leaseRows.map((r) => [r.id, r]));
    this.repoHolds.clear();
  }

  private grpRows = new Map<
    number,
    { status: GrpState; budget_tokens: number | null; spent_tokens: number; project_id: number }
  >();
  private sliceRows = new Map<number, { budget_tokens: number | null; spent_tokens: number }>();
  private agentRuntime = new Map<number, string>();
  private holdUntil = new Map<string, number | null>();
  private credentialled = new Set<string>();
  private leaseRows = new Map<number, { tags_json: Json; project_id: number | null }>();
  private repoHolds = new Map<number, boolean>();

  private groupAdmits(job: Job): boolean {
    const grp = this.grpRows.get(job.grp_id!);
    if (!grp) return false;
    return groupStateAdmits(grp.status, job) && hasBudget(grp);
  }

  private sliceAdmits(job: Job): boolean {
    if (job.slice_id === null) return true;
    const slice = this.sliceRows.get(job.slice_id);
    // Budget is per-slice so overspend is caught early, not at group level.
    return !slice || hasBudget(slice);
  }

  private async start(job: Job): Promise<void> {
    const claimed = await this.db
      .update(jobTable)
      .set({ state: "running", started_at: this.now() })
      .where(and(eq(jobTable.id, job.id), eq(jobTable.state, "pending")))
      .returning({ id: jobTable.id });
    if (claimed.length === 0) return; // someone else took it

    const trace = startChildTrace(job.trace_id, job.parent_span_id, job.trace_flags);
    const lifecycle = new AbortController();
    const cancel = () => lifecycle.abort(new Error(`job ${job.id} cancelled`));
    track(job.id, cancel);
    const context = {
      requestId: job.correlation_id ?? crypto.randomUUID(),
      traceId: trace.traceId,
      spanId: trace.spanId,
      traceFlags: trace.span.spanContext().traceFlags,
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
    const owning =
      job.grp_id === null
        ? []
        : await this.db.select({ project_id: grp.project_id }).from(grp).where(eq(grp.id, job.grp_id));
    const scope = { grpId: job.grp_id, sliceId: job.slice_id, projectId: owning[0]?.project_id ?? null };
    // `withActiveSpan` is what makes the executor's spans children of this one.
    // Without it they would each come out a root and the trace would be a pile
    // of unrelated spans rather than a breakdown of where the job's time went.
    const p = requestContext
      .run(context, () => withActiveSpan(trace, () => this.exec({ ...job, state: "running" })))
      .then(async () => {
        observeJob(job.kind, true, trace, scope);
        await this.settle(job.id, "done");
      })
      .catch(async (error: unknown) => {
        observeJob(job.kind, false, trace, scope);
        await this.settle(job.id, "failed", errText(error));
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
        // nothing dispatched either: sixteen `enqueue` sites had no `tick()`, so
        // the work waited on the watchdog timer — and the watchdog is itself a
        // job, so its own sweep queued into that wait. Here rather than inside
        // `enqueue`, because staging a batch and dispatching it in priority order
        // is a real property and an on-the-spot enqueue would send the first job
        // before the second exists. Guarded like the `catch` above it: this chain
        // is detached and can land after the database is closed on shutdown.
        void this.tick().catch(() => {});
      });
    this.inflight.set(job.id, p);
  }

  /** A job never stays in `running`: it always lands in a terminal state. */
  private async settle(id: number, state: JobState, error?: string): Promise<void> {
    await this.db
      .update(jobTable)
      .set({ state, ended_at: this.now(), error: error ?? null })
      .where(and(eq(jobTable.id, id), eq(jobTable.state, "running")));
  }
}

/**
 * Reclaim jobs left `running` by a server that is no longer here.
 *
 * A `running` job holds its group's only slot, so a crash wedges the group
 * silently. An orphan is a job nothing is reading, or one running longer than any
 * turn may — liveness is the stream, not a process table, since the CLI is not
 * our child. Returned so the caller can requeue: the slot alone is not enough.
 */
async function failOrphan(db: DB, row: RunningJob, endedAt: number, reason: string): Promise<Job | null> {
  await db
    .update(jobTable)
    .set({ state: "failed", ended_at: endedAt, error: reason })
    .where(and(eq(jobTable.id, row.id), eq(jobTable.state, "running")));
  try {
    return { ...decodeJob(row), state: "failed", error: reason };
  } catch (error) {
    await db
      .update(jobTable)
      .set({ error: payloadError(row.kind, error) })
      .where(eq(jobTable.id, row.id));
    return null;
  }
}

export async function reclaimOrphans(
  db: DB,
  opts: { maxAgeMs?: number; alive?: (jobId: number) => boolean; now?: () => number } = {},
): Promise<Job[]> {
  const maxAge = opts.maxAgeMs ?? 3_600_000;
  const now = opts.now ?? (() => Date.now());
  const alive = opts.alive ?? isRunning;

  const running = await db
    .select({ ...JOB_FIELDS, started_at: jobTable.started_at })
    .from(jobTable)
    .where(eq(jobTable.state, "running"));

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
    const job = await failOrphan(db, j, now(), why);
    if (job) reclaimed.push(job);
  }

  // Agents believe they are mid-turn too, and a blocked agent is skipped forever.
  if (stopped) {
    await db.update(agent).set({ state: "idle" }).where(eq(agent.state, "running"));
  }
  return reclaimed;
}

/**
 * Put reclaimed turns back, so a restart costs one turn rather than the group.
 *
 * The slice is left where it was and the same role is re-queued on it: whatever
 * the killed turn wrote is still in the worktree, which is the `keep` half of
 * intercept reached from the other direction. `resumed` is stamped on the payload
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

async function resumeJob(sched: Scheduler, j: Job): Promise<boolean> {
  if (FREE_KINDS.has(j.kind)) return false;
  // `resumed` stops a turn that takes the server down with it from being
  // resurrected forever — but an orphan died because the *server* went away, not
  // because of anything it did, and must not spend its one chance. Six groups sat
  // stopped after a restart, each needing a human to say "go on then". `offline:`
  // is the same argument: the network went away, the turn did nothing wrong.
  const orphaned = /^(orphaned|offline):/.test(j.error ?? "");
  if (j.payload.resumed && !orphaned) return false;
  // Every kind that reaches here resumes with its own payload plus the stamp:
  // the free kinds were filtered above, and gate/reconcile payloads are
  // `Resumable` only, so the spread loses nothing.
  await sched.enqueue(j.kind, {
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

export async function resumeReclaimed(sched: Scheduler, jobs: readonly (Job | StoredJob)[]): Promise<number> {
  let requeued = 0;
  for (const row of jobs) {
    const job = reclaimedJob(row);
    if (job && (await resumeJob(sched, job))) requeued++;
  }
  return requeued;
}
