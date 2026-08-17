import { expect, test } from "bun:test";
import { z } from "zod";
import { JsonObject } from "../../src/contracts/json.ts";
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
const ctx = () => testContext();

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
    ...over,
  };
}

const parse = (query: Record<string, string>) => TelemetryQuery.safeParse(query);

/** The handler's body, already parsed. Every assertion below reads one of these. */
async function report(
  context: ReturnType<typeof ctx>,
  query: Record<string, string>,
): Promise<{ status: number; body: TelemetryReport }> {
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

test("a scope of group, project or system is accepted and anything else is not", () => {
  expect(parse({ scope: "group", id: "3" }).success).toBe(true);
  expect(parse({ scope: "project", id: "7" }).success).toBe(true);
  expect(parse({ scope: "system" }).success).toBe(true);
  expect(parse({ scope: "fleet", id: "1" }).success).toBe(false);
});

test("a group or project scope without an id is refused, and system with one", () => {
  // Not a formality: silently defaulting a missing id would report some other
  // scope's time under this one's heading, and silently ignoring an id on
  // `system` would make a panel bug look like a working query.
  expect(parse({ scope: "group" }).success).toBe(false);
  expect(parse({ scope: "project" }).success).toBe(false);
  expect(parse({ scope: "system", id: "3" }).success).toBe(false);
});

test("a scope id must be a positive integer", () => {
  expect(parse({ scope: "group", id: "0" }).success).toBe(false);
  expect(parse({ scope: "group", id: "-1" }).success).toBe(false);
  expect(parse({ scope: "group", id: "1.5" }).success).toBe(false);
  expect(parse({ scope: "group", id: "'; DROP TABLE span; --" }).success).toBe(false);
});

test("a window cannot ask for more than retention keeps", () => {
  expect(parse({ scope: "system", windowMs: String(SPAN_MAX_AGE_MS) }).success).toBe(true);
  expect(parse({ scope: "system", windowMs: String(SPAN_MAX_AGE_MS + 1) }).success).toBe(false);
});

test("a trace id must be a trace id", () => {
  expect(parse({ scope: "system", trace: "a".repeat(32) }).success).toBe(true);
  expect(parse({ scope: "system", trace: "a".repeat(31) }).success).toBe(false);
  expect(parse({ scope: "system", trace: "../../etc/passwd" }).success).toBe(false);
  // Stored lowercase, so an uppercase id from a copied header still resolves.
  const upper = parse({ scope: "system", trace: "A".repeat(32) });
  expect(upper.success && upper.data.trace).toBe("a".repeat(32));
});

test("the report answers for the scope asked for and excludes the others", async () => {
  const context = ctx();
  writeSpans(context.db, [
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
  const answer = await report(ctx(), { scope: "project", id: "4040" });
  expect(answer.status).toBe(200);
  expect(answer.body.stages).toEqual([]);
  expect(answer.body.traces).toEqual([]);
  expect(answer.body.trend).toEqual([]);
  expect(answer.body.trace).toBeNull();
});

test("the report carries the scope's folded stacks for the flamegraph", async () => {
  const context = ctx();
  writeSpans(context.db, [
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
  const context = ctx();
  writeSpans(context.db, [span({ attributes: { "grp.id": 3 } })]);
  expect((await report(context, { scope: "group", id: "3" })).body.trace).toBeNull();
});

test("asking for a trace returns its spans, parents and all", async () => {
  const context = ctx();
  writeSpans(context.db, [
    span({ traceId: "c".repeat(32), spanId: "1".repeat(16), name: "turn", attributes: { "grp.id": 3 } }),
    span({
      traceId: "c".repeat(32),
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      name: "turn.provider",
      status: "error",
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
  const context = ctx();
  writeSpans(context.db, [
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
  const context = ctx();
  writeSpans(context.db, [span({ attributes: { "grp.id": 3 } })]);

  const parsed = parse({ scope: "group", id: "3", trace: "f".repeat(32) });
  expect(parsed.success).toBe(true);
  const response = await getTelemetry(context, new Request("http://x/"), {}, parsed.data!);
  // An empty waterfall reads as "it took no time", which is a different claim
  // from "that trace aged out of retention".
  expect(response.status).toBe(404);
});

test("the window the report was computed over is stated in the report", async () => {
  const context = ctx();
  const answer = await report(context, { scope: "system", windowMs: "600000" });
  // The panel labels its own axis from this rather than from the value it sent,
  // so a clamped or defaulted window cannot be mislabelled.
  expect(answer.body.windowMs).toBe(600_000);
  expect((await report(context, { scope: "system" })).body.windowMs).toBe(24 * 60 * 60 * 1_000);
});
