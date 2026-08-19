import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Attributes } from "@opentelemetry/api";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationType, MeterProvider, MetricReader, type ViewOptions } from "@opentelemetry/sdk-metrics";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions";
import { JOB_STATES } from "../../contracts/states.ts";
import type { DB } from "../persistence/database.ts";
import { endSpan, shutdownTracing, type Trace } from "./traces.ts";

/**
 * What this process counts about itself, rendered for Prometheus.
 *
 * Separate from `traces.ts` because the failure modes differ: these are numbers held
 * in this process and read on request, so nothing here can be lost to a collector
 * being down. What they share is the observation call — an HTTP request produces
 * both a counter and a span — so `observeHttp` sits here and hands the span off.
 */
/**
 * `/metrics` is loopback-only (ADR 012), so this module renders text for that
 * existing route and never listens anywhere. `PrometheusExporter` is deliberately
 * not used: it starts its own server on every interface and would walk around that
 * gate.
 */

/**
 * A ceiling on distinct label combinations.
 *
 * Route labels derive from request paths, so an unmatched path is attacker-chosen
 * input to state that is never cleared. Past the ceiling the SDK collapses
 * everything into one `otel_metric_overflow` series: the metric stops being
 * precise rather than the process running out of memory.
 */
export const MAX_REQUEST_SERIES = 512;

const HTTP_DURATION = "orchestrator_http_request_duration_seconds";

/**
 * Exported so the ceiling can be proven against the real configuration.
 *
 * The instruments below are process-wide, so a test that filled 512 series to
 * watch them collapse would push every other series in the suite into overflow
 * with them. Building a throwaway provider from this same array proves the
 * limit without spending the running process's budget.
 */
export const metricViews: ViewOptions[] = [
  { instrumentName: "orchestrator_http_requests_total", aggregationCardinalityLimit: MAX_REQUEST_SERIES },
  {
    instrumentName: HTTP_DURATION,
    aggregationCardinalityLimit: MAX_REQUEST_SERIES,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
    },
  },
];

/** Pull-only. `/metrics` calls `collect()`; nothing is pushed and no port is opened. */
class PullReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

const reader = new PullReader();

const meterProvider = new MeterProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "orchestrator" }),
  readers: [reader],
  views: metricViews,
});

const meter = meterProvider.getMeter("orchestrator");

const httpRequests = meter.createCounter("orchestrator_http_requests_total", {
  description: "Completed HTTP requests.",
});
const httpDuration = meter.createHistogram(HTTP_DURATION, {
  description: "Time to complete an HTTP request.",
  unit: "s",
});
const retries = meter.createCounter("orchestrator_retries_total", { description: "Retried operations by owner." });
const cacheRequests = meter.createCounter("orchestrator_cache_requests_total", {
  description: "Cache lookups by owner and result.",
});
const cacheEntries = meter.createGauge("orchestrator_cache_entries", { description: "Entries held by owner." });
const droppedTelemetry = meter.createCounter("orchestrator_telemetry_dropped_total", {
  description: "Spans the exporter failed to deliver.",
});
// Seeded so the series exists at zero. A counter that only appears after the
// first loss reads as "no data" on the dashboard that is watching for loss.
droppedTelemetry.add(0);

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

meter
  .createObservableGauge("orchestrator_event_loop_delay_seconds", {
    description: "Event loop delay observed by the process.",
    unit: "s",
  })
  .addCallback((result) => {
    result.observe(Number.isFinite(loop.mean) ? loop.mean / 1e9 : 0, { stat: "mean" });
    result.observe(loop.max / 1e9, { stat: "max" });
  });

meter
  .createObservableGauge("process_resident_memory_bytes", { description: "Resident set size.", unit: "By" })
  .addCallback((result) => result.observe(process.memoryUsage().rss));

meter
  .createObservableGauge("process_heap_bytes", { description: "Heap in use and reserved.", unit: "By" })
  .addCallback((result) => {
    const memory = process.memoryUsage();
    result.observe(memory.heapUsed, { kind: "used" });
    result.observe(memory.heapTotal, { kind: "total" });
  });

/**
 * The database this scrape reads job counts from.
 *
 * Job state lives in SQLite, not in a counter here, so it is queried at
 * collection time. `prometheus()` sets this immediately before `collect()` runs
 * the callback synchronously, and clears it after, so no handle outlives a scrape.
 */
let scrapeDb: DB | undefined;

meter.createObservableGauge("orchestrator_jobs", { description: "Jobs by lifecycle state." }).addCallback((result) => {
  if (!scrapeDb) return;
  const rows = scrapeDb
    .query<{ state: string; count: number }, []>("SELECT state, count(*) AS count FROM job GROUP BY state")
    .all();
  const counts = new Map(rows.map((row) => [row.state, row.count]));
  // Every state is observed, including the empty ones. A gauge keeps its last
  // value for an attribute set nobody reported this cycle, so reporting only the
  // states that have rows would leave a drained queue showing its old depth
  // forever — the reading an operator is most likely to act on.
  for (const state of JOB_STATES) result.observe(counts.get(state) ?? 0, { state });
});

export interface RuntimeStatus {
  accepting: boolean;
  ready: boolean;
  checks: ReadonlyArray<{ name: string; ok: boolean; detail: string }>;
  startedAt: number;
}

export function runtimeStatus(ready = true): RuntimeStatus {
  return { accepting: true, ready, checks: [], startedAt: Date.now() };
}

/** Numeric path segments are ids, and an id in a label is an unbounded series. */
function routeLabel(path: string): string {
  if (path.startsWith("/api/v1/attach/")) return "/api/v1/attach/:name";
  return path.replace(/\/\d+(?=\/|$)/g, "/:id");
}

/**
 * What a span is about, when it is about anything.
 *
 * Every field is optional and stays optional: a `/healthz` request, the retention
 * trim and the watchdog belong to no project. An absent id is written as NULL rather
 * than guessed — a wrong one aggregates somebody else's time into a group.
 *
 * Kept out of metric labels deliberately: these are unbounded identifiers, and a
 * span is where an unbounded dimension belongs.
 */
export interface SpanScope {
  projectId?: number | null;
  grpId?: number | null;
  sliceId?: number | null;
}

export function scopeAttributes(scope: SpanScope): Attributes {
  return {
    ...(scope.projectId ? { "project.id": scope.projectId } : {}),
    ...(scope.grpId ? { "grp.id": scope.grpId } : {}),
    ...(scope.sliceId ? { "slice.id": scope.sliceId } : {}),
  };
}

export function observeHttp(method: string, path: string, status: number, trace: Trace, scope: SpanScope = {}): void {
  const seconds = Number(process.hrtime.bigint() - trace.started) / 1e9;
  const route = routeLabel(path);
  const attributes = { method, route, status: String(status) };
  httpRequests.add(1, attributes);
  httpDuration.record(seconds, attributes);
  endSpan(trace, `${method} ${route}`, status >= 500, {
    [ATTR_HTTP_REQUEST_METHOD]: method,
    [ATTR_HTTP_ROUTE]: route,
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: status,
    ...scopeAttributes(scope),
  });
}

export function observeJob(kind: string, ok: boolean, trace: Trace, scope: SpanScope = {}): void {
  endSpan(trace, `job ${kind}`, !ok, {
    "job.kind": kind,
    "job.status": ok ? "done" : "failed",
    ...scopeAttributes(scope),
  });
}

export function recordRetry(owner: string): void {
  retries.add(1, { owner });
}

export function recordCache(owner: string, hit: boolean, size: number): void {
  cacheRequests.add(1, { owner, result: hit ? "hit" : "miss" });
  cacheEntries.record(size, { owner });
}

/** Spans that left the queue but never landed. Counted so the loss is visible. */
export function recordDroppedSpans(count: number): void {
  droppedTelemetry.add(count);
}

/**
 * The Prometheus text for one scrape.
 *
 * `target_info` and the `otel_scope_*` labels the serializer adds by default are
 * suppressed: they carry no information a single-service process needs and would
 * change every existing series' label set.
 */
export async function prometheus(db: DB): Promise<string> {
  scrapeDb = db;
  try {
    const collected = await reader.collect();
    return new PrometheusSerializer(undefined, false, undefined, true, true).serialize(collected.resourceMetrics);
  } finally {
    scrapeDb = undefined;
  }
}

/**
 * Stops the event-loop sampler, which otherwise keeps the process alive, and gives
 * the span processor a last chance to flush.
 *
 * The meter provider is deliberately never shut down. It is pull-only — no timer, no
 * connection, no buffered data — so shutting it down releases nothing and only makes
 * the reader permanently dead. This is called by the server's shutdown path *and* by
 * any test that drives a real shutdown, and one Bun process runs every test file, so
 * a shut-down reader turns every later scrape into "MetricReader is shutdown".
 */
export function closeTelemetry(): void {
  loop.disable();
  void shutdownTracing().catch(() => {});
}
