/**
 * Spans, in the same database as everything else they describe.
 *
 * A `SpanExporter`, **not** a `SpanProcessor`: `SpanProcessor.onEnd` runs inside
 * the operation being measured, so writing there makes tracing a tax on the thing
 * it observes, while `BatchSpanProcessor` supplies the queue, the drop policy, the
 * batching and the flush timer. Registered *beside* the OTLP processor.
 */

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { JsonObject, valueOr } from "../../contracts/json.ts";
import { and, asc, count, desc, eq, gte, isNull, lt, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DB } from "../persistence/database.ts";
import { grp, span } from "../persistence/schema.ts";
import { recordDroppedSpans } from "./metrics.ts";

/** One row of the `span` table, and the only shape that reaches the SQL. */
export interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  /** Epoch milliseconds. */
  startedAt: number;
  durationMs: number;
  status: "unset" | "ok" | "error";
  /** Why it failed, when it did. `null` on success and on an unset status. */
  statusMessage: string | null;
  attributes: Record<string, unknown>;
}

export interface StoredSpan extends SpanRow {
  projectId: number | null;
  grpId: number | null;
  sliceId: number | null;
}

/**
 * Retention, stated rather than left to grow, and sized to what is read.
 *
 * **A day, because a day is what the panel asks for** — `DEFAULT_WINDOW_MS` is 24
 * hours and the page says 「最近一天」. The row bound is not the history length: it is
 * the disaster bound, sized so it never decides how far back a reader can see, and
 * what it stops is a retry storm or a hot loop. Age plus count, as idempotency does.
 */
export const SPAN_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const SPAN_MAX_ROWS = 1_000_000;

function spanKindName(kind: SpanKind | undefined): string {
  switch (kind) {
    case SpanKind.SERVER:
      return "server";
    case SpanKind.CLIENT:
      return "client";
    case SpanKind.PRODUCER:
      return "producer";
    case SpanKind.CONSUMER:
      return "consumer";
    case SpanKind.INTERNAL:
    case undefined:
      return "internal";
  }
}

function spanStatusName(code: SpanStatusCode | number | undefined): SpanRow["status"] {
  if (code === SpanStatusCode.OK) return "ok";
  if (code === SpanStatusCode.ERROR) return "error";
  return "unset";
}

/**
 * The scope columns, read off the span's own attributes.
 *
 * Nullable because most spans belong to no project. An attribute that is not a
 * positive integer is treated as absent rather than coerced — a scope id guessed
 * from a string would aggregate somebody else's time into a group.
 */
function scopeId(attributes: Record<string, unknown>, key: string): number | null {
  const raw = attributes[key];
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function toSpanRow(span: ReadableSpan): SpanRow {
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: spanKindName(span.kind),
    startedAt: Math.round(hrTimeToMilliseconds(span.startTime)),
    durationMs: hrTimeToMilliseconds(span.duration),
    status: spanStatusName(span.status.code),
    // Only when it failed: OTel allows a message on any status, and one on a
    // successful span is a note nobody asked this table to keep.
    statusMessage: span.status.code === SpanStatusCode.ERROR ? (span.status.message ?? null) : null,
    attributes: { ...span.attributes },
  };
}

function values(row: SpanRow) {
  return {
    trace_id: row.traceId,
    span_id: row.spanId,
    parent_span_id: row.parentSpanId || null,
    name: row.name,
    kind: row.kind,
    started_at: row.startedAt,
    duration_ms: row.durationMs,
    status: row.status,
    status_message: row.statusMessage,
    // Validated on the way in as well as on the way out: an OTel attribute value
    // is whatever an instrumentation put there, and the column holds JSON.
    attributes_json: valueOr(row.attributes, JsonObject, {}),
    project_id: scopeId(row.attributes, "project.id"),
    grp_id: scopeId(row.attributes, "grp.id"),
    slice_id: scopeId(row.attributes, "slice.id"),
  };
}

/**
 * A bind parameter ceiling, not a tuning knob: Postgres takes 65,535 per
 * statement and each row spends thirteen. The receive route's batch is whatever
 * a client sent, so it is the one that can reach it.
 */
const INSERT_CHUNK = 1_000;

/**
 * `ON CONFLICT DO NOTHING` on the natural key, so ingest is idempotent by
 * construction.
 *
 * The same batch arriving twice writes the same rows, which is why the receive
 * route carries no `Idempotency-Key`: there is no second side effect to protect
 * against. One statement per chunk, and a statement is its own transaction.
 */
async function insertAll(db: DB, rows: readonly SpanRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db
      .insert(span)
      .values(rows.slice(i, i + INSERT_CHUNK).map(values))
      .onConflictDoNothing();
  }
}

/** The receive endpoint's way in, where one call is one HTTP request. */
export async function writeSpans(db: DB, rows: readonly SpanRow[]): Promise<void> {
  if (rows.length === 0) return;
  await insertAll(db, rows);
}

function decode(row: typeof span.$inferSelect): StoredSpan {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    statusMessage: row.status_message,
    status: row.status === "ok" || row.status === "error" ? row.status : "unset",
    // Stored JSON is data on the way back in, so it is parsed against a schema
    // rather than asserted into shape — the same rule the write path follows.
    attributes: valueOr(row.attributes_json, JsonObject, {}),
    projectId: row.project_id,
    grpId: row.grp_id,
    sliceId: row.slice_id,
  };
}

/**
 * A whole trace, oldest span first — the read the primary key exists for.
 *
 * `(trace_id, span_id)` leads with the trace, so this is a range scan over one
 * contiguous run of rows rather than a table scan with a filter.
 */
export async function readTrace(db: DB, traceId: string): Promise<StoredSpan[]> {
  const rows = await db
    .select()
    .from(span)
    .where(eq(span.trace_id, traceId))
    .orderBy(asc(span.started_at), asc(span.span_id));
  return rows.map(decode);
}

/**
 * Which work a read is asking about.
 *
 * `system` is not "everything": it is the work that belongs to no project, and it
 * is expressed as both scope columns being NULL rather than as an absent filter,
 * so the three scopes partition the table instead of overlapping.
 */
export type ReadScope = { kind: "group"; id: number } | { kind: "project"; id: number } | { kind: "system" };

/**
 * The scope predicate, built rather than spliced: every id below is a bind
 * parameter because it reaches the statement as one.
 *
 * `group` leads with `grp_id`, the first column of `span_scope`, so it is an index
 * range scan. `project` has no index of its own and leans on the window bound
 * through `span_age` — a deliberate omission, see `Window` below.
 */
function scopeWhere(scope: ReadScope): SQL {
  if (scope.kind === "system") return and(isNull(span.project_id), isNull(span.grp_id))!;
  if (scope.kind === "group") return eq(span.grp_id, scope.id);
  // A project's spans are the ones that say so **and** the ones belonging to one of
  // its groups, because most of them only say the latter: `turnScope` builds
  // `{ grpId, sliceId }` and no `projectId`, so `project_id` is NULL on every stage
  // span ever written. Resolved on read rather than at the writer — a writer fix
  // only labels spans written after it, while the rows already in the table stay
  // NULL forever. A span's project is not independent information, `grp.project_id`
  // already knows it. The writer may start setting the column too; this keeps working.
  return or(
    eq(span.project_id, scope.id),
    sql`${span.grp_id} IN (SELECT ${grp.id} FROM ${grp} WHERE ${grp.project_id} = ${scope.id})`,
  )!;
}

/** The scope, inside the window: every read below is bounded by both. */
const scoped = (scope: ReadScope, w: TimeWindow): SQL =>
  and(gte(span.started_at, w.from), lt(span.started_at, w.to), scopeWhere(scope))!;

/**
 * Nearest-rank percentile, from Postgres rather than from arithmetic here.
 *
 * `percentile_disc(p)` is the nearest-rank definition, so the ranked CTE this
 * replaced — `ROW_NUMBER()` and `COUNT()` over a partition, then a `MAX(CASE …)`
 * to pick the row out again — was a hand-rolled copy of an aggregate the engine
 * already has. Discrete, not `percentile_cont`: a reported latency has to be one
 * that was actually measured, never the average of two that were.
 */
const percentile = (p: number, column: SQLWrapper) =>
  sql`percentile_disc(${p}) WITHIN GROUP (ORDER BY ${column})`.mapWith(Number);

/**
 * Which stretch of time a read covers: two instants, not a duration.
 *
 * A length backwards from the present cannot express what a brush is for — with
 * the end pinned to `now`, only the start moves. The window is also what makes
 * these affordable: `span_age` indexes `started_at` alone, so a bounded range is a
 * scan the scope filter then narrows, and two bounds narrow it more than one.
 */
export interface TimeWindow {
  from: number;
  to: number;
}

/** The default: everything retention kept, ending now. */
export const recentWindow = (windowMs = SPAN_MAX_AGE_MS, now = Date.now()): TimeWindow => ({
  from: now - Math.min(windowMs, SPAN_MAX_AGE_MS),
  to: now,
});

/**
 * Bounded to retention, measured against the window's own end rather than the wall
 * clock: the bound is a property of the window, so it is computed from the window.
 * `Math.max(from, Date.now() - SPAN_MAX_AGE_MS)` pulls a caller with an injected
 * clock past its own end, and every query then returns nothing.
 */
const clamp = (w: TimeWindow): TimeWindow => ({ from: Math.max(w.from, w.to - SPAN_MAX_AGE_MS), to: w.to });

/** One stage — a span name — and what it cost across the scope. */
export interface StageStat {
  name: string;
  count: number;
  totalMs: number;
  p50: number;
  p95: number;
  errors: number;
  /**
   * Why the most recent failure failed, when there was one.
   *
   * A count answers "is this broken" and never "what do I do about it". The row
   * that prompted this said `index.ask` had failed 2,835 times, and finding out
   * that the reason was a missing credential took a query against the database —
   * which is the trip this panel exists to save.
   */
  reason: string | null;
}

/**
 * Where a scope's wall clock went, by stage, newest-costliest first.
 *
 * Grouped by span name, because that is what a stage *is* here. `totalMs` is a sum
 * over **overlapping** spans and is deliberately not presented as a share of
 * anything: `turn` contains `turn.provider`, so the column adds up to more than the
 * wall clock. It orders the list; the percentiles answer "is this slow".
 */
export async function stageStats(db: DB, scope: ReadScope, window: TimeWindow = recentWindow()): Promise<StageStat[]> {
  const bounds = clamp(window);
  const [reasons, rows] = await Promise.all([
    latestReasons(db, scope, bounds),
    db
      .select({
        name: span.name,
        count: count(),
        total_ms: sql`SUM(${span.duration_ms})`.mapWith(Number),
        p50: percentile(0.5, span.duration_ms),
        p95: percentile(0.95, span.duration_ms),
        errors: sql`COUNT(*) FILTER (WHERE ${span.status} = 'error')`.mapWith(Number),
      })
      .from(span)
      .where(scoped(scope, bounds))
      .groupBy(span.name)
      .orderBy(desc(sql`SUM(${span.duration_ms})`)),
  ]);
  return rows.map((row) => ({
    name: row.name,
    count: row.count,
    totalMs: row.total_ms,
    p50: row.p50,
    p95: row.p95,
    errors: row.errors,
    // Absent from the map is a stage that never failed, and a stored `null` is
    // a failure that carried no message. Both read as "nothing to explain".
    reason: reasons.get(row.name) ?? null,
  }));
}

/**
 * Why each failing stage failed last, by name — the *latest* failure rather than
 * the commonest, because a stage that has started working again should stop
 * explaining how it used to break.
 *
 * Its own query because it was a third window function, over the same rows as the
 * other two and partitioned and ordered differently from both. `DISTINCT ON` is
 * what Postgres offers instead: it ranks the error rows only — a fiftieth of the
 * table on the day this was measured — and keeps the first of each name.
 */
async function latestReasons(db: DB, scope: ReadScope, bounds: TimeWindow): Promise<Map<string, string | null>> {
  const rows = await db
    .selectDistinctOn([span.name], { name: span.name, status_message: span.status_message })
    .from(span)
    .where(and(scoped(scope, bounds), eq(span.status, "error")))
    .orderBy(asc(span.name), desc(span.started_at), desc(span.span_id));
  return new Map(rows.map((row) => [row.name, row.status_message]));
}

/** One slice of a requirement, and what its turns cost. */
export interface SliceCost {
  /** `null` is the requirement's own work: planning, the draft card, the roster. */
  sliceId: number | null;
  totalMs: number;
  count: number;
  errors: number;
}

/**
 * A requirement's wall clock, split by the slice that spent it.
 *
 * NULL is a row rather than a filter: planning turns, the draft card and the roster
 * belong to no slice, and dropping them makes the per-slice numbers add up to less
 * than the requirement's total. Only ever asked of a **group** — a project's slices
 * belong to different requirements and share only their sequence numbers.
 */
export async function sliceCosts(db: DB, grpId: number, window: TimeWindow = recentWindow()): Promise<SliceCost[]> {
  const bounds = clamp(window);
  const rows = await db
    .select({
      slice_id: span.slice_id,
      total_ms: sql`SUM(${span.duration_ms})`.mapWith(Number),
      count: count(),
      errors: sql`COUNT(*) FILTER (WHERE ${span.status} = 'error')`.mapWith(Number),
    })
    .from(span)
    .where(and(gte(span.started_at, bounds.from), lt(span.started_at, bounds.to), eq(span.grp_id, grpId)))
    .groupBy(span.slice_id)
    // NULLS LAST is Postgres's default for an ascending sort, and the slice-less
    // row belongs after the numbered ones.
    .orderBy(asc(span.slice_id));
  return rows.map((row) => ({ sliceId: row.slice_id, totalMs: row.total_ms, count: row.count, errors: row.errors }));
}

/** One trace, as much of it as belongs to the scope that asked. */
export interface TraceSummary {
  traceId: string;
  name: string;
  startedAt: number;
  durationMs: number;
  failed: boolean;
}

/**
 * The scope's recent traces, for picking one to open.
 *
 * `MAX(end) - MIN(start)` *within the scope* rather than a root span: `startChildTrace`
 * gives a turn a remote parent, so no span in a requirement's own scope has a NULL
 * parent. The name is the first span by `(started_at, span_id)`, ordered so it cannot
 * flap. One grouped pass, not two: the ranked version needed a `recent` CTE only
 * because a `LIMIT` cannot be pushed past a window function, and there is none left.
 */
export async function traceList(
  db: DB,
  scope: ReadScope,
  limit = 20,
  window: TimeWindow = recentWindow(),
): Promise<TraceSummary[]> {
  const bounds = clamp(window);
  const started = sql`MIN(${span.started_at})`;
  const rows = await db
    .select({
      trace_id: span.trace_id,
      name: sql`(array_agg(${span.name} ORDER BY ${span.started_at}, ${span.span_id}))[1]`.mapWith(String),
      started_at: sql`MIN(${span.started_at})`.mapWith(Number),
      duration_ms: sql`MAX(${span.started_at} + ${span.duration_ms}) - MIN(${span.started_at})`.mapWith(Number),
      errors: sql`COUNT(*) FILTER (WHERE ${span.status} = 'error')`.mapWith(Number),
    })
    .from(span)
    .where(scoped(scope, bounds))
    .groupBy(span.trace_id)
    .orderBy(desc(started), desc(span.trace_id))
    .limit(limit);
  return rows.map((row) => ({
    traceId: row.trace_id,
    name: row.name,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    failed: row.errors > 0,
  }));
}

/**
 * One call path across the whole scope, and what it cost.
 *
 * `path` is the span names from the root down, `;`-separated — the folded-stack
 * format flamegraphs have consumed since the original Perl ones, which is why it
 * is the shape produced here rather than a nested object.
 */
export interface FoldedStack {
  path: string;
  totalMs: number;
  count: number;
}

/**
 * How deep the walk will follow parent links.
 *
 * **Not** what stops a cycle hanging the query — every span has at most one parent,
 * so the part of the graph reachable from a root is a tree by construction. What it
 * bounds is depth: each level concatenates another name onto a path string, so a
 * runaway-deep trace costs quadratic text. The deepest this system emits is four.
 */
const MAX_STACK_DEPTH = 64;

/** Span ids are unique only within a trace, so the key is the pair. */
const spanKey = (traceId: string, spanId: string) => `${traceId} ${spanId}`;

/**
 * Every call path in the scope, summed — the flamegraph's data.
 *
 * A root is a span whose parent is absent *from the scope* rather than NULL:
 * anchoring on NULL returns nothing at all. The parent is resolved against the
 * scoped rows themselves — the self-join this replaced keyed on `rowid`, which
 * Postgres does not have, and it was already filtered a second time in JS by
 * whether the parent came back in the scoped set. **Folded here rather than in
 * SQL**, this file's one exception: a tree walk has no index to stand on.
 */
export async function foldedStacks(
  db: DB,
  scope: ReadScope,
  window: TimeWindow = recentWindow(),
): Promise<FoldedStack[]> {
  const bounds = clamp(window);
  const rows = await db
    .select({
      trace_id: span.trace_id,
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      name: span.name,
      duration_ms: span.duration_ms,
    })
    .from(span)
    .where(scoped(scope, bounds));

  type FoldRow = (typeof rows)[number];
  const byId = new Map(rows.map((row) => [spanKey(row.trace_id, row.span_id), row]));
  const paths = new Map<string, string>();
  const walking = new Set<string>();

  /**
   * A span's ancestry, or as much of it as the scope can establish.
   *
   * Three things end the walk and all three mean the same thing — no parent id, a
   * parent outside the scope, a cycle — so all three produce a root. `walking` is the
   * cycle case: without it a ring recurses to the depth cap and emits a path
   * repeating the ring sixty-four times. Every span is still counted exactly once.
   */
  const pathOf = (row: FoldRow, depth: number): string => {
    const id = spanKey(row.trace_id, row.span_id);
    const known = paths.get(id);
    if (known !== undefined) return known;
    const parent = row.parent_span_id === null ? undefined : byId.get(spanKey(row.trace_id, row.parent_span_id));
    // The cycle test is on the *parent*, not on this span: stopping when we are
    // about to re-enter a span already on the stack ends the ring one step
    // before it repeats a name, where testing self emits `a;b;a`.
    const stop = !parent || depth >= MAX_STACK_DEPTH || walking.has(spanKey(parent.trace_id, parent.span_id));
    if (stop) {
      // Memoised like any other answer, so a span whose ancestry cannot be
      // established is a root once rather than a different root depending on
      // which row happened to reach it first.
      paths.set(id, row.name);
      return row.name;
    }
    walking.add(id);
    const path = `${pathOf(parent, depth + 1)};${row.name}`;
    walking.delete(id);
    paths.set(id, path);
    return path;
  };

  const folded = new Map<string, FoldedStack>();
  for (const row of rows) {
    const path = pathOf(row, 0);
    const seen = folded.get(path);
    if (seen) {
      seen.totalMs += row.duration_ms;
      seen.count += 1;
    } else {
      folded.set(path, { path, totalMs: row.duration_ms, count: 1 });
    }
  }
  return [...folded.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One bucket of the trend: when, how many, and how long they took. */
export interface TrendPoint {
  at: number;
  count: number;
  p50: number;
  p95: number;
}

/** An aggregate over no rows is NULL, and NULL is the answer rather than zero. */
const maybeNumber = (value: unknown): number | null => (value === null ? null : Number(value));

/**
 * The first and last instant this scope has a span for.
 *
 * Different from the window a read was asked for: a pan clamped to the *requested*
 * window can walk into stretches the store has nothing in, and the reader cannot
 * tell "nothing happened" from "you have scrolled off the end". Clamped to retention
 * like every other read. `null` when the scope has no spans — not a zero-width one.
 */
export async function spanExtent(db: DB, scope: ReadScope, now = Date.now()): Promise<TimeWindow | null> {
  const [row] = await db
    .select({
      first: sql`MIN(${span.started_at})`.mapWith(maybeNumber),
      last: sql`MAX(${span.started_at} + ${span.duration_ms})`.mapWith(maybeNumber),
    })
    .from(span)
    .where(and(gte(span.started_at, now - SPAN_MAX_AGE_MS), scopeWhere(scope)));
  if (!row || row.first === null || row.last === null) return null;
  // A single span makes first and last equal, and a zero-width window is not a
  // range anything can be clamped inside. One second is the smallest span the
  // rest of this module considers a window at all.
  return { from: row.first, to: Math.max(row.last, row.first + 1_000) };
}

export async function trend(
  db: DB,
  scope: ReadScope,
  bucketMs = 60 * 60 * 1_000,
  window: TimeWindow = recentWindow(),
): Promise<TrendPoint[]> {
  const bounds = clamp(window);
  // One row per trace: the trend is about traces, and a trace's wall clock is the
  // stretch its spans cover rather than the sum of their durations.
  const perTrace = db
    .select({
      started_at: sql<number>`MIN(${span.started_at})`.as("started_at"),
      wall: sql<number>`MAX(${span.started_at} + ${span.duration_ms}) - MIN(${span.started_at})`.as("wall"),
    })
    .from(span)
    .where(scoped(scope, bounds))
    .groupBy(span.trace_id)
    .as("per_trace");
  // Integer division, which is what `bigint / bigint` already is here. Grouped and
  // ordered by output position rather than by a second copy of the expression:
  // Postgres matches a GROUP BY expression to a SELECT one syntactically, and the
  // two copies carry different bind parameters, so it sees two different bucketings.
  const at = sql`(${perTrace.started_at} / ${bucketMs}::bigint) * ${bucketMs}::bigint`;
  const rows = await db
    .select({
      // any-order: `at` is bucket * width and the bucket is the GROUP BY key, so
      // there is one row per value and nothing to tie. It reads like a clock and
      // is an index into the buckets.
      at: at.mapWith(Number),
      count: count(),
      p50: percentile(0.5, perTrace.wall),
      p95: percentile(0.95, perTrace.wall),
    })
    .from(perTrace)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((row) => ({ at: row.at, count: row.count, p50: row.p50, p95: row.p95 }));
}

/**
 * Drop what is older than the age bound, then whatever still exceeds the row
 * bound. `maxRows` is a parameter only so a test can prove the second delete.
 *
 * Called from the server's heartbeat, never from the write path: retention is
 * housekeeping on a schedule, and a span arriving is not a reason to run it.
 */
export async function trimSpans(db: DB, now = Date.now(), maxRows = SPAN_MAX_ROWS): Promise<void> {
  await db.delete(span).where(lt(span.started_at, now - SPAN_MAX_AGE_MS));
  // By the natural key, because Postgres has no `rowid` and `ctid` moves under the
  // vacuum this delete makes likely. A row-value `IN` is the one predicate shape
  // `inArray` cannot build, so it is written out.
  const surplus = db
    .select({ trace_id: span.trace_id, span_id: span.span_id })
    .from(span)
    .orderBy(desc(span.started_at), desc(span.span_id))
    .offset(maxRows);
  await db.delete(span).where(sql`(${span.trace_id}, ${span.span_id}) IN (${surplus})`);
}

/**
 * The destination. `BatchSpanProcessor` owns everything around it.
 *
 * `export` is handed a whole batch off the SDK's flush timer, so it runs outside
 * the operation being traced. The batch is written before `done` is called, which
 * is what a callback rather than a return value is for.
 */
export class StoredSpanExporter implements SpanExporter {
  readonly #db: DB;
  #closed = false;

  constructor(db: DB) {
    this.#db = db;
  }

  /**
   * Losing spans is never a reason to fail the flush that carried them.
   *
   * `BatchSpanProcessor` turns a `FAILED` result into a rejected promise, so
   * reporting one here turns a closed database into a failed shutdown — and it buys
   * nothing, since the processor does not retry. The loss is reported through
   * `orchestrator_telemetry_dropped_total`, which the OTLP side already uses.
   */
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    // `shutdownTracing` swaps in a fresh provider before closing this one, so a
    // late flush can arrive after the database handle is gone.
    if (this.#closed) {
      recordDroppedSpans(spans.length);
      done({ code: ExportResultCode.SUCCESS });
      return;
    }
    void (async () => {
      try {
        await insertAll(this.#db, spans.map(toSpanRow));
      } catch {
        recordDroppedSpans(spans.length);
      }
      done({ code: ExportResultCode.SUCCESS });
    })();
  }

  // `forceFlush` is optional on `SpanExporter` and is deliberately not
  // implemented: every batch is written inside `export`, so there is never
  // anything buffered here to flush. The queue that does need draining belongs to
  // `BatchSpanProcessor`, and its own `forceFlush` drains it.

  shutdown(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
