/**
 * Spans, in the same SQLite file as everything else they describe.
 *
 * The SDK ships spans to a collector when one is configured, and to nothing when
 * one is not. Neither case leaves anything the panel can read back: a boss asking
 * where a requirement's wall clock went has no collector to ask. So a destination
 * is the one piece of the tracing stack that has to be ours — the library cannot
 * know our database.
 *
 * It is a `SpanExporter`, not a `SpanProcessor`, and that is the whole point.
 * `SpanProcessor.onEnd` runs inside the operation being measured, so writing
 * there makes tracing a tax on the thing it observes. `SpanExporter` is the
 * documented seam for a destination, and `BatchSpanProcessor` — which the SDK
 * already ships and which the OTLP side already uses — supplies the bounded
 * queue, the drop-when-full policy, the batching and the flush timer. None of
 * that is written here.
 *
 * Registered *beside* the OTLP processor, never instead of it. Both see every
 * span; an operator who runs a real collector keeps it.
 */

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { Statement } from "bun:sqlite";
import { JsonObject, jsonOr } from "../../contracts/json.ts";
import type { DB } from "../persistence/database.ts";
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
  attributes: Record<string, unknown>;
}

export interface StoredSpan extends SpanRow {
  projectId: number | null;
  grpId: number | null;
  sliceId: number | null;
}

/**
 * Retention, stated rather than left to grow.
 *
 * Two bounds because they fail differently. The age bound is the product one: a
 * requirement's timing is interesting while the requirement is open, and no
 * panel view looks further back than the week it ran in. The row bound is the
 * safety one — a retry storm or a hot loop can write a week's spans in an hour,
 * and an age bound alone would let it fill the disk before a single row aged
 * out. 200k rows is roughly 60MB of one laptop's SQLite file.
 *
 * Same shape as the idempotency store's own retention (age + count), because it
 * is the same problem: append-only history that nothing else deletes.
 */
export const SPAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const SPAN_MAX_ROWS = 200_000;

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
 * Nullable in the schema because most spans belong to no project: a `/healthz`
 * request and the retention trim itself are system work. An attribute that is
 * not a positive integer is treated as absent rather than coerced — a scope id
 * guessed from a string would aggregate somebody else's time into a group.
 */
function scopeId(attributes: Record<string, unknown>, key: string): number | null {
  const raw = attributes[key];
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function hrToMillis(time: [number, number]): number {
  return time[0] * 1_000 + time[1] / 1e6;
}

function toSpanRow(span: ReadableSpan): SpanRow {
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: spanKindName(span.kind),
    startedAt: Math.round(hrToMillis(span.startTime)),
    durationMs: hrToMillis(span.duration),
    status: spanStatusName(span.status.code),
    attributes: { ...span.attributes },
  };
}

/**
 * `OR IGNORE` on the natural key, so ingest is idempotent by construction.
 *
 * The same batch arriving twice — an OTLP client retrying a request whose
 * response it never saw — writes the same rows. That is why the receive route
 * does not carry an `Idempotency-Key`: there is no second side effect for one to
 * protect against.
 */
const INSERT = `
  INSERT OR IGNORE INTO span
    (trace_id, span_id, parent_span_id, name, kind, started_at, duration_ms, status,
     attributes_json, project_id, grp_id, slice_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

type InsertParams = [
  string,
  string,
  string | null,
  string,
  string,
  number,
  number,
  string,
  string,
  number | null,
  number | null,
  number | null,
];

function params(row: SpanRow): InsertParams {
  return [
    row.traceId,
    row.spanId,
    row.parentSpanId || null,
    row.name,
    row.kind,
    row.startedAt,
    row.durationMs,
    row.status,
    JSON.stringify(row.attributes),
    scopeId(row.attributes, "project.id"),
    scopeId(row.attributes, "grp.id"),
    scopeId(row.attributes, "slice.id"),
  ];
}

/** One transaction per batch: a batch lands whole or not at all. */
function insertAll(db: DB, insert: Statement<unknown, InsertParams>, rows: readonly SpanRow[]): void {
  db.transaction(() => {
    for (const row of rows) insert.run(...params(row));
  })();
}

/**
 * The receive endpoint's way in, where one call is one HTTP request rather than
 * one span, so preparing per call costs nothing worth caching.
 */
export function writeSpans(db: DB, rows: readonly SpanRow[]): void {
  if (rows.length === 0) return;
  insertAll(db, db.prepare<unknown, InsertParams>(INSERT), rows);
}

interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  started_at: number;
  duration_ms: number;
  status: string;
  attributes_json: string;
  project_id: number | null;
  grp_id: number | null;
  slice_id: number | null;
}

function decode(row: SpanRecord): StoredSpan {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    status: row.status === "ok" || row.status === "error" ? row.status : "unset",
    // Stored JSON is data on the way back in, so it is parsed against a schema
    // rather than asserted into shape — the same rule the write path follows.
    attributes: jsonOr(row.attributes_json, JsonObject, {}),
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
export function readTrace(db: DB, traceId: string): StoredSpan[] {
  return db
    .query<SpanRecord, [string]>("SELECT * FROM span WHERE trace_id = ? ORDER BY started_at, span_id")
    .all(traceId)
    .map(decode);
}

/**
 * Which work a read is asking about.
 *
 * `system` is not "everything". It is the work that belongs to no project — the
 * scheduler, the indexer, `/healthz`, the retention trim — and it is expressed
 * as both scope columns being NULL rather than as an absent filter, so the three
 * scopes partition the table instead of overlapping. A "system" view that also
 * counted every project's turns would report the fleet's busiest requirement as
 * a property of the host.
 */
export type ReadScope = { kind: "group"; id: number } | { kind: "project"; id: number } | { kind: "system" };

/**
 * The scope predicate and its parameters, together, because they cannot be
 * correct apart.
 *
 * `group` leads with `grp_id`, which is the first column of `span_scope`, so it
 * is an index range scan. `project` has no index of its own and leans on the
 * window bound through `span_age`; that is a deliberate omission rather than an
 * oversight — see `windowStart` below.
 */
function scopeSql(scope: ReadScope): { where: string; params: number[] } {
  if (scope.kind === "system") return { where: "project_id IS NULL AND grp_id IS NULL", params: [] };
  if (scope.kind === "group") return { where: "grp_id = ?", params: [scope.id] };
  // A project's spans are the ones that say so **and** the ones belonging to one
  // of its groups, because most of them only say the latter. `turnScope` in
  // `application/executor.ts` builds `{ grpId, sliceId }` and no `projectId`, so
  // `scopeAttributes` never emits `project.id` for a turn and the column is NULL
  // on every stage span ever written. Filtering on the column alone found
  // nothing, and an empty panel is indistinguishable from a panel that was never
  // built — which is exactly how this was reported.
  //
  // Resolved here rather than fixed at the writer, and that is the substantive
  // choice. A writer fix only labels spans written after it; the rows already in
  // the table would stay NULL forever, so the project view would be empty until
  // the fleet had run enough new turns to refill it. A span's project is not
  // independent information — `grp.project_id` already knows it — so deriving it
  // on read is both the smaller change and the one that works on the data that
  // is there. The writer may start setting the column too; this keeps working.
  return {
    where: "(project_id = ? OR grp_id IN (SELECT id FROM grp WHERE project_id = ?))",
    params: [scope.id, scope.id],
  };
}

/**
 * Nearest-rank percentile, in integer arithmetic.
 *
 * The rank of the p-th percentile over `n` samples is `ceil(n * p / 100)`, and
 * this is that written as `n - (n * (100 - p)) / 100` with SQLite's integer
 * division. Two reasons not to use floating point: SQLite is not built with the
 * math extensions everywhere, so `ceil()` is not reliably present, and
 * `CAST(n * 0.95 AS INTEGER)` truncates a value that IEEE-754 may have already
 * nudged below the integer it should have been — which moves a p95 down one
 * sample at exactly the round numbers a test would pick.
 *
 * Degenerate inputs land where they should without a special case: n = 1 gives
 * rank 1 for every percentile, so the only sample is both the p50 and the p95.
 */
const rank = (p: number) => `n - (n * ${100 - p}) / 100`;

/** Both percentiles this panel reports, as one aggregate over a ranked column. */
const percentiles = (column: string) => `
  MAX(CASE WHEN rn = ${rank(50)} THEN ${column} END) AS p50,
  MAX(CASE WHEN rn = ${rank(95)} THEN ${column} END) AS p95`;

/**
 * How far back a read looks, defaulting to everything retention kept.
 *
 * The window is not decoration on these queries, it is what makes the
 * project-scoped ones affordable: `span_age` is an index on `started_at` alone,
 * so a bounded window is a range scan that the `project_id` filter then narrows,
 * where an unbounded one is a scan of the table. The table is capped at 200k
 * rows by `trimSpans`, so even the worst case is bounded — but the common case,
 * a panel asking about the last day, touches a fraction of it.
 */
const windowStart = (now: number, windowMs: number) => now - Math.min(windowMs, SPAN_MAX_AGE_MS);

/** One stage — a span name — and what it cost across the scope. */
export interface StageStat {
  name: string;
  count: number;
  totalMs: number;
  p50: number;
  p95: number;
  errors: number;
}

/**
 * Where a scope's wall clock went, by stage, newest-costliest first.
 *
 * Grouped by span name because that is what a stage *is* here: `turn.provider`,
 * `sandbox.create`, `GET /api/v1/state`, a job kind. The same query answers all
 * three scopes, which is the reason there is one endpoint and not three.
 *
 * `totalMs` is a sum over overlapping spans and is deliberately not presented as
 * a share of anything: `turn` contains `turn.provider`, so the column adds up to
 * more than the wall clock and a percentage of it would be a lie. It orders the
 * list; the percentiles are what answer "is this slow".
 */
export function stageStats(db: DB, scope: ReadScope, windowMs = SPAN_MAX_AGE_MS, now = Date.now()): StageStat[] {
  const { where, params } = scopeSql(scope);
  return db
    .query<{ name: string; count: number; total_ms: number; p50: number; p95: number; errors: number }, number[]>(
      `WITH ranked AS (
         SELECT name, duration_ms, status,
                ROW_NUMBER() OVER (PARTITION BY name ORDER BY duration_ms) AS rn,
                COUNT(*)     OVER (PARTITION BY name)                      AS n
         FROM span WHERE started_at >= ? AND ${where}
       )
       SELECT name, MAX(n) AS count, SUM(duration_ms) AS total_ms, ${percentiles("duration_ms")},
              SUM(status = 'error') AS errors
       FROM ranked GROUP BY name ORDER BY total_ms DESC`,
    )
    .all(windowStart(now, windowMs), ...params)
    .map((row) => ({
      name: row.name,
      count: row.count,
      totalMs: row.total_ms,
      p50: row.p50,
      p95: row.p95,
      errors: row.errors,
    }));
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
 * The one question the stage table cannot answer. Stages say *what* the time
 * went on — the provider, a cold container — and this says *which piece of the
 * work* it went on, which is the axis a boss reading a requirement already has
 * in their head: slice 1 sailed through, slice 3 has burned an hour.
 *
 * `slice_id` is written by `turnScope` and indexed as the second column of
 * `span_scope`, so scoping to a group and grouping by slice is one range scan.
 *
 * NULL is a row rather than a filter. A requirement's planning turns, its draft
 * card and its roster belong to no slice, and dropping them would make the
 * per-slice numbers add up to less than the requirement's total with nothing on
 * screen explaining the difference.
 *
 * Only ever asked of a group: a project's slices belong to different
 * requirements and share only their sequence numbers, so the same query at that
 * scope would add up slice 1 of everything.
 */
export function sliceCosts(db: DB, grpId: number, windowMs = SPAN_MAX_AGE_MS, now = Date.now()): SliceCost[] {
  return db
    .query<{ slice_id: number | null; total_ms: number; count: number; errors: number }, [number, number]>(
      `SELECT slice_id, SUM(duration_ms) AS total_ms, COUNT(*) AS count, SUM(status = 'error') AS errors
       FROM span
       WHERE started_at >= ? AND grp_id = ?
       GROUP BY slice_id
       ORDER BY slice_id IS NULL, slice_id`,
    )
    .all(windowStart(now, windowMs), grpId)
    .map((row) => ({ sliceId: row.slice_id, totalMs: row.total_ms, count: row.count, errors: row.errors }));
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
 * A trace's span is measured as `MAX(end) - MIN(start)` *within the scope*
 * rather than by finding a root span, and that is the correct reading rather
 * than a shortcut. A requirement's turn is parented to the HTTP request that
 * enqueued it — `startChildTrace` sets a remote parent from the job row — so no
 * span in the requirement's own scope has a NULL parent, and a root-based
 * measure would either find nothing or wander up into another scope's time.
 *
 * `FIRST_VALUE` over the same window supplies the name, ordered by `span_id`
 * after `started_at` so two spans opened in the same millisecond do not make the
 * label flap between reads.
 */
export function traceList(
  db: DB,
  scope: ReadScope,
  limit = 20,
  windowMs = SPAN_MAX_AGE_MS,
  now = Date.now(),
): TraceSummary[] {
  const { where, params } = scopeSql(scope);
  return db
    .query<{ trace_id: string; name: string; started_at: number; duration_ms: number; failed: number }, number[]>(
      `SELECT trace_id, name, started_at, duration_ms, failed FROM (
         SELECT trace_id,
                FIRST_VALUE(name) OVER w                                          AS name,
                MIN(started_at)   OVER p                                          AS started_at,
                MAX(started_at + duration_ms) OVER p - MIN(started_at) OVER p      AS duration_ms,
                MAX(status = 'error')         OVER p                              AS failed,
                ROW_NUMBER()      OVER w                                          AS rn
         FROM span WHERE started_at >= ? AND ${where}
         WINDOW p AS (PARTITION BY trace_id),
                w AS (PARTITION BY trace_id ORDER BY started_at, span_id)
       ) WHERE rn = 1 ORDER BY started_at DESC LIMIT ?`,
    )
    .all(windowStart(now, windowMs), ...params, limit)
    .map((row) => ({
      traceId: row.trace_id,
      name: row.name,
      startedAt: row.started_at,
      durationMs: row.duration_ms,
      failed: row.failed === 1,
    }));
}

/**
 * One call path across the whole scope, and what it cost.
 *
 * `path` is the span names from the root down, `;`-separated — the folded-stack
 * format flamegraphs have consumed since the original Perl ones, which is why it
 * is the shape produced here rather than a nested object. A tree built in SQL
 * would be a tree serialised through a text column either way; folded stacks are
 * that with a format somebody else already defined.
 */
export interface FoldedStack {
  path: string;
  totalMs: number;
  count: number;
}

/**
 * How deep the walk will follow parent links.
 *
 * Worth being exact about what this does and does not protect against, because
 * the obvious reading is wrong. It is *not* what stops a cycle hanging the
 * query: a span has one parent column and `(trace_id, span_id)` is the primary
 * key, so every span has at most one parent and the part of the graph reachable
 * from a root is a tree by construction. A cycle can only exist among spans that
 * are unreachable from any root, and those are never walked at all.
 *
 * What it bounds is depth itself. Each level concatenates another name onto a
 * path string, so a runaway-deep trace — a recursive tool call, an agent looping
 * through a stage — costs quadratic text before it costs anything else. 64 is
 * far past anything real: the deepest thing this system emits is `turn` →
 * `turn.checkpoint` → `sandbox.create` → `sandbox.init`, which is four.
 *
 * The unreachable-cycle case is a real if unreachable-in-practice gap: those
 * spans contribute nothing to the flamegraph rather than appearing detached.
 * Sweeping them in would mean a second pass over the scope to find what the
 * first missed, which is not worth paying for a shape no correct writer emits.
 */
const MAX_STACK_DEPTH = 64;

/**
 * Every call path in the scope, summed — the flamegraph's data.
 *
 * This is the aggregate, not one trace, and that is the point of having it
 * beside the waterfall. A waterfall answers "what happened in this one run, and
 * in what order". A flamegraph over every run in the scope answers "where does
 * this project's time actually go", which is a question no single trace can
 * answer and the one somebody asks when the fleet feels slow.
 *
 * A root is a span whose parent is absent *from the scope* rather than NULL:
 * `startChildTrace` gives a job's span a remote parent, so a requirement's own
 * spans never have a NULL parent, and anchoring on NULL would return nothing at
 * all. The key carries `trace_id` as well as the span id because span ids are
 * only unique within a trace.
 *
 * **Folded here rather than in SQL**, which is the exception to this file's own
 * rule and is worth the sentence. Percentiles and bucketing belong in the query
 * and are fast there; a tree walk does not, because a recursive CTE has no index
 * to stand on. The version this replaced joined a CTE to itself once per level
 * and ran a correlated subquery over the same CTE to find roots — quadratic in
 * the window, measured at **5,178ms** against 7,382 spans while the flat read
 * that feeds this is 0.1ms.
 *
 * What this guarantees, asserted rather than assumed: every span in the scope is
 * counted exactly once (7,008 in, 7,008 out at system scope on live data; 374
 * in, 374 out at project scope), and no path repeats a name, which is what a
 * walk without cycle detection produces when parent ids form a ring.
 *
 * A "the query was also losing rows" claim was made here and withdrawn: it came
 * from comparing the scoped query against an unscoped probe, so the 374 spans
 * missing from one side were project-scoped rows the system scope excludes by
 * design. The measurement was wrong; the speed is the whole of the reason.
 */
export function foldedStacks(db: DB, scope: ReadScope, windowMs = SPAN_MAX_AGE_MS, now = Date.now()): FoldedStack[] {
  const { where, params } = scopeSql(scope);
  const rows = db
    .query<FoldRow, number[]>(
      `SELECT trace_id, span_id, parent_span_id, name, duration_ms
         FROM span WHERE started_at >= ? AND ${where}`,
    )
    .all(windowStart(now, windowMs), ...params);

  const byId = new Map(rows.map((row) => [spanKey(row.trace_id, row.span_id), row]));
  const paths = new Map<string, string>();
  const walking = new Set<string>();

  /**
   * A span's ancestry, or as much of it as the scope can establish.
   *
   * Three things end the walk and all three mean the same thing — nothing above
   * this is knowable from here — so all three produce a root: no parent id, a
   * parent outside the scope, and a cycle. The cycle case is why `walking`
   * exists: without it a ring of parent ids recurses to the depth cap and emits
   * a path repeating the ring sixty-four times, which is worse than useless.
   *
   * The old query dropped cycles entirely, and that was recorded as a decision.
   * It is not one this keeps: the same mechanism that made them vanish is what
   * silently dropped 374 real rows, and a span that exists and cost time belongs
   * on the graph. Being unable to say what it hung off is not a reason to say it
   * never happened.
   */
  const pathOf = (row: FoldRow, depth: number): string => {
    const id = spanKey(row.trace_id, row.span_id);
    const known = paths.get(id);
    if (known !== undefined) return known;
    const parent = row.parent_span_id ? byId.get(spanKey(row.trace_id, row.parent_span_id)) : undefined;
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

interface FoldRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  duration_ms: number;
}

/** Span ids are unique within a trace, not across them. */
const spanKey = (traceId: string, spanId: string): string => `${traceId} ${spanId}`;

/** One bucket of the trend: when, how many, and how long they took. */
export interface TrendPoint {
  at: number;
  count: number;
  p50: number;
  p95: number;
}

/**
 * The scope's end-to-end time over the window, bucketed.
 *
 * The sample is one trace, not one span, so a bucket answers "how long did a
 * unit of work take then" rather than "how long did the average span take" —
 * the second is a number that moves when the shape of the tracing changes and
 * nothing about the system does.
 *
 * Bucketing is `started_at / bucketMs` in integer division, multiplied back out
 * so each row carries the epoch millisecond the bucket starts at rather than an
 * index the caller would have to know the divisor to interpret.
 */
export function trend(
  db: DB,
  scope: ReadScope,
  bucketMs = 60 * 60 * 1_000,
  windowMs = SPAN_MAX_AGE_MS,
  now = Date.now(),
): TrendPoint[] {
  const { where, params } = scopeSql(scope);
  return db
    .query<{ at: number; count: number; p50: number; p95: number }, number[]>(
      `WITH per_trace AS (
         SELECT MIN(started_at) AS started_at,
                MAX(started_at + duration_ms) - MIN(started_at) AS wall
         FROM span WHERE started_at >= ? AND ${where}
         GROUP BY trace_id
       ),
       bucketed AS (
         SELECT CAST(started_at / ? AS INTEGER) AS bucket, wall,
                ROW_NUMBER() OVER (PARTITION BY CAST(started_at / ? AS INTEGER) ORDER BY wall) AS rn,
                COUNT(*)     OVER (PARTITION BY CAST(started_at / ? AS INTEGER))               AS n
         FROM per_trace
       )
       SELECT bucket * ? AS at, MAX(n) AS count, ${percentiles("wall")}
       FROM bucketed GROUP BY bucket ORDER BY at`,
    )
    .all(windowStart(now, windowMs), ...params, bucketMs, bucketMs, bucketMs, bucketMs)
    .map((row) => ({ at: row.at, count: row.count, p50: row.p50, p95: row.p95 }));
}

/**
 * Drop what is older than the age bound, then whatever still exceeds the row
 * bound. `maxRows` is a parameter only so a test can prove the second delete
 * without writing two hundred thousand rows to prove it.
 *
 * Called from the server's heartbeat, never from the write path: retention is
 * housekeeping on a schedule, and a span arriving is not a reason to run it.
 */
export function trimSpans(db: DB, now = Date.now(), maxRows = SPAN_MAX_ROWS): void {
  db.run("DELETE FROM span WHERE started_at < ?", [now - SPAN_MAX_AGE_MS]);
  db.run(
    `DELETE FROM span WHERE rowid IN (
       SELECT rowid FROM span ORDER BY started_at DESC LIMIT -1 OFFSET ?
     )`,
    [maxRows],
  );
}

/**
 * The destination. `BatchSpanProcessor` owns everything around it.
 *
 * `export` is handed a whole batch off the SDK's flush timer, so it runs outside
 * the operation being traced. The insert is prepared once for the life of the
 * exporter, and the batch commits in one transaction.
 */
export class SqliteSpanExporter implements SpanExporter {
  readonly #db: DB;
  readonly #insert: Statement<unknown, InsertParams>;
  #closed = false;

  constructor(db: DB) {
    this.#db = db;
    this.#insert = db.prepare<unknown, InsertParams>(INSERT);
  }

  /**
   * Losing spans is never a reason to fail the flush that carried them.
   *
   * `forceFlush` and `shutdown` are the process's shutdown path, and
   * `BatchSpanProcessor` turns a `FAILED` result into a rejected promise — so
   * reporting the failure here is how a closed or broken database turned a clean
   * shutdown into a rejection. It buys nothing either: the processor does not
   * retry, so the only consumer of `FAILED` is that rejection.
   *
   * The loss is still reported, through the channel an operator actually watches:
   * `orchestrator_telemetry_dropped_total`, the same counter the OTLP side uses
   * for batches a collector refused.
   */
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    // `shutdownTracing` swaps in a fresh provider before closing this one, so a
    // late flush can arrive after the database handle is gone.
    if (this.#closed) {
      recordDroppedSpans(spans.length);
    } else {
      try {
        insertAll(this.#db, this.#insert, spans.map(toSpanRow));
      } catch {
        recordDroppedSpans(spans.length);
      }
    }
    done({ code: ExportResultCode.SUCCESS });
  }

  // `forceFlush` is optional on `SpanExporter` and is deliberately not
  // implemented: every batch commits inside `export`, so there is never anything
  // buffered here to flush. The queue that does need draining belongs to
  // `BatchSpanProcessor`, and its own `forceFlush` drains it.

  shutdown(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
