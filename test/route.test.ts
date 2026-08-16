import { expect, test } from "bun:test";
import { Hono } from "hono";
import { hc, type InferResponseType } from "hono/client";
import { z } from "zod";
import type { ApiType } from "../src/api.ts";
import { jsonBody, pathParams } from "../src/http/validate.ts";
import { routeSource } from "./route-source.ts";

const panel = hc<ApiType>("http://localhost/api");
type StateResponse = InferResponseType<typeof panel.state.$get, 200>;
const rpcResponseIsTyped: StateResponse extends { ready: boolean; lastSeq: number } ? true : never = true;

test("RPC retains handler response types", () => {
  expect(rpcResponseIsTyped).toBe(true);
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
  expect(await response.json()).toEqual({ error: expect.stringContaining("Too small") });
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
      headers: contentType ? { "content-type": contentType } : undefined,
      body: JSON.stringify({ tokens: 7 }),
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Content-Type must be application/json" });
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
