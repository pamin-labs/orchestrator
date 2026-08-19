import { expect, test } from "bun:test";
import { makeApp } from "../../src/composition/api.ts";
import { ErrorResponseSchema } from "../../src/contracts/protocol.ts";
import { JSON_BODY_LIMIT } from "../../src/http/idempotency/store.ts";
import { runtimeStatus } from "../../src/platform/observability/metrics.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The reason `/api/v1/traces` is on the panel's protocol root rather than the
 * bare `/v1/traces` an OTLP client would otherwise be pointed at: everything the
 * root already enforces applies to it, without a line of its own.
 */

const JSON_HEADERS = { "content-type": "application/json" };
const url = "http://x/api/v1/traces";

const oversized = (): string => {
  const span = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name: "x".repeat(4_096),
    startTimeUnixNano: "1800000000000000000",
    endTimeUnixNano: "1800000000000000001",
  };
  const spans = Array.from({ length: Math.ceil(JSON_BODY_LIMIT / 4_096) + 8 }, () => span);
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
};

test("an export past the shared JSON body limit is refused, not stored", async () => {
  const ctx = testContext();
  const body = oversized();
  expect(body.length).toBeGreaterThan(JSON_BODY_LIMIT);

  const response = await makeApp(ctx)(new Request(url, { method: "POST", headers: JSON_HEADERS, body }));

  expect(response.status).toBe(413);
  expect(ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM span").get()!.c).toBe(0);
});

test("a shutting-down server refuses an export like any other write", async () => {
  const status = runtimeStatus();
  status.accepting = false;

  const response = await makeApp(
    testContext(),
    status,
  )(new Request(url, { method: "POST", headers: JSON_HEADERS, body: "{}" }));

  expect(response.status).toBe(503);
  expect(ErrorResponseSchema.parse(await response.json()).code).toBe("shutting_down");
});

test("a cross-site browser export is refused like any other panel write", async () => {
  const response = await makeApp(testContext())(
    new Request(url, {
      method: "POST",
      headers: { ...JSON_HEADERS, origin: "http://evil.example", "sec-fetch-site": "cross-site" },
      body: "{}",
    }),
  );

  expect(response.status).toBe(403);
});

test("an export needs no Idempotency-Key, because the table is what makes it idempotent", async () => {
  // Every other mutating panel route 400s without one. An OTLP client cannot
  // send a fresh key per batch, and `INSERT OR IGNORE` on (trace_id, span_id)
  // means there is no second side effect for a key to protect.
  const ctx = testContext();
  const app = makeApp(ctx);

  const idea = await app(
    new Request("http://x/api/v1/ideas", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ project_id: 1, text: "no key" }),
    }),
  );
  expect(idea.status).toBe(400);
  expect(ErrorResponseSchema.parse(await idea.json()).code).toBe("missing_idempotency_key");

  const traces = await app(new Request(url, { method: "POST", headers: JSON_HEADERS, body: "{}" }));
  expect(traces.status).toBe(200);
});
