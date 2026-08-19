/**
 * Spans, in the same SQLite file as everything else they describe.
 *
 * A `SpanExporter`, **not** a `SpanProcessor`: `SpanProcessor.onEnd` runs inside
 * the operation being measured, so writing there makes tracing a tax on the thing
 * it observes, while `BatchSpanProcessor` supplies the queue, the drop policy, the
 * batching and the flush timer. Registered *beside* the OTLP processor.
 */

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from "@opentelemetry/core";
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

/**
 * `OR IGNORE` on the natural key, so ingest is idempotent by construction.
 *
 * The same batch arriving twice writes the same rows, which is why the receive
 * route carries no `Idempotency-Key`: there is no second side effect to protect
 * against.
 */
const INSERT = `
  INSERT OR IGNORE INTO span
    (trace_id, span_id, parent_span_id, name, kind, started_at, duration_ms, status,
     status_message, attributes_json, project_id, grp_id, slice_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

type InsertParams = [
  string,
  string,
  string | null,
  string,
  string,
  number,
  number,
  string,
  string | null,
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
    row.statusMessage,
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
  status_message: string | null;
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
    statusMessage: row.status_message,
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
 * `system` is not "everything": it is the work that belongs to no project, and it
 * is expressed as both scope columns being NULL rather than as an absent filter,
 * so the three scopes partition the table instead of overlapping.
 */
export type ReadScope = { kind: "group"; id: number } | { kind: "project"; id: number } | { kind: "system" };

/**
 * The scope predicate and its parameters, together, because they cannot be
 * correct apart.
 *
 * `group` leads with `grp_id`, the first column of `span_scope`, so it is an index
 * range scan. `project` has no index of its own and leans on the window bound
 * through `span_age` — a deliberate omission, see `Window` below.
 */
function scopeSql(scope: ReadScope): { where: string; params: number[] } {
  if (scope.kind === "system") return { where: "project_id IS NULL AND grp_id IS NULL", params: [] };
  if (scope.kind === "group") return { where: "grp_id = ?", params: [scope.id] };
  // A project's spans are the ones that say so **and** the ones belonging to one of
  // its groups, because most of them only say the latter: `turnScope` builds
  // `{ grpId, sliceId }` and no `projectId`, so `project_id` is NULL on every stage
  // span ever written. Resolved on read rather than at the writer — a writer fix
  // only labels spans written after it, while the rows already in the table stay
  // NULL forever. A span's project is not independent information, `grp.project_id`
  // already knows it. The writer may start setting the column too; this keeps working.
  return {
    where: "(project_id = ? OR grp_id IN (SELECT id FROM grp WHERE project_id = ?))",
    params: [scope.id, scope.id],
  };
}

/**
 * Nearest-rank percentile, in integer arithmetic.
 *
 * `ceil(n * p / 100)` written as `n - (n * (100 - p)) / 100` with SQLite's integer
 * division. Not floating point: `ceil()` is not reliably present, and
 * `CAST(n * 0.95 AS INTEGER)` truncates a value IEEE-754 may already have nudged
 * below the integer it should have been. n = 1 gives rank 1 for every percentile.
 */
const rank = (p: number) => `n - (n * ${100 - p}) / 100`;

/** Both percentiles this panel reports, as one aggregate over a ranked column. */
const percentiles = (column: string) => `
  MAX(CASE WHEN rn = ${rank(50)} THEN ${column} END) AS p50,
  MAX(CASE WHEN rn = ${rank(95)} THEN ${column} END) AS p95`;

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
export function stageStats(db: DB, scope: ReadScope, window: TimeWindow = recentWindow()): StageStat[] {
  const bounds = clamp(window);
  const { where, params } = scopeSql(scope);
  // fallow-ignore-next-line security-sink -- `where` is one of the three source literals in `scopeSql` a few lines above, chosen by `scope.kind` and never assembled from a value. Every number travels in `params` and is bound through `?`, as are the two window bounds. `percentiles("duration_ms")` is a module template over a column name written here as a literal.
  return db
    .query<
      {
        name: string;
        count: number;
        total_ms: number;
        p50: number;
        p95: number;
        errors: number;
        reason: string | null;
      },
      number[]
    >(
      // The reason is the *latest* failure rather than the commonest: a stage
      // that has started working again should stop explaining how it used to
      // break, and the newest message is the one a reader can still act on.
      `WITH ranked AS (
         SELECT name, duration_ms, status, started_at, status_message,
                ROW_NUMBER() OVER (PARTITION BY name ORDER BY duration_ms) AS rn,
                COUNT(*)     OVER (PARTITION BY name)                      AS n,
                ROW_NUMBER() OVER (PARTITION BY name, status = 'error' ORDER BY started_at DESC, span_id DESC) AS recent
         FROM span WHERE started_at >= ? AND started_at < ? AND ${where}
       )
       SELECT name, MAX(n) AS count, SUM(duration_ms) AS total_ms, ${percentiles("duration_ms")},
              SUM(status = 'error') AS errors,
              MAX(CASE WHEN status = 'error' AND recent = 1 THEN status_message END) AS reason
       FROM ranked GROUP BY name ORDER BY total_ms DESC`,
    )
    .all(bounds.from, bounds.to, ...params)
    .map((row) => ({
      name: row.name,
      count: row.count,
      totalMs: row.total_ms,
      p50: row.p50,
      p95: row.p95,
      errors: row.errors,
      reason: row.reason,
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
 * NULL is a row rather than a filter: planning turns, the draft card and the roster
 * belong to no slice, and dropping them makes the per-slice numbers add up to less
 * than the requirement's total. Only ever asked of a **group** — a project's slices
 * belong to different requirements and share only their sequence numbers.
 */
export function sliceCosts(db: DB, grpId: number, window: TimeWindow = recentWindow()): SliceCost[] {
  const bounds = clamp(window);
  return db
    .query<{ slice_id: number | null; total_ms: number; count: number; errors: number }, [number, number, number]>(
      `SELECT slice_id, SUM(duration_ms) AS total_ms, COUNT(*) AS count, SUM(status = 'error') AS errors
       FROM span
       WHERE started_at >= ? AND started_at < ? AND grp_id = ?
       GROUP BY slice_id
       ORDER BY slice_id IS NULL, slice_id`,
    )
    .all(bounds.from, bounds.to, grpId)
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
 * `MAX(end) - MIN(start)` *within the scope* rather than a root span: `startChildTrace`
 * gives a turn a remote parent, so no span in a requirement's own scope has a NULL
 * parent. `FIRST_VALUE` supplies the name, ordered by `span_id` so it cannot flap.
 * `recent` names the twenty first, because a `LIMIT` cannot be pushed past a window
 * function and partitioning the whole window sorted 84,000 rows to return twenty. It
 * ranks by the same key the outer `ORDER BY` does, so it selects the same twenty.
 */
export function traceList(db: DB, scope: ReadScope, limit = 20, window: TimeWindow = recentWindow()): TraceSummary[] {
  const bounds = clamp(window);
  const { where, params } = scopeSql(scope);
  // fallow-ignore-next-line security-sink -- `where` is one of the three source literals in `scopeSql` a few lines above, chosen by `scope.kind` and never assembled from a value. It appears twice and is the same literal both times. Every number travels in `params` and is bound through `?`, as are the two window bounds and `limit`, each supplied once per occurrence.
  return db
    .query<{ trace_id: string; name: string; started_at: number; duration_ms: number; failed: number }, number[]>(
      `WITH recent AS (
         SELECT trace_id, MIN(started_at) AS started_at
         FROM span WHERE started_at >= ? AND started_at < ? AND ${where}
         GROUP BY trace_id ORDER BY started_at DESC, trace_id DESC LIMIT ?
       )
       SELECT trace_id, name, started_at, duration_ms, failed FROM (
         SELECT trace_id,
                FIRST_VALUE(name) OVER w                                          AS name,
                MIN(started_at)   OVER p                                          AS started_at,
                MAX(started_at + duration_ms) OVER p - MIN(started_at) OVER p      AS duration_ms,
                MAX(status = 'error')         OVER p                              AS failed,
                ROW_NUMBER()      OVER w                                          AS rn
         FROM span WHERE started_at >= ? AND started_at < ? AND ${where}
           AND trace_id IN (SELECT trace_id FROM recent)
         WINDOW p AS (PARTITION BY trace_id),
                w AS (PARTITION BY trace_id ORDER BY started_at, span_id)
       ) WHERE rn = 1 ORDER BY started_at DESC, trace_id DESC LIMIT ?`,
    )
    .all(bounds.from, bounds.to, ...params, limit, bounds.from, bounds.to, ...params, limit)
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

/**
 * Every call path in the scope, summed — the flamegraph's data.
 *
 * A root is a span whose parent is absent *from the scope* rather than NULL:
 * anchoring on NULL returns nothing at all. The key carries `trace_id` as well as
 * the span id, because span ids are unique only within a trace. **Folded here rather
 * than in SQL**, this file's one exception: a tree walk has no index to stand on.
 */
export function foldedStacks(db: DB, scope: ReadScope, window: TimeWindow = recentWindow()): FoldedStack[] {
  const bounds = clamp(window);
  const { where, params } = scopeSql(scope);
  // fallow-ignore-next-line security-sink -- `where` is one of the three source literals in `scopeSql` a few lines above, chosen by `scope.kind` and never assembled from a value. Every number travels in `params` and is bound through `?`, as are the two window bounds. This is the flat read the fold walks in JS; nothing else is interpolated.
  const rows = db
    .query<FoldRow, number[]>(
      `SELECT trace_id, span_id, parent_span_id, name, duration_ms
         FROM span WHERE started_at >= ? AND started_at < ? AND ${where}`,
    )
    .all(bounds.from, bounds.to, ...params);

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
 * The first and last instant this scope has a span for.
 *
 * Different from the window a read was asked for: a pan clamped to the *requested*
 * window can walk into stretches the store has nothing in, and the reader cannot
 * tell "nothing happened" from "you have scrolled off the end". Clamped to retention
 * like every other read. `null` when the scope has no spans — not a zero-width one.
 */
export function spanExtent(db: DB, scope: ReadScope, now = Date.now()): TimeWindow | null {
  const { where, params } = scopeSql(scope);
  const floor = now - SPAN_MAX_AGE_MS;
  // fallow-ignore-next-line security-sink -- `where` is one of the three source literals in `scopeSql` above, chosen by `scope.kind` and never assembled from a value; the retention floor and the scope ids travel in `params` and bind through `?`.
  const row = db
    .query<{ first: number | null; last: number | null }, number[]>(
      `SELECT MIN(started_at) AS first, MAX(started_at + duration_ms) AS last
         FROM span WHERE started_at >= ? AND ${where}`,
    )
    .get(floor, ...params);
  if (!row || row.first === null || row.last === null) return null;
  // A single span makes first and last equal, and a zero-width window is not a
  // range anything can be clamped inside. One second is the smallest span the
  // rest of this module considers a window at all.
  return { from: row.first, to: Math.max(row.last, row.first + 1_000) };
}

export function trend(
  db: DB,
  scope: ReadScope,
  bucketMs = 60 * 60 * 1_000,
  window: TimeWindow = recentWindow(),
): TrendPoint[] {
  const bounds = clamp(window);
  const { where, params } = scopeSql(scope);
  // fallow-ignore-next-line security-sink -- `where` is one of the three source literals in `scopeSql` a few lines above, chosen by `scope.kind` and never assembled from a value. Every number travels in `params` and is bound through `?`, as are the window bounds and the four `bucketMs`. `percentiles("wall")` is the same module template over a literal column name.
  return db
    .query<{ at: number; count: number; p50: number; p95: number }, number[]>(
      `WITH per_trace AS (
         SELECT MIN(started_at) AS started_at,
                MAX(started_at + duration_ms) - MIN(started_at) AS wall
         FROM span WHERE started_at >= ? AND started_at < ? AND ${where}
         GROUP BY trace_id
       ),
       bucketed AS (
         SELECT CAST(started_at / ? AS INTEGER) AS bucket, wall,
                ROW_NUMBER() OVER (PARTITION BY CAST(started_at / ? AS INTEGER) ORDER BY wall) AS rn,
                COUNT(*)     OVER (PARTITION BY CAST(started_at / ? AS INTEGER))               AS n
         FROM per_trace
       )
       SELECT bucket * ? AS at, MAX(n) AS count, ${percentiles("wall")}
       -- any-order: at is bucket * width and bucket is the GROUP BY key, so
       -- there is one row per value and nothing to tie. It reads like a clock
       -- and is an index into the buckets.
       FROM bucketed GROUP BY bucket ORDER BY at`,
    )
    .all(bounds.from, bounds.to, ...params, bucketMs, bucketMs, bucketMs, bucketMs)
    .map((row) => ({ at: row.at, count: row.count, p50: row.p50, p95: row.p95 }));
}

/**
 * Drop what is older than the age bound, then whatever still exceeds the row
 * bound. `maxRows` is a parameter only so a test can prove the second delete.
 *
 * Called from the server's heartbeat, never from the write path: retention is
 * housekeeping on a schedule, and a span arriving is not a reason to run it.
 */
export function trimSpans(db: DB, now = Date.now(), maxRows = SPAN_MAX_ROWS): void {
  db.run("DELETE FROM span WHERE started_at < ?", [now - SPAN_MAX_AGE_MS]);
  db.run(
    `DELETE FROM span WHERE rowid IN (
       SELECT rowid FROM span ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?
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
