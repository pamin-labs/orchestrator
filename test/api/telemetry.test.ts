import { loadConfig } from "../../src/platform/config/load.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { JsonObject } from "../../src/contracts/json.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { getTelemetry, TelemetryQuery, type TelemetryReport } from "../../src/api/panel/telemetry.ts";
import { TelemetryReportSchema } from "../../web/src/shared/api.ts";
import { SPAN_MAX_AGE_MS, writeSpans, type SpanRow } from "../../src/platform/observability/span-store.ts";
import { testContext } from "../support/test-context.ts";

/**
 * One read endpoint, three scopes.
 *
 * The handler is called with its four arguments and no server: what is under
 * test is the contract — which scopes are accepted, what a scope excludes, and
 * what an absent trace does — and none of that needs Hono to be running. The
 * query schema is exercised directly for the same reason, since it is where the
 * "system takes no id" rule actually lives.
 */

const NOW = Date.now();
/**
 * A context whose report cache cannot outlive the test that filled it.
 *
 * `getTelemetry` caches per `ctx.db` *object*, and `openMemory()` hands out one
 * object for the whole process — so a truncate empties the rows and leaves the
 * cached report, and the next test reads the previous one's answer. A 1ms TTL is
 * the isolation a fresh database used to give. The two tests that are about the
 * cache own their database instead and keep the shipped TTL.
 */
const ctx = () => testContext({ config: { ...loadConfig(), telemetryCacheMs: 1 } });

/**
 * A database of this file's own, for the two tests that need a second one.
 *
 * The cache is keyed on the database *object*, and `openMemory()` hands out a new
 * wrapper per call, so two calls are two databases as far as it is concerned —
 * which is exactly the question these two tests ask.
 */
const ownDatabase = async (logger?: { logQuery: () => void }, isolate = "") => ({
  db: await openMemory(logger, isolate),
});

function span(over: Partial<SpanRow> & { attributes: Record<string, unknown> }): SpanRow {
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: null,
    name: "turn",
    kind: "internal",
    startedAt: NOW - 1_000,
    durationMs: 10,
    status: "ok",
    statusMessage: null,
    ...over,
  };
}

const parse = (query: Record<string, string>) => TelemetryQuery.safeParse(query);

/** The handler's body, already parsed. Every assertion below reads one of these. */
async function report(context: Ctx, query: Record<string, string>): Promise<{ status: number; body: TelemetryReport }> {
  const parsed = parse(query);
  if (!parsed.success) throw new Error(`query rejected: ${parsed.error.message}`);
  const response = await getTelemetry(context, new Request("http://x/"), {}, parsed.data);
  // Parsed, not asserted. `json()` returns `any`, so an `as` would let a
  // response that stopped matching the contract keep compiling — and the schema
  // used is the browser's own, so every assertion below also proves that what
  // this handler emits is what the panel is prepared to accept. `/telemetry` is
  // registered outside `ApiType` for the TS7056 reason recorded at its
  // registration, so this is where the two ends are checked against each other.
  const body = TelemetryReportSchema.parse(await response.json());
  return { status: response.status, body };
}

/**
 * The query the panel sends, and everything a hand-typed URL can send instead.
 *
 * A case per query, because the query *is* the finding: as one test per rule
 * this printed `expected false, received true` and left the reader to work out
 * which of four ids the schema had started accepting.
 */
describe("the telemetry query is validated before it reaches a statement", () => {
  test.each([
    [{ scope: "group", id: "3" }, true],
    [{ scope: "project", id: "7" }, true],
    [{ scope: "system" }, true],
    [{ scope: "fleet", id: "1" }, false],
    // Not a formality: silently defaulting a missing id would report some other
    // scope's time under this one's heading, and silently ignoring an id on
    // `system` would make a panel bug look like a working query.
    [{ scope: "group" }, false],
    [{ scope: "project" }, false],
    [{ scope: "system", id: "3" }, false],
    // A scope id is a positive integer.
    [{ scope: "group", id: "0" }, false],
    [{ scope: "group", id: "-1" }, false],
    [{ scope: "group", id: "1.5" }, false],
    [{ scope: "group", id: "'; DROP TABLE span; --" }, false],
    // A window cannot ask for more than retention keeps.
    [{ scope: "system", windowMs: String(SPAN_MAX_AGE_MS) }, true],
    [{ scope: "system", windowMs: String(SPAN_MAX_AGE_MS + 1) }, false],
    // A trace id must be a trace id.
    [{ scope: "system", trace: "a".repeat(32) }, true],
    [{ scope: "system", trace: "a".repeat(31) }, false],
    [{ scope: "system", trace: "../../etc/passwd" }, false],
  ])("%j is accepted: %p", (query, accepted) => {
    expect(parse(query).success).toBe(accepted);
  });
});

test("a trace id is stored lowercase", () => {
  // Stored lowercase, so an uppercase id from a copied header still resolves.
  const upper = parse({ scope: "system", trace: "A".repeat(32) });
  expect(upper.success && upper.data.trace).toBe("a".repeat(32));
});

test("the report answers for the scope asked for and excludes the others", async () => {
  const context = await ctx();
  await writeSpans(context.db, [
    span({ spanId: "1".repeat(16), name: "turn", durationMs: 100, attributes: { "project.id": 7, "grp.id": 3 } }),
    span({ spanId: "2".repeat(16), name: "turn", durationMs: 900, attributes: { "project.id": 8, "grp.id": 4 } }),
    span({ spanId: "3".repeat(16), name: "scheduler.tick", durationMs: 5, attributes: {} }),
  ]);

  const group = await report(context, { scope: "group", id: "3" });
  expect(group.status).toBe(200);
  expect(group.body.scope).toBe("group");
  expect(group.body.stages.map((s) => s.totalMs)).toEqual([100]);

  const project = await report(context, { scope: "project", id: "8" });
  expect(project.body.stages.map((s) => s.totalMs)).toEqual([900]);

  const system = await report(context, { scope: "system" });
  expect(system.body.stages.map((s) => s.name)).toEqual(["scheduler.tick"]);
});

test("a scope that names nothing reports an empty scope rather than failing", async () => {
  // A span is an observation of work, not a reference to it, so a project that
  // has since been deleted is a legitimate question with an empty answer.
  const answer = await report(await ctx(), { scope: "project", id: "4040" });
  expect(answer.status).toBe(200);
  expect(answer.body.stages).toEqual([]);
  expect(answer.body.traces).toEqual([]);
  expect(answer.body.trend).toEqual([]);
  expect(answer.body.trace).toBeNull();
});

test("the report carries the scope's folded stacks for the flamegraph", async () => {
  const context = await ctx();
  await writeSpans(context.db, [
    span({
      traceId: "e".repeat(32),
      spanId: "1".repeat(16),
      name: "turn",
      durationMs: 100,
      attributes: { "grp.id": 3 },
    }),
    span({
      traceId: "e".repeat(32),
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      name: "turn.provider",
      durationMs: 80,
      attributes: { "grp.id": 3 },
    }),
  ]);

  const answer = await report(context, { scope: "group", id: "3" });
  expect(answer.body.flame).toEqual([
    { path: "turn", totalMs: 100, count: 1 },
    { path: "turn;turn.provider", totalMs: 80, count: 1 },
  ]);
});

test("no trace is opened unless one is asked for", async () => {
  const context = await ctx();
  await writeSpans(context.db, [span({ attributes: { "grp.id": 3 } })]);
  expect((await report(context, { scope: "group", id: "3" })).body.trace).toBeNull();
});

test("asking for a trace returns its spans, parents and all", async () => {
  const context = await ctx();
  await writeSpans(context.db, [
    span({ traceId: "c".repeat(32), spanId: "1".repeat(16), name: "turn", attributes: { "grp.id": 3 } }),
    span({
      traceId: "c".repeat(32),
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      name: "turn.provider",
      status: "error",
      statusMessage: null,
      attributes: { "grp.id": 3 },
    }),
  ]);

  const answer = await report(context, { scope: "group", id: "3", trace: "c".repeat(32) });
  expect(answer.body.trace?.traceId).toBe("c".repeat(32));
  expect(answer.body.trace?.spans.map((s) => s.name)).toEqual(["turn", "turn.provider"]);
  expect(answer.body.trace?.spans[1]?.parentSpanId).toBe("1".repeat(16));
  expect(answer.body.trace?.spans[1]?.status).toBe("error");
});

/**
 * The bytes as sent, with every key kept.
 *
 * `TelemetryReportSchema` is a `z.object`, so it strips what it does not
 * declare — which is right for the browser and useless for asking what the
 * server actually put on the wire. A leak test that read the parsed body would
 * pass by construction, having removed the thing it was looking for.
 */
const RawSpans = z.object({
  trace: z.object({ spans: z.array(JsonObject) }),
});

test("a trace's spans carry no attribute bag onto the wire", async () => {
  const context = await ctx();
  await writeSpans(context.db, [
    span({ traceId: "d".repeat(32), attributes: { "grp.id": 3, "agent.role": "engineer", "prompt.text": "secret" } }),
  ]);

  const parsed = parse({ scope: "group", id: "3", trace: "d".repeat(32) });
  const response = await getTelemetry(context, new Request("http://x/"), {}, parsed.data!);
  const raw = RawSpans.parse(await response.json());

  // The waterfall draws a bar; it has never needed the attributes, and shipping
  // the stored row would put every attribute anybody ever attaches to a span in
  // front of the browser as a side effect of adding one.
  expect(Object.keys(raw.trace.spans[0] ?? {}).toSorted()).toEqual([
    "durationMs",
    "name",
    "parentSpanId",
    "spanId",
    "startedAt",
    "status",
  ]);
});

test("a trace that is no longer stored is refused rather than drawn as empty", async () => {
  const context = await ctx();
  await writeSpans(context.db, [span({ attributes: { "grp.id": 3 } })]);

  const parsed = parse({ scope: "group", id: "3", trace: "f".repeat(32) });
  expect(parsed.success).toBe(true);
  const response = await getTelemetry(context, new Request("http://x/"), {}, parsed.data!);
  // An empty waterfall reads as "it took no time", which is a different claim
  // from "that trace aged out of retention".
  expect(response.status).toBe(404);
});

test("the window the report was computed over is stated in the report", async () => {
  const context = await ctx();
  const answer = await report(context, { scope: "system", windowMs: "600000" });
  // The panel labels its own axis from this rather than from the value it sent,
  // so a clamped or defaulted window cannot be mislabelled.
  expect(answer.body.windowMs).toBe(600_000);
  expect((await report(context, { scope: "system" })).body.windowMs).toBe(24 * 60 * 60 * 1_000);
});

test("two reads inside one TTL compute the report once", async () => {
  // Not about latency — the report is inside its budget. It is six independent
  // reads of one table per request, and a reloading tab re-runs all six against a
  // database every other request and the SSE heartbeat are queued on too.
  const own = await ownDatabase();
  const context = await testContext({ db: own.db });
  await writeSpans(own.db, [span({ spanId: "1".repeat(16), name: "turn", durationMs: 100, attributes: {} })]);

  let statements = 0;
  // Drizzle's own hook, which fires once per statement actually sent. Patching
  // the client instead counted whatever that driver happened to call `query`.
  await ownDatabase({ logQuery: () => void (statements += 1) });

  const query = TelemetryQuery.parse({ scope: "system" });
  await getTelemetry(context, new Request("http://x/"), {}, query);
  const first = statements;
  expect(first).toBeGreaterThan(0);

  await getTelemetry(context, new Request("http://x/"), {}, query);
  expect(statements).toBe(first);
});

test("a different database is a different report, not the first one's", async () => {
  // Keyed on scope and window alone, a module-level cache answers one database's
  // question with another's numbers. That is a wrong panel the first time two
  // exist, and it was two red tests here the moment the cache went in.
  const a = await testContext({ db: (await ownDatabase(undefined, "cache-a")).db });
  const b = await testContext({ db: (await ownDatabase(undefined, "cache-b")).db });
  await writeSpans(a.db, [span({ spanId: "1".repeat(16), name: "turn", durationMs: 100, attributes: {} })]);
  await writeSpans(b.db, [span({ spanId: "2".repeat(16), name: "gate.run", durationMs: 7, attributes: {} })]);

  const query = TelemetryQuery.parse({ scope: "system" });
  // Parsed, not asserted: `.json()` is `any`, and the schema is what the browser
  // gets anyway.
  const read = async (c: Ctx) =>
    TelemetryReportSchema.parse(await (await getTelemetry(c, new Request("http://x/"), {}, query)).json()).stages.map(
      (st) => st.name,
    );
  const [first, other] = await Promise.all([read(a), read(b)]);
  expect(first).toEqual(["turn"]);
  expect(other).toEqual(["gate.run"]);
});
