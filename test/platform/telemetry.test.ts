import { afterAll, beforeEach, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { makeApp } from "../../src/composition/api.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { MAX_REQUEST_SERIES, metricViews, prometheus } from "../../src/platform/observability/metrics.ts";
import { installTracerProvider } from "../../src/platform/observability/traces.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { testContext } from "../support/test-context.ts";

/**
 * A provider of this test's own. The process-wide default exports nothing, so
 * spans would be unobservable; the global `@opentelemetry/api` registry is never
 * touched by either.
 */
const spans = new InMemorySpanExporter();
const recording = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
afterAll(() => installTracerProvider(new NodeTracerProvider()));

// Reinstalled per test, not once: any file in this process may drive a real
// shutdown, which swaps the installed provider for a fresh one. A test that
// only worked when it ran before that file would not be a test.
beforeEach(() => {
  spans.reset();
  installTracerProvider(recording);
});

const finished = (name: string): ReadableSpan => {
  const span = spans.getFinishedSpans().find((s) => s.name === name);
  if (!span)
    throw new Error(
      `no span named ${name}; saw ${spans
        .getFinishedSpans()
        .map((s) => s.name)
        .join(", ")}`,
    );
  return span;
};

const INCOMING_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const INCOMING_SPAN = "00f067aa0ba902b7";

test("an incoming traceparent continues that trace and the response names the new span", async () => {
  const ctx = testContext();
  try {
    const response = await makeApp(ctx)(
      new Request("http://x/healthz", { headers: { traceparent: `00-${INCOMING_TRACE}-${INCOMING_SPAN}-01` } }),
    );

    const span = finished("GET /healthz");
    expect(span.spanContext().traceId).toBe(INCOMING_TRACE);
    expect(span.parentSpanContext?.spanId).toBe(INCOMING_SPAN);
    expect(response.headers.get("traceparent")).toBe(`00-${INCOMING_TRACE}-${span.spanContext().spanId}-01`);
    expect(span.spanContext().spanId).not.toBe(INCOMING_SPAN);
  } finally {
    ctx.db.close();
  }
});

test("a malformed traceparent starts a fresh trace rather than adopting a broken parent", async () => {
  const ctx = testContext();
  try {
    const response = await makeApp(ctx)(new Request("http://x/healthz", { headers: { traceparent: "garbage" } }));
    expect(response.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(finished("GET /healthz").parentSpanContext).toBeUndefined();
  } finally {
    ctx.db.close();
  }
});

test("a job span joins the trace recorded on its job row", async () => {
  const db = openMemory();
  try {
    const scheduler = new Scheduler(db, async () => {});
    scheduler.enqueue("watchdog", { traceId: INCOMING_TRACE, parentSpanId: INCOMING_SPAN });
    scheduler.tick();
    await scheduler.drain();

    const span = finished("job watchdog");
    expect(span.spanContext().traceId).toBe(INCOMING_TRACE);
    expect(span.parentSpanContext?.spanId).toBe(INCOMING_SPAN);
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes["job.status"]).toBe("done");
  } finally {
    db.close();
  }
});

test("a failed job records an error span", async () => {
  const db = openMemory();
  try {
    const scheduler = new Scheduler(db, async () => {
      throw new Error("handler exploded");
    });
    scheduler.enqueue("watchdog", {});
    scheduler.tick();
    await scheduler.drain();

    const span = finished("job watchdog");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["job.status"]).toBe("failed");
  } finally {
    db.close();
  }
});

test("a 500 response records an error span carrying the route, not the path", async () => {
  const ctx = testContext();
  try {
    ctx.db.run("DROP TABLE grp");
    const response = await makeApp(ctx)(new Request("http://x/api/v1/state"));
    expect(response.status).toBe(500);

    const span = finished("GET /api/v1/state");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["http.response.status_code"]).toBe(500);
    expect(span.attributes["http.route"]).toBe("/api/v1/state");
  } finally {
    ctx.db.close();
  }
});

test("a 2xx response records an ok span", async () => {
  const ctx = testContext();
  try {
    await makeApp(ctx)(new Request("http://x/healthz"));
    expect(finished("GET /healthz").status.code).toBe(SpanStatusCode.OK);
  } finally {
    ctx.db.close();
  }
});

class PullReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

test("the configured ceiling collapses excess request series instead of growing", async () => {
  // The real instruments are process-wide, so filling their budget here would
  // push every other metric assertion in the suite into overflow. Same views,
  // throwaway provider.
  const reader = new PullReader();
  const provider = new MeterProvider({ readers: [reader], views: metricViews });
  try {
    const requests = provider.getMeter("orchestrator").createCounter("orchestrator_http_requests_total");
    for (let i = 0; i < MAX_REQUEST_SERIES * 2; i += 1) {
      requests.add(1, { method: "GET", route: `/probe-${i}`, status: "404" });
    }

    const text = new PrometheusSerializer(undefined, false, undefined, true, true).serialize(
      (await reader.collect()).resourceMetrics,
    );
    const series = text.split("\n").filter((line) => line.startsWith("orchestrator_http_requests_total{"));

    expect(series.length).toBeLessThanOrEqual(MAX_REQUEST_SERIES);
    expect(text).toContain("otel_metric_overflow");
    expect(text).not.toContain("/probe-1023");
  } finally {
    await provider.shutdown();
  }
});

test("a scrape reports job state, retries and telemetry loss under the orchestrator names", async () => {
  const ctx = testContext();
  try {
    const scheduler = new Scheduler(ctx.db, async () => {});
    scheduler.enqueue("watchdog", {});
    const text = await prometheus(ctx.db);

    expect(text).toContain("orchestrator_http_requests_total");
    expect(text).toContain("orchestrator_event_loop_delay_seconds");
    expect(text).toContain('orchestrator_jobs{state="pending"} 1');
    expect(text).toContain("orchestrator_telemetry_dropped_total 0");
    // The serializer's own scope and resource series would change the label set
    // of every series a dashboard already queries.
    expect(text).not.toContain("otel_scope_name");
    expect(text).not.toContain("target_info");
  } finally {
    ctx.db.close();
  }
});

test("a drained queue reports zero rather than keeping the depth it last had", async () => {
  const ctx = testContext();
  try {
    const scheduler = new Scheduler(ctx.db, async () => {});
    scheduler.enqueue("watchdog", {});
    expect(await prometheus(ctx.db)).toContain('orchestrator_jobs{state="pending"} 1');

    ctx.db.run("DELETE FROM job");
    expect(await prometheus(ctx.db)).toContain('orchestrator_jobs{state="pending"} 0');
  } finally {
    ctx.db.close();
  }
});
