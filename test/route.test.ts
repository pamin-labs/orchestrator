import { expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../src/ctx.ts";
import type { Handler } from "../src/http/handler.ts";
import { route } from "../src/http/route.ts";

const ctx = {} as Ctx;

test("route gives handlers the schemas' output values", async () => {
  const app = new Hono();
  const Params = z.object({ id: z.string().regex(/^\d+$/).transform(Number) });
  const Body = z.string();
  const handler: Handler<z.infer<typeof Body>, z.infer<typeof Params>> = async (_ctx, _req, params, data) =>
    Response.json({ id: params.id, idType: typeof params.id, data });

  route(app, ctx, "post", "/items/:id", { params: Params, body: Body, handler });
  const response = await app.request("/items/42", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify("hello"),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: 42, idType: "number", data: "hello" });
});

test("route keeps schema errors and valid string outputs distinct", async () => {
  const app = new Hono();
  const handler: Handler<string> = async (_ctx, _req, _params, data) => new Response(data);
  route(app, ctx, "post", "/value", { body: z.string().min(2), handler });

  const valid = await app.request("/value", { method: "POST", body: JSON.stringify("hello") });
  expect(valid.status).toBe(200);
  expect(await valid.text()).toBe("hello");

  const invalid = await app.request("/value", { method: "POST", body: JSON.stringify("x") });
  expect(invalid.status).toBe(422);
  expect(await invalid.text()).toContain("Too small");
});
