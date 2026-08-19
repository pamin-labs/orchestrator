/**
 * The read side of the `span` table: where a scope's wall clock went.
 *
 * ADR 014 stored spans and nothing read them back, which left its storage half
 * unfalsifiable — a table nothing queried, and a boss still with no way to ask.
 */

import QuickLRU from "quick-lru";
import { z } from "zod";
import type { Ctx } from "../../mech/ctx.ts";
import type { Handler } from "../../http/handler.ts";
import { failure, json } from "../../http/respond.ts";
import {
  type FoldedStack,
  foldedStacks,
  type SliceCost,
  sliceCosts,
  spanExtent,
  readTrace,
  type ReadScope,
  recentWindow,
  type TimeWindow,
  SPAN_MAX_AGE_MS,
  type StageStat,
  stageStats,
  type StoredSpan,
  traceList,
  type TraceSummary,
  trend,
  type TrendPoint,
} from "../../platform/observability/span-store.ts";

/** A trace id as it is stored: the 32 lowercase hex digits of the W3C format. */
const TraceId = z
  .string()
  .regex(/^[0-9a-f]{32}$/i)
  .transform((id) => id.toLowerCase());

/**
 * What to report on.
 *
 * `id` is required for `group` and `project` and refused for `system`, and that
 * is checked here rather than left to the handler: "system, id 4" has no meaning
 * a reader could agree on, and silently ignoring the id would let a panel bug
 * that sent the wrong scope look like a working query returning the host's time.
 */
export const TelemetryQuery = z
  .object({
    scope: z.enum(["group", "project", "system"]),
    id: z.coerce.number().int().positive().optional(),
    /** How far back to look, ending now. Clamped to retention, the most that exists. */
    windowMs: z.coerce.number().int().positive().max(SPAN_MAX_AGE_MS).optional(),
    /**
     * An explicit stretch of time, in epoch milliseconds.
     *
     * `windowMs` says "the last N", which is the right shape for a page opening
     * and the wrong one for a brush: dragging the handles around 01:30–02:00 can
     * only be reported as "the last thirty minutes" when the end is pinned to
     * now. These two say the interval. They win over `windowMs` when present.
     */
    from: z.coerce.number().int().positive().optional(),
    to: z.coerce.number().int().positive().optional(),
    /** Trend granularity. A minute is the floor; below that the buckets outnumber the traces. */
    bucketMs: z.coerce.number().int().min(60_000).optional(),
    /** Open one trace's waterfall alongside the aggregate. */
    trace: TraceId.optional(),
  })
  .refine((q) => (q.scope === "system") !== (q.id !== undefined), {
    error: "group and project scopes need an id; system takes none",
    path: ["id"],
  });

export type TelemetryQueryValue = z.infer<typeof TelemetryQuery>;

/** The validated query as the scope the store understands. */
/**
 * One endpoint, three scopes, because the scope is data and not a destination.
 *
 * Requirement, project and host ask the same question of the same columns and
 * differ only by a predicate. Three routes would be that predicate written three
 * times, drifting apart the first time a percentile definition changed — and
 * invisibly, since the panel renders one shape either way.
 */
function toScope(query: TelemetryQueryValue): ReadScope {
  // `id` is present for both non-system scopes by the refinement above; the
  // fallback keeps this total without a non-null assertion the compiler would
  // have to be argued out of.
  return query.scope === "system" ? { kind: "system" } : { kind: query.scope, id: query.id ?? 0 };
}

/**
 * How long a window gets: everything retention kept.
 *
 * It said "the caller can ask for more, up to the seven days retention keeps",
 * and retention is `SPAN_MAX_AGE_MS` — 24 hours. There was no more to ask for,
 * and `windowMs` is already `.max(SPAN_MAX_AGE_MS)` above, so seven days was
 * unreachable through a schema written in the same file. Read from the constant
 * now rather than restated as a literal that happened to agree with it.
 */
const DEFAULT_WINDOW_MS = SPAN_MAX_AGE_MS;
const DEFAULT_BUCKET_MS = 60 * 60 * 1_000;

/** How many recent traces the drill-in list offers. */
const TRACE_LIMIT = 20;

/** Stands in for an absent `bucketMs` in the cache key, so it cannot collide with one. */
const DEFAULT_BUDGET_KEY = "default";

/**
 * One span of an opened trace, as the waterfall draws it.
 *
 * Not `StoredSpan`: the stored row carries an open `attributes` bag and the
 * scope columns, and neither reaches the screen. Shipping the whole row would
 * put every prompt-adjacent attribute we ever attach to a span onto the wire for
 * a view that draws a bar, and would make the payload grow silently whenever
 * somebody added an attribute for an unrelated reason.
 */
export interface WaterfallSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAt: number;
  durationMs: number;
  status: "unset" | "ok" | "error";
}

/**
 * The report: four pieces in one response, because all four are drawn at once
 * and fetching them separately renders three against one window and the fourth
 * against another — a p95 beside a trend over a different span of time is two
 * answers to one question.
 */
/**
 * A named interface, not inferred: `ApiType` serialises every route's response
 * into one type for the browser client, and an anonymous nested literal here was
 * enough to push that past TS7056 on `hc<ApiType>`.
 */
export interface TelemetryReport {
  scope: TelemetryQueryValue["scope"];
  windowMs: number;
  /** The stretch of time the numbers cover, so the charts can label their own axis. */
  window: TimeWindow;
  /**
   * The first and last instant this scope has a span for, or `null` when it has
   * none.
   *
   * Not the same fact as `window`, which is whatever the query asked for and is
   * echoed straight back. A zoom or a pan clamped to `window` can only ever
   * reach where it already is, and clamped to a requested window it walks into
   * stretches the store is empty in. This is what a chart's limits should be.
   */
  dataWindow: TimeWindow | null;
  stages: StageStat[];
  traces: TraceSummary[];
  trend: TrendPoint[];
  /**
   * Every call path in the scope, summed, as folded stacks.
   *
   * The aggregate rather than the open trace, because that is the question a
   * flamegraph is for. `trace` below answers "what happened in this one run";
   * this answers "where does this scope's time go", which no single trace can.
   */
  flame: FoldedStack[];
  /**
   * Which slice spent the time, for a requirement.
   *
   * Empty for the other two scopes rather than optional: a project's slices
   * belong to different requirements and share only their sequence numbers, so
   * the same split there would add up slice 1 of everything. One shape for the
   * panel to render; the emptiness is the answer.
   */
  slices: SliceCost[];
  trace: { traceId: string; spans: WaterfallSpan[] } | null;
}

/**
 * The aggregation is SQL, in `span-store.ts`, against indexes that exist for it.
 *
 * Nothing here pulls rows in to reduce them: `SPAN_MAX_ROWS` is the retention
 * cap, so a panel computing a p95 in-process would be slowest exactly when the
 * fleet was busiest. A scope naming a project that is gone is an empty report,
 * not an error: a span observes work rather than referring to it.
 */
/**
 * One answer per scope+window, briefly.
 *
 * Not for latency — the report is inside its budget. It is that the five queries
 * are synchronous, so a reloading tab holds every other request and the SSE
 * heartbeat behind it. `maxAge` rather than an invalidation: the spans are
 * written by a heartbeat, so a report is stale by that much the moment it is
 * computed, and a TTL under one tick cannot serve anything older than that.
 */
const reports = new WeakMap<Ctx["db"], QuickLRU<string, TelemetryReport>>();

/**
 * Per database, not per process.
 *
 * A module-level cache keyed on scope+window alone answers one database's question
 * with another's report — which is a wrong panel in production the first time two
 * databases exist, and was two red tests here immediately.
 */
function cacheFor(db: Ctx["db"], ttl: number): QuickLRU<string, TelemetryReport> {
  const found = reports.get(db);
  if (found) return found;
  const made = new QuickLRU<string, TelemetryReport>({ maxSize: 32, maxAge: ttl });
  reports.set(db, made);
  return made;
}

export const getTelemetry = (async (ctx, _req, _params, query) => {
  const scope = toScope(query);
  const windowMs = query.windowMs ?? DEFAULT_WINDOW_MS;
  // An explicit range wins; otherwise the last `windowMs`. Both are clamped to
  // retention inside the store, which is the one place that knows how far back
  // rows actually go.
  // A default window ends "now", which would make every request its own cache key.
  // Rounded to the cache's own period so two reloads inside one TTL ask the same
  // question — *up*, never down: rounding down moves the window's end into the
  // past and drops the spans written since, which is a report that is wrong rather
  // than merely stale.
  const ttl = ctx.config.telemetryCacheMs;
  const window =
    query.from !== undefined && query.to !== undefined && query.to > query.from
      ? { from: query.from, to: query.to }
      : recentWindow(windowMs, Math.ceil(Date.now() / ttl) * ttl);
  const spans = query.trace ? await readTrace(ctx.db, query.trace) : [];
  // A trace id that matches nothing is the one case worth refusing rather than
  // reporting empty: unlike a scope id, it was copied from a list this endpoint
  // itself produced, so nothing there means the trace aged out from under the
  // reader, and an empty waterfall would read as "it took no time".
  //
  // `not_found` and not `bad`'s `operation_refused`: the request is well formed
  // and nothing is being refused — the thing it named is gone, which is what the
  // rest of the panel returns for a row a delete or a retention pass removed.
  if (query.trace && spans.length === 0) return failure("that trace is no longer stored", 404);
  // An open trace is never served from the cache: it is one reader's drill-in, so
  // it would evict the aggregate everyone else is asking for.
  const key = query.trace
    ? null
    : JSON.stringify([query.scope, query.id ?? 0, window.from, window.to, query.bucketMs ?? DEFAULT_BUDGET_KEY]);
  const cache = cacheFor(ctx.db, ttl);
  const hit = key === null ? undefined : cache.get(key);
  if (hit) return json(hit);

  // Together, not one after another: six independent reads of one table, and
  // serially they are six round trips a reader waits through for a page that
  // cannot render until the last one lands.
  const [dataWindow, stages, traces, points, flame, slices] = await Promise.all([
    spanExtent(ctx.db, scope),
    stageStats(ctx.db, scope, window),
    traceList(ctx.db, scope, TRACE_LIMIT, window),
    trend(ctx.db, scope, query.bucketMs ?? DEFAULT_BUCKET_MS, window),
    foldedStacks(ctx.db, scope, window),
    scope.kind === "group" ? sliceCosts(ctx.db, scope.id, window) : [],
  ]);
  const report: TelemetryReport = {
    scope: query.scope,
    windowMs,
    window,
    dataWindow,
    stages,
    traces,
    trend: points,
    flame,
    slices,
    trace: query.trace ? { traceId: query.trace, spans: spans.map(toWaterfallSpan) } : null,
  };
  if (key !== null) cache.set(key, report);
  return json(report);
}) satisfies Handler<TelemetryQueryValue>;

const toWaterfallSpan = (span: StoredSpan): WaterfallSpan => ({
  spanId: span.spanId,
  parentSpanId: span.parentSpanId,
  name: span.name,
  startedAt: span.startedAt,
  durationMs: span.durationMs,
  status: span.status,
});
