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
  stageStats,
  traceList,
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
      traceFlags: request.span.spanContext().traceFlags,
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
      traceFlags: request.span.spanContext().traceFlags,
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
  // Through the production writer, which already owns this table's column list.
  // One trace, so the rows are siblings rather than unrelated spans.
  writeSpans(db, [
    {
      traceId: "a".repeat(32),
      spanId,
      parentSpanId: null,
      name: "x",
      kind: "internal",
      startedAt,
      durationMs: 1,
      status: "ok",
      statusMessage: null,
      attributes: {},
    },
  ]);
}

const remaining = (db: DB): string[] =>
  db
    .query<{ span_id: string }, []>("SELECT span_id FROM span ORDER BY started_at, span_id")
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
    statusMessage: null,
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

/**
 * Why a stage failed, which the table had nowhere to keep.
 *
 * The count answered "is this broken" and nothing answered "what do I do". One
 * real case: `index.ask` had failed 2,835 times in a day at 21s each, and the
 * reason — no credential for the index runtime — took a query against the
 * database to find. It is the newest failure rather than the commonest, because a
 * stage that recovered should stop explaining how it used to break.
 */
test("a stage carries its newest failure's reason, and a healthy one carries none", () => {
  const db = openMemory();
  const t0 = Date.now() - 60_000;
  const fail = (spanId: string, at: number, message: string) =>
    writeSpans(db, [
      {
        traceId: spanId.padStart(32, "0"),
        spanId,
        parentSpanId: null,
        name: "index.ask",
        kind: "internal",
        startedAt: at,
        durationMs: 21_000,
        status: "error",
        statusMessage: message,
        attributes: {},
      },
    ]);
  fail("1".repeat(16), t0, "exit 127");
  fail("2".repeat(16), t0 + 1_000, "no credential for codex");
  writeSpans(db, [
    {
      traceId: "9".repeat(32),
      spanId: "9".repeat(16),
      parentSpanId: null,
      name: "git.ls_tree",
      kind: "internal",
      startedAt: t0,
      durationMs: 10,
      status: "ok",
      statusMessage: null,
      attributes: {},
    },
  ]);
  const byName = new Map(stageStats(db, { kind: "system" }).map((s) => [s.name, s]));
  expect(byName.get("index.ask")).toMatchObject({ errors: 2, reason: "no credential for codex" });
  expect(byName.get("git.ls_tree")).toMatchObject({ errors: 0, reason: null });
});

/**
 * The twenty a reader is offered, when there are more than twenty to choose from.
 *
 * `traceList` narrows to its candidates before the window functions run, so the
 * candidate ranking is now a second place the order is decided and a second place
 * it can disagree with itself. Every part of that key is exercised here: the tie
 * on `started_at`, and a long-running old trace whose newest span is the newest in
 * the scope — ranking on the latest span rather than the earliest would put it top.
 */
test("the trace list is the newest-starting traces, whole, and the tie-break holds", () => {
  const db = openMemory();
  const t0 = 1_800_000_000_000;
  const write = (trace: number, span: number, startedAt: number, name: string, failed = false) =>
    writeSpans(db, [
      {
        traceId: String(trace).padStart(32, "0"),
        spanId: `${trace}-${span}`.padStart(16, "0"),
        parentSpanId: span === 0 ? null : `${trace}-0`.padStart(16, "0"),
        name,
        kind: "internal",
        startedAt,
        durationMs: 10,
        status: failed ? "error" : "ok",
        statusMessage: null,
        attributes: {},
      },
    ]);

  // Twenty-five traces, newest last, with a tie at each end of the cut: 23 starts
  // with 24, and 4 starts with 5 — the last one that fits. The order among tied
  // traces is `trace_id DESC`, at the top of the list and at the boundary alike.
  for (let trace = 0; trace < 25; trace++) {
    const start = t0 + (trace === 23 ? 24 : trace === 4 ? 5 : trace) * 1_000;
    write(trace, 0, start, "turn");
    write(trace, 1, start + 500, "turn.provider", trace === 24);
  }
  // The oldest trace, still running: its newest span is the newest in the scope.
  write(0, 2, t0 + 100_000, "turn.late");

  const traces = traceList(db, { kind: "system" }, 20, { from: t0 - 1, to: t0 + 200_000 });

  expect(traces.map((t) => t.traceId)).toEqual(
    [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5].map((n) =>
      String(n).padStart(32, "0"),
    ),
  );
  // The summary covers the whole trace, not the span the ranking found it by.
  expect(traces[0]).toMatchObject({ name: "turn", startedAt: t0 + 24_000, durationMs: 510, failed: true });
  expect(traces[1]?.failed).toBe(false);
});
