import { monitorEventLoopDelay } from "node:perf_hooks";
import type { DB } from "../persistence/database.ts";
import { droppedSpans, exportSpan, type Trace } from "./traces.ts";

/**
 * What this process counts about itself, rendered for Prometheus.
 *
 * Separate from `traces.ts` because the failure modes differ: these are numbers
 * held in this process and read on request, so nothing here can be lost to a
 * collector being down. What they share is the observation call — an HTTP
 * request produces both a counter and a span — so `observeHttp` sits here and
 * hands the span off.
 */

const requests = new Map<string, { count: number; seconds: number }>();
const retries = new Map<string, number>();
const caches = new Map<string, { hits: number; misses: number; size: number }>();

/**
 * A ceiling on distinct label combinations.
 *
 * Route labels come from request paths, so an unmatched path is attacker-chosen
 * input to a map that is never cleared. Past the ceiling everything collapses
 * into one `overflow` series: the metric stops being precise rather than the
 * process running out of memory.
 */
const MAX_REQUEST_SERIES = 512;

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

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

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function observeHttp(method: string, path: string, status: number, trace: Trace): void {
  const seconds = Number(process.hrtime.bigint() - trace.started) / 1e9;
  const route = routeLabel(path);
  const candidate = `${method}\0${route}\0${status}`;
  const key =
    requests.has(candidate) || requests.size < MAX_REQUEST_SERIES ? candidate : `${method}\0overflow\0${status}`;
  const current = requests.get(key) ?? { count: 0, seconds: 0 };
  current.count += 1;
  current.seconds += seconds;
  requests.set(key, current);
  exportSpan(`${method} ${route}`, 2, status >= 500, seconds, trace, [
    { key: "http.request.method", value: { stringValue: method } },
    { key: "http.route", value: { stringValue: route } },
    { key: "http.response.status_code", value: { intValue: status } },
  ]);
}

export function observeJob(kind: string, ok: boolean, trace: Trace): void {
  const seconds = Number(process.hrtime.bigint() - trace.started) / 1e9;
  exportSpan(`job ${kind}`, 1, !ok, seconds, trace, [
    { key: "job.kind", value: { stringValue: kind } },
    { key: "job.status", value: { stringValue: ok ? "done" : "failed" } },
  ]);
}

export function recordRetry(owner: string): void {
  retries.set(owner, (retries.get(owner) ?? 0) + 1);
}

export function recordCache(owner: string, hit: boolean, size: number): void {
  const cache = caches.get(owner) ?? { hits: 0, misses: 0, size: 0 };
  if (hit) cache.hits += 1;
  else cache.misses += 1;
  cache.size = size;
  caches.set(owner, cache);
}

export function prometheus(db?: DB): string {
  const lines = [
    "# HELP orchestrator_http_requests_total Completed HTTP requests.",
    "# TYPE orchestrator_http_requests_total counter",
  ];
  for (const [key, value] of [...requests].sort(([a], [b]) => a.localeCompare(b))) {
    const [method, route, status] = key.split("\0");
    const labels = `method="${label(method!)}",route="${label(route!)}",status="${label(status!)}"`;
    lines.push(`orchestrator_http_requests_total{${labels}} ${value.count}`);
    lines.push(`orchestrator_http_request_duration_seconds_sum{${labels}} ${value.seconds}`);
    lines.push(`orchestrator_http_request_duration_seconds_count{${labels}} ${value.count}`);
  }
  lines.push("# HELP orchestrator_event_loop_delay_seconds Event loop delay observed by the process.");
  lines.push("# TYPE orchestrator_event_loop_delay_seconds gauge");
  lines.push(`orchestrator_event_loop_delay_seconds{stat="mean"} ${Number.isFinite(loop.mean) ? loop.mean / 1e9 : 0}`);
  lines.push(`orchestrator_event_loop_delay_seconds{stat="max"} ${loop.max / 1e9}`);
  const memory = process.memoryUsage();
  lines.push("# TYPE process_resident_memory_bytes gauge");
  lines.push(`process_resident_memory_bytes ${memory.rss}`);
  lines.push("# TYPE process_heap_bytes gauge");
  lines.push(`process_heap_bytes{kind="used"} ${memory.heapUsed}`);
  lines.push(`process_heap_bytes{kind="total"} ${memory.heapTotal}`);
  lines.push("# TYPE orchestrator_telemetry_dropped_total counter");
  lines.push(`orchestrator_telemetry_dropped_total ${droppedSpans()}`);
  for (const [owner, count] of retries) {
    lines.push(`orchestrator_retries_total{owner="${label(owner)}"} ${count}`);
  }
  for (const [owner, cache] of caches) {
    lines.push(`orchestrator_cache_requests_total{owner="${label(owner)}",result="hit"} ${cache.hits}`);
    lines.push(`orchestrator_cache_requests_total{owner="${label(owner)}",result="miss"} ${cache.misses}`);
    lines.push(`orchestrator_cache_entries{owner="${label(owner)}"} ${cache.size}`);
  }
  if (db) {
    const jobs = db
      .query<{ state: string; count: number }, []>("SELECT state, count(*) AS count FROM job GROUP BY state")
      .all();
    for (const job of jobs) {
      lines.push(`orchestrator_jobs{state="${label(job.state)}"} ${job.count}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Stops the event-loop sampler, which otherwise keeps the process alive. */
export function closeTelemetry(): void {
  loop.disable();
}
