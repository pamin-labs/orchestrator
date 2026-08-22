import { afterAll, beforeEach, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import {
  AlwaysOffSampler,
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { sql } from "drizzle-orm";
import { makeApp } from "../../src/composition/api.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { job } from "../../src/platform/persistence/schema.ts";
import { MAX_REQUEST_SERIES, metricViews, prometheus } from "../../src/platform/observability/metrics.ts";
import { installTracerProvider, startTrace, traceparent } from "../../src/platform/observability/traces.ts";
import { testContext } from "../support/test-context.ts";
import { newScheduler } from "../support/scheduler.ts";

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
  const ctx = await testContext();
  {
    const response = await makeApp(ctx)(
      new Request("http://x/healthz", { headers: { traceparent: `00-${INCOMING_TRACE}-${INCOMING_SPAN}-01` } }),
    );

    const span = finished("GET /healthz");
    expect(span.spanContext().traceId).toBe(INCOMING_TRACE);
    expect(span.parentSpanContext?.spanId).toBe(INCOMING_SPAN);
    expect(response.headers.get("traceparent")).toBe(`00-${INCOMING_TRACE}-${span.spanContext().spanId}-01`);
    expect(span.spanContext().spanId).not.toBe(INCOMING_SPAN);
  }
});

test("a malformed traceparent starts a fresh trace rather than adopting a broken parent", async () => {
  const ctx = await testContext();
  {
    const response = await makeApp(ctx)(new Request("http://x/healthz", { headers: { traceparent: "garbage" } }));
    expect(response.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(finished("GET /healthz").parentSpanContext).toBeUndefined();
  }
});

test("a job span joins the trace recorded on its job row", async () => {
  const db = await openMemory();
  {
    const scheduler = newScheduler(db, async () => {});
    await scheduler.enqueue("watchdog", { traceId: INCOMING_TRACE, parentSpanId: INCOMING_SPAN });
    void scheduler.tick();
    await scheduler.drain();

    const span = finished("job watchdog");
    expect(span.spanContext().traceId).toBe(INCOMING_TRACE);
    expect(span.parentSpanContext?.spanId).toBe(INCOMING_SPAN);
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes["job.status"]).toBe("done");
  }
});

test("a failed job records an error span", async () => {
  const db = await openMemory();
  {
    const scheduler = newScheduler(db, async () => {
      throw new Error("handler exploded");
    });
    await scheduler.enqueue("watchdog", {});
    void scheduler.tick();
    await scheduler.drain();

    const span = finished("job watchdog");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["job.status"]).toBe("failed");
  }
});

test("a 500 response records an error span carrying the route, not the path", async () => {
  const ctx = await testContext();
  {
    // Renamed and restored, not dropped: the file's database is emptied by name
    // between tests, and a dropped table would take every later one with it.
    await ctx.db.execute(sql`ALTER TABLE grp RENAME TO grp_gone`);
    try {
      const response = await makeApp(ctx)(new Request("http://x/api/v1/state"));
      expect(response.status).toBe(500);

      const span = finished("GET /api/v1/state");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["http.response.status_code"]).toBe(500);
      expect(span.attributes["http.route"]).toBe("/api/v1/state");
    } finally {
      await ctx.db.execute(sql`ALTER TABLE grp_gone RENAME TO grp`);
    }
  }
});

test("a 2xx response records an ok span", async () => {
  const ctx = await testContext();
  {
    await makeApp(ctx)(new Request("http://x/healthz"));
    expect(finished("GET /healthz").status.code).toBe(SpanStatusCode.OK);
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

/** The `orchestrator_telemetry_dropped_total` series, or -1 if it is missing. */
const dropped = (text: string): number => Number(/^orchestrator_telemetry_dropped_total (\d+)$/m.exec(text)?.[1] ?? -1);

test("a scrape reports job state, retries and telemetry loss under the orchestrator names", async () => {
  const ctx = await testContext();
  {
    const scheduler = newScheduler(ctx.db, async () => {});
    await scheduler.enqueue("watchdog", {});
    const text = await prometheus(ctx.db);

    expect(text).toContain("orchestrator_http_requests_total");
    expect(text).toContain("orchestrator_event_loop_delay_seconds");
    expect(text).toContain('orchestrator_jobs{state="pending"} 1');
    // The counter is process-wide and one Bun process runs every test file, so
    // another file may legitimately have recorded a drop before this one ran.
    // The wiring is proved by the series existing, being a number, and holding
    // still across a scrape where nothing was dropped — not by a literal zero,
    // which only passed while no test in the suite ever exercised a loss.
    expect(dropped(text)).toBeGreaterThanOrEqual(0);
    expect(dropped(await prometheus(ctx.db))).toBe(dropped(text));
    // The serializer's own scope and resource series would change the label set
    // of every series a dashboard already queries.
    expect(text).not.toContain("otel_scope_name");
    expect(text).not.toContain("target_info");
  }
});

test("a drained queue reports zero rather than keeping the depth it last had", async () => {
  const ctx = await testContext();
  {
    const scheduler = newScheduler(ctx.db, async () => {});
    await scheduler.enqueue("watchdog", {});
    expect(await prometheus(ctx.db)).toContain('orchestrator_jobs{state="pending"} 1');

    await ctx.db.delete(job);
    expect(await prometheus(ctx.db)).toContain('orchestrator_jobs{state="pending"} 0');
  }
});

test("traceparent carries the span's own sampled flag, not a hard-coded one", () => {
  // The header was built as `00-<trace>-<span>-01`, with the flags written
  // literally. Every span is sampled today, so it was latent — but the first
  // sampler configured makes this advertise SAMPLED downstream for a trace this
  // process dropped, and the receiver keeps it on our word.
  installTracerProvider(new NodeTracerProvider({ sampler: new AlwaysOffSampler() }));
  expect(traceparent(startTrace())).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
});

/**
 * An upstream that says it is not sampling is not overruled here.
 *
 * `remoteParent` built the incoming span context with `traceFlags: SAMPLED`
 * regardless of what the header said — the regex captured the trace id and the span
 * id and dropped the flags. So a caller that had decided against this trace got it
 * back from us marked kept, and every downstream service we then called was told the
 * same. The outgoing half of this was fixed on its own; the inbound half is where
 * the wrong value came from.
 */
test("a traceparent that says not-sampled stays not-sampled through this process", () => {
  const notSampled = startTrace(`00-${INCOMING_TRACE}-${INCOMING_SPAN}-00`);
  expect(notSampled.span.spanContext().traceFlags).toBe(0);
  expect(traceparent(notSampled)).toBe(`00-${INCOMING_TRACE}-${notSampled.span.spanContext().spanId}-00`);

  const sampled = startTrace(`00-${INCOMING_TRACE}-${INCOMING_SPAN}-01`);
  expect(sampled.span.spanContext().traceFlags).toBe(1);
});
