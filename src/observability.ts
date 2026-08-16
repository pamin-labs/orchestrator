import { monitorEventLoopDelay } from "node:perf_hooks";
import { consola, type ConsolaReporter } from "consola";
import { scrub } from "./mech/util/scrub.ts";
import { requestContext } from "./http/request-context.ts";
import type { DB } from "./db.ts";

export interface RuntimeStatus {
  accepting: boolean;
  ready: boolean;
  checks: ReadonlyArray<{ name: string; ok: boolean; detail: string }>;
  startedAt: number;
}

export function runtimeStatus(ready = true): RuntimeStatus {
  return { accepting: true, ready, checks: [], startedAt: Date.now() };
}

const requests = new Map<string, { count: number; seconds: number }>();
const retries = new Map<string, number>();
const caches = new Map<string, { hits: number; misses: number; size: number }>();
const MAX_REQUEST_SERIES = 512;
const MAX_OTLP_EXPORTS = 8;
let activeExports = 0;
let droppedExports = 0;
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

function routeLabel(path: string): string {
  if (path.startsWith("/api/v1/attach/")) return "/api/v1/attach/:name";
  return path.replace(/\/\d+(?=\/|$)/g, "/:id");
}

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export interface Trace {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  started: bigint;
  startedUnixNano: bigint;
}

export function startTrace(traceparent?: string): Trace {
  const incoming = traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  return {
    traceId: incoming?.[1]?.toLowerCase() ?? crypto.randomUUID().replaceAll("-", ""),
    spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    ...(incoming?.[2] ? { parentSpanId: incoming[2].toLowerCase() } : {}),
    started: process.hrtime.bigint(),
    startedUnixNano: BigInt(Date.now()) * 1_000_000n,
  };
}

export function startChildTrace(traceId?: string | null, parentSpanId?: string | null): Trace {
  return {
    traceId: traceId ?? crypto.randomUUID().replaceAll("-", ""),
    spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    ...(parentSpanId ? { parentSpanId } : {}),
    started: process.hrtime.bigint(),
    startedUnixNano: BigInt(Date.now()) * 1_000_000n,
  };
}

export function traceparent(trace: Trace): string {
  return `00-${trace.traceId}-${trace.spanId}-01`;
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
  lines.push(`orchestrator_telemetry_dropped_total ${droppedExports}`);
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

function exportSpan(
  name: string,
  kind: number,
  failed: boolean,
  seconds: number,
  trace: Trace,
  attributes: Array<{ key: string; value: { stringValue: string } | { intValue: number } }>,
): void {
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, "");
  if (!base) return;
  if (activeExports >= MAX_OTLP_EXPORTS) {
    droppedExports += 1;
    return;
  }
  const ended = trace.startedUnixNano + BigInt(Math.round(seconds * 1e9));
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "orchestrator" } }] },
        scopeSpans: [
          {
            scope: { name: "orchestrator.http" },
            spans: [
              {
                traceId: trace.traceId,
                spanId: trace.spanId,
                ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
                name,
                kind,
                startTimeUnixNano: trace.startedUnixNano.toString(),
                endTimeUnixNano: ended.toString(),
                attributes,
                status: { code: failed ? 2 : 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  activeExports += 1;
  void fetch(`${base}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  })
    .catch(() => {})
    .finally(() => {
      activeExports -= 1;
    });
}

export function configureStructuredLogging(): void {
  if (process.env.ORCH_LOG_FORMAT !== "json") return;
  const reporter: ConsolaReporter = {
    log(entry) {
      const context = requestContext.getStore();
      const args = entry.args.map((arg) => scrub(arg instanceof Error ? (arg.stack ?? arg.message) : String(arg)));
      process.stdout.write(
        JSON.stringify({
          timestamp: entry.date.toISOString(),
          level: entry.type,
          message: args.join(" "),
          ...(context
            ? {
                request_id: context.requestId,
                trace_id: context.traceId,
                span_id: context.spanId,
                ...(context.jobId === undefined ? {} : { job_id: context.jobId }),
                ...(context.grpId === undefined ? {} : { group_id: context.grpId }),
                ...(context.agentId === undefined ? {} : { agent_id: context.agentId }),
                method: context.method,
                path: context.path,
              }
            : {}),
        }) + "\n",
      );
    },
  };
  consola.setReporters([reporter]);
}

export function closeTelemetry(): void {
  loop.disable();
}
