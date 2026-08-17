import { afterEach, expect, test } from "bun:test";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { observeHttp, prometheus } from "../../src/platform/observability/metrics.ts";
import { requestContext } from "../../src/platform/observability/request-context.ts";
import {
  readTrace,
  SPAN_MAX_AGE_MS,
  SqliteSpanExporter,
  trimSpans,
  writeSpans,
  type SpanRow,
} from "../../src/platform/observability/span-store.ts";
import { endSpan, installTracerProvider, startTrace } from "../../src/platform/observability/traces.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { heartbeat } from "../../src/composition/server.ts";
import { makeGithub } from "../../src/mech/git/github.ts";
import { Notifier } from "../../src/mech/ops/notify.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The production arrangement: the exporter behind the SDK's own
 * `BatchSpanProcessor`. Assertions run after a `forceFlush`, so what is checked
 * is what a reader would find on disk, not what the SDK held in memory — and the
 * flush path itself is under test rather than assumed.
 */
function recording(db: DB): NodeTracerProvider {
  const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(new SqliteSpanExporter(db))] });
  installTracerProvider(provider);
  return provider;
}

afterEach(() => installTracerProvider(new NodeTracerProvider()));

test("a span ended through the exporter is readable back as part of its trace", async () => {
  const db = openMemory();
  const provider = recording(db);

  const trace = startTrace();
  endSpan(trace, "POST /api/v1/ideas", false, { "grp.id": 4, "slice.id": 9, "http.route": "/api/v1/ideas" });
  // Nothing is on disk until the batch flushes, which is the point of batching.
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM span").get()!.c).toBe(0);
  await provider.forceFlush();

  const stored = readTrace(db, trace.traceId);
  expect(stored).toHaveLength(1);
  const span = stored[0]!;
  expect(span.spanId).toBe(trace.spanId);
  expect(span.name).toBe("POST /api/v1/ideas");
  expect(span.kind).toBe("server");
  expect(span.status).toBe("ok");
  expect(span.parentSpanId).toBeNull();
  expect(span.durationMs).toBeGreaterThanOrEqual(0);
  expect(span.attributes["http.route"]).toBe("/api/v1/ideas");
  // Scope comes off the span's own attributes, and a span that names none is a
  // system span rather than a row belonging to project zero.
  expect(span.grpId).toBe(4);
  expect(span.sliceId).toBe(9);
  expect(span.projectId).toBeNull();
});

test("a job's span joins the trace of the request that enqueued it, through storage", async () => {
  const db = openMemory();
  const provider = recording(db);

  // Exactly what a route does: a server span, and an enqueue inside its context.
  const request = startTrace();
  requestContext.run(
    {
      requestId: "r1",
      traceId: request.traceId,
      spanId: request.spanId,
      method: "POST",
      path: "/api/v1/ideas",
      signal: new AbortController().signal,
    },
    () => {
      new Scheduler(db, async () => {}).enqueue("watchdog", {});
    },
  );
  observeHttp("POST", "/api/v1/ideas", 200, request);

  // A different Scheduler, as a later tick in the same process is: the join must
  // survive the row, not a live object.
  const later = new Scheduler(db, async () => {});
  later.tick();
  await later.drain();
  await provider.forceFlush();

  const stored = readTrace(db, request.traceId);
  expect(stored.map((s) => s.name).sort()).toEqual(["POST /api/v1/ideas", "job watchdog"]);
  const job = stored.find((s) => s.name === "job watchdog")!;
  expect(job.kind).toBe("internal");
  expect(job.parentSpanId).toBe(request.spanId);
  expect(job.attributes["job.status"]).toBe("done");
});

test("a failed job's span records the failure rather than being dropped", async () => {
  const db = openMemory();
  const provider = recording(db);

  const sched = new Scheduler(db, async () => {
    throw new Error("boom");
  });
  const request = startTrace();
  requestContext.run(
    {
      requestId: "r2",
      traceId: request.traceId,
      spanId: request.spanId,
      method: "POST",
      path: "/api/v1/ideas",
      signal: new AbortController().signal,
    },
    () => sched.enqueue("watchdog", {}),
  );
  sched.tick();
  await sched.drain();
  await provider.forceFlush();

  const job = readTrace(db, request.traceId).find((s) => s.name === "job watchdog")!;
  expect(job.status).toBe("error");
  expect(job.attributes["job.status"]).toBe("failed");
});

/** The `orchestrator_telemetry_dropped_total` counter, read the way an operator would. */
async function droppedTotal(db: DB): Promise<number> {
  const line = (await prometheus(db)).split("\n").find((l) => l.startsWith("orchestrator_telemetry_dropped_total "));
  return Number(line?.split(" ")[1] ?? -1);
}

function insert(db: DB, spanId: string, startedAt: number): void {
  db.run(
    `INSERT INTO span (trace_id, span_id, name, kind, started_at, duration_ms, status, attributes_json)
     VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 'x', 'internal', ?, 1, 'ok', '{}')`,
    [spanId, startedAt],
  );
}

const remaining = (db: DB): string[] =>
  db
    .query<{ span_id: string }, []>("SELECT span_id FROM span ORDER BY started_at")
    .all()
    .map((r) => r.span_id);

test("retention drops spans past the age bound and keeps the ones inside it", () => {
  const db = openMemory();
  const now = 1_800_000_000_000;
  insert(db, "0000000000000001", now - SPAN_MAX_AGE_MS - 1);
  insert(db, "0000000000000002", now - SPAN_MAX_AGE_MS + 1);
  insert(db, "0000000000000003", now);

  trimSpans(db, now);

  expect(remaining(db)).toEqual(["0000000000000002", "0000000000000003"]);
});

test("retention drops the oldest rows past the count bound even when all are recent", () => {
  const db = openMemory();
  const now = 1_800_000_000_000;
  // The row bound is the backstop for a burst that never gets a chance to age
  // out, so every row here is inside the age bound on purpose.
  for (let i = 1; i <= 5; i++) insert(db, i.toString(16).padStart(16, "0"), now - (6 - i));

  trimSpans(db, now, 3);

  expect(remaining(db)).toEqual(["0000000000000003", "0000000000000004", "0000000000000005"]);
});

test("re-ingesting the same span is a no-op rather than a duplicate", () => {
  const db = openMemory();
  const row: SpanRow = {
    traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    spanId: "cccccccccccccccc",
    parentSpanId: null,
    name: "job gate",
    kind: "internal",
    startedAt: 1_800_000_000_000,
    durationMs: 12.5,
    status: "ok",
    attributes: { "job.kind": "gate" },
  };

  writeSpans(db, [row]);
  writeSpans(db, [row]);

  expect(readTrace(db, row.traceId)).toHaveLength(1);
});

test("a database failure is counted as telemetry loss, never thrown at the traced operation", async () => {
  const db = openMemory();
  const provider = recording(db);
  // The exporter prepared its insert against a table that is about to vanish —
  // the same shape as a handle closed under a late flush during shutdown.
  db.run("DROP TABLE span");
  const before = await droppedTotal(db);

  const trace = startTrace();
  // The half that matters: the work being traced never sees the write fail.
  expect(() => endSpan(trace, "GET /healthz", false, {})).not.toThrow();

  // The flush resolves rather than rejecting: it runs on the shutdown path, and
  // losing telemetry is not a reason to fail a clean shutdown. The loss is
  // reported through the counter instead, which is what an operator watches.
  const flush = await provider.forceFlush().then(
    () => "resolved",
    () => "rejected",
  );
  expect(flush).toBe("resolved");
  expect(await droppedTotal(db)).toBeGreaterThan(before);
});

test("the heartbeat is what runs retention, not the write path", async () => {
  const db = openMemory();
  const provider = recording(db);
  const now = Date.now();
  insert(db, "0000000000000009", now - SPAN_MAX_AGE_MS - 1);

  // Ending and flushing a span writes, and leaves the stale row alone.
  endSpan(startTrace(), "GET /healthz", false, {});
  await provider.forceFlush();
  expect(remaining(db)).toContain("0000000000000009");

  heartbeat({
    ctx: testContext({ db }),
    db,
    sched: { enqueue: () => 0, tick: () => 0 },
    // Real collaborators whose transports go nowhere, so nothing here reaches the
    // network or the boss.
    gh: makeGithub(db, () => Promise.reject(new Error("no network in tests"))),
    url: "http://x",
    notifier: new Notifier({ deliver: () => {} }),
    track: <T>(work: Promise<T>) => work,
    // Held pending so the tick cannot reach the network; retention is above that.
    inFlight: { index: new Promise<void>(() => {}), poll: new Promise<void>(() => {}) },
  });

  expect(remaining(db)).not.toContain("0000000000000009");
});
