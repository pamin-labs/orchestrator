import { expect, test } from "bun:test";
import { Hono } from "hono";
import { hc, type InferResponseType } from "hono/client";
import { z } from "zod";
import type { ApiType } from "../src/api.ts";
import type { IdempotencyRecordStatus, IdempotencyUnresolvedList } from "../src/contracts/idempotency.ts";
import type { Json } from "../src/contracts/json.ts";
import type { ErrorResponse } from "../src/contracts/protocol.ts";
import type { OrchType } from "../src/http/routes/orch.ts";
import { jsonBody, pathParams } from "../src/http/validate.ts";
import { routeSource } from "./route-source.ts";

const panel = hc<ApiType>("http://localhost/api/v1");
const orch = hc<OrchType>("http://localhost/orch/v1");
type StateResponse = InferResponseType<typeof panel.state.$get, 200>;
const rpcResponseIsTyped: StateResponse extends { ready: boolean; lastSeq: number } ? true : never = true;

type Exact<Actual, Expected> = [Actual] extends [Expected] ? ([Expected] extends [Actual] ? true : false) : false;
type PanelStatusResponse = InferResponseType<typeof panel.idempotency.status.$get, 200>;
type PanelRecoveryResponse = InferResponseType<typeof panel.idempotency.recover.$post, 200>;
type OrchStatusResponse = InferResponseType<typeof orch.idempotency.status.$get, 200>;
type OrchConflict = InferResponseType<typeof orch.status.$post, 409>;
type OrchPayloadTooLarge = InferResponseType<typeof orch.status.$post, 413>;
type OrchUnavailable = InferResponseType<typeof orch.status.$post, 503>;
type PanelUnavailable = InferResponseType<typeof panel.auth.$post, 503>;

const idempotencyRpcIsTyped: [
  Exact<PanelStatusResponse, IdempotencyRecordStatus | IdempotencyUnresolvedList>,
  Exact<PanelRecoveryResponse, Json>,
  Exact<OrchStatusResponse, IdempotencyRecordStatus>,
  Exact<OrchConflict, ErrorResponse>,
  Exact<OrchPayloadTooLarge, ErrorResponse>,
  Exact<OrchUnavailable, ErrorResponse>,
  Exact<PanelUnavailable, ErrorResponse>,
] = [true, true, true, true, true, true, true];

test("RPC retains handler response types", () => {
  expect(rpcResponseIsTyped).toBe(true);
  expect(idempotencyRpcIsTyped).toEqual([true, true, true, true, true, true, true]);
});

test("business handler checks preserve their concrete RPC responses", () => {
  expect(routeSource()).not.toMatch(/export const \w+\s*:\s*(?:Agent)?Handler/);
});

test("Hono gives handlers the schemas' output values", async () => {
  const Params = z.object({ id: z.string().regex(/^\d+$/).transform(Number) });
  const Body = z.string();
  const app = new Hono().post("/items/:id", pathParams(Params), ...jsonBody(Body), (c) => {
    const params = c.req.valid("param");
    return c.json({ id: params.id, idType: typeof params.id, data: c.req.valid("json") });
  });

  const response = await app.request("/items/42", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify("hello"),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: 42, idType: "number", data: "hello" });
});

test("schema failures are JSON bad requests", async () => {
  const app = new Hono().post("/value", ...jsonBody(z.string().min(2)), (c) => c.json(c.req.valid("json")));
  const response = await app.request("/value", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify("x"),
  });

  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining("Too small"),
    code: "validation_failed",
    request_id: expect.any(String),
  });
});

test("non-JSON bodies never reach an all-optional JSON schema", async () => {
  let calls = 0;
  const Body = z.object({ tokens: z.number().optional() });
  const app = new Hono().post("/value", ...jsonBody(Body), (c) => {
    calls += 1;
    return c.json(c.req.valid("json"));
  });

  for (const contentType of [undefined, "text/plain"]) {
    const response = await app.request("/value", {
      method: "POST",
      ...(contentType ? { headers: { "content-type": contentType } } : {}),
      body: JSON.stringify({ tokens: 7 }),
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: "Content-Type must be application/json",
      code: "unsupported_media_type",
      request_id: expect.any(String),
    });
  }
  expect(calls).toBe(0);
});

test("structured JSON media types and parameters are accepted", async () => {
  const Body = z.object({ tokens: z.number() });
  const app = new Hono().post("/value", ...jsonBody(Body), (c) => c.json(c.req.valid("json")));
  const response = await app.request("/value", {
    method: "POST",
    headers: { "content-type": "application/problem+json; charset=utf-8" },
    body: JSON.stringify({ tokens: 7 }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tokens: 7 });
});
