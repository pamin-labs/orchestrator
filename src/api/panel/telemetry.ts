/**
 * The read side of the `span` table: where a scope's wall clock went.
 *
 * Spans have been stored and scoped since ADR 014 and nothing read them back,
 * which made the storage half of that decision unfalsifiable — a boss asking
 * where a requirement's nine minutes went still had no collector to ask, and now
 * also had a table nothing queried. This is the answer to that question, and it
 * is one route rather than three.
 *
 * **One endpoint, three scopes.** A requirement, a project and the host ask the
 * same question of the same columns; the only thing that differs is a predicate.
 * Three routes would be that predicate written three times, drifting apart the
 * first time a percentile definition changed — and the panel would still need
 * one shape to render, so the divergence would be invisible until a number was
 * wrong. The scope is a parameter because it is data, not a destination.
 *
 * **The aggregation is SQL.** Percentiles, bucketing and the scope filter run in
 * `span-store.ts` against indexes that exist for them. Nothing here pulls rows
 * into the process to reduce them: 200k rows is the retention cap, and a panel
 * that read them all to compute a p95 would be slowest exactly when the fleet
 * was busiest and the answer mattered most.
 *
 * Trust boundary: `/api/v1/*`, the same as every other panel read — loopback by
 * default, CSRF on writes, and no agent reaches this process directly at all.
 * The scope id is a positive integer and nothing else; it is interpolated
 * nowhere, only bound. A scope naming a project that does not exist is not an
 * error, it is an empty report, because a span is an observation of work rather
 * than a reference to it and the row it described may have been deleted.
 */

import { z } from "zod";
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
    message: "group and project scopes need an id; system takes none",
    path: ["id"],
  });

export type TelemetryQueryValue = z.infer<typeof TelemetryQuery>;

/** The validated query as the scope the store understands. */
function toScope(query: TelemetryQueryValue): ReadScope {
  // `id` is present for both non-system scopes by the refinement above; the
  // fallback keeps this total without a non-null assertion the compiler would
  // have to be argued out of.
  return query.scope === "system" ? { kind: "system" } : { kind: query.scope, id: query.id ?? 0 };
}

/**
 * How long a window gets, and why the default is not the whole of retention.
 *
 * A day is what a panel glanced at every twenty minutes is actually asking
 * about, and it keeps the project-scoped scan — which has only `span_age` to
 * lean on — proportional to a day of spans rather than a week of them. The
 * caller can ask for more, up to the seven days retention keeps.
 */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BUCKET_MS = 60 * 60 * 1_000;

/** How many recent traces the drill-in list offers. */
const TRACE_LIMIT = 20;

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
 * The report.
 *
 * All four pieces in one response because all four are drawn at once and a panel
 * that fetched them separately would render three of them against one window and
 * the fourth against another — a p95 next to a trend computed over a different
 * span of time is two answers to one question. The trace is `null` unless one
 * was asked for; the drill-in is a second call with the same scope, so the
 * aggregate behind it stays put while the reader moves between traces.
 *
 * Written as a named interface rather than inferred from the handler because
 * `ApiType` serialises every route's response into one type for the browser
 * client, and an anonymous nested literal here was enough to push that past what
 * TypeScript will serialise at all (TS7056, on `hc<ApiType>` in
 * `web/src/shared/api.ts`). A name costs nothing and keeps the client's type
 * legible instead of merely large.
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

export const getTelemetry = (async (ctx, _req, _params, query) => {
  const scope = toScope(query);
  const windowMs = query.windowMs ?? DEFAULT_WINDOW_MS;
  // An explicit range wins; otherwise the last `windowMs`. Both are clamped to
  // retention inside the store, which is the one place that knows how far back
  // rows actually go.
  const window =
    query.from !== undefined && query.to !== undefined && query.to > query.from
      ? { from: query.from, to: query.to }
      : recentWindow(windowMs);
  const spans = query.trace ? readTrace(ctx.db, query.trace) : [];
  // A trace id that matches nothing is the one case worth refusing rather than
  // reporting empty: unlike a scope id, it was copied from a list this endpoint
  // itself produced, so nothing there means the trace aged out from under the
  // reader, and an empty waterfall would read as "it took no time".
  //
  // `not_found` and not `bad`'s `operation_refused`: the request is well formed
  // and nothing is being refused — the thing it named is gone, which is what the
  // rest of the panel returns for a row a delete or a retention pass removed.
  if (query.trace && spans.length === 0) return failure("that trace is no longer stored", 404);
  const report: TelemetryReport = {
    scope: query.scope,
    windowMs,
    window,
    dataWindow: spanExtent(ctx.db, scope),
    stages: stageStats(ctx.db, scope, window),
    traces: traceList(ctx.db, scope, TRACE_LIMIT, window),
    trend: trend(ctx.db, scope, query.bucketMs ?? DEFAULT_BUCKET_MS, window),
    flame: foldedStacks(ctx.db, scope, window),
    slices: scope.kind === "group" ? sliceCosts(ctx.db, scope.id, window) : [],
    trace: query.trace ? { traceId: query.trace, spans: spans.map(toWaterfallSpan) } : null,
  };
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
