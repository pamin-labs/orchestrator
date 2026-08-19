import { expect, test } from "bun:test";
import { mutate, readJson, requestHeaders } from "../../web/src/shared/api.ts";
import { notifyFrom, notifyPlan, readWire, type Wire } from "../../web/src/shared/stream.ts";
import type { Json } from "../../src/contracts/json.ts";
import { z } from "zod";

/**
 * The browser's transport, at the two places it decides something.
 *
 * Every panel read and every panel write goes through `readJson`, so what a
 * failing server puts in front of the boss is decided here and nowhere else —
 * and it had no test at all. Same for the headers: an `Idempotency-Key` that
 * stops being sent is invisible until a retried POST does the work twice.
 */

test("a write carries an idempotency key and a safe read does not", () => {
  const read = requestHeaders("/api/v1/state");
  expect(read.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  expect(read.get("Idempotency-Key")).toBeNull();

  const write = requestHeaders("/api/v1/groups/1/start", { method: "post" });
  // Lower case on the way in: the method is the caller's, the comparison is ours.
  expect(write.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  expect(write.get("X-Request-ID")).not.toBe(write.get("Idempotency-Key"));

  // HEAD and OPTIONS are safe too, and a Request carries its own method.
  expect(requestHeaders("/x", { method: "HEAD" }).get("Idempotency-Key")).toBeNull();
  expect(requestHeaders(new Request("https://x/y", { method: "DELETE" })).get("Idempotency-Key")).not.toBeNull();

  // Headers the caller set survive; they are added to, not replaced.
  expect(requestHeaders("/x", { headers: { "X-Mine": "kept" } }).get("X-Mine")).toBe("kept");
  expect(requestHeaders(new Request("https://x/y", { headers: { "X-Mine": "kept" } })).get("X-Mine")).toBe("kept");
});

test("two writes never share an idempotency key", () => {
  const a = requestHeaders("/x", { method: "POST" }).get("Idempotency-Key");
  const b = requestHeaders("/x", { method: "POST" }).get("Idempotency-Key");
  expect(a).not.toBe(b);
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a server error reaches the panel as the server's own words", async () => {
  const r = await readJson(json({ error: "组还在跑，先停下来", code: "group_running" }, 409), z.object({}));
  expect(r.ok).toBe(false);
  expect(r.data).toBeNull();
  // The reason, not the status line: `displayJson` prefers `error` over the blob.
  expect(r.text).toBe("组还在跑，先停下来");
});

test("an error body with no reason still shows what came back", async () => {
  const r = await readJson(json({ code: "boom" }, 500), z.object({}));
  expect(r.ok).toBe(false);
  expect(r.text).toBe('{"code":"boom"}');
});

test("bytes that are not JSON are reported as that, not as a parse crash", async () => {
  const r = await readJson(new Response("<html>502 Bad Gateway</html>", { status: 502 }), z.object({}));
  expect(r.ok).toBe(false);
  expect(r.text).toBe("Server returned a non-JSON response");
});

test("a 200 that does not match the contract is a failure, and names the field", async () => {
  const r = await readJson(json({ seq: "not a number" }), z.object({ seq: z.number() }));
  expect(r.ok).toBe(false);
  expect(r.text).toContain("Server returned invalid JSON");
  expect(r.text).toContain("seq");
});

test("a good answer comes back parsed, with the raw body kept for display", async () => {
  const r = await readJson(json({ seq: 7 }), z.object({ seq: z.number() }));
  expect(r).toEqual({ ok: true, data: { seq: 7 }, text: '{"seq":7}' });
});

test("a quiet write hands its refusal back instead of raising a toast", async () => {
  const r = await mutate(Promise.resolve(json({ error: "分支不存在" }, 400)), true);
  expect(r.ok).toBe(false);
  expect(r.text).toBe("分支不存在");
});

test("a stream line that is not a frame is dropped, not thrown", () => {
  expect(readWire("not json at all")).toBeNull();
  expect(readWire('{"type":"event"}')).toBeNull();
  expect(readWire(undefined)).toBeNull();

  const f = readWire('{"type":"event","seq":3,"at":10,"kind":"say","author":"boss","body":"开工"}');
  expect(f).toMatchObject({ type: "event", seq: 3, kind: "say", body: "开工" });
});

const notify = (meta?: Json, body = "有人在等你回话"): Wire => ({
  type: "event",
  seq: 1,
  at: 1000,
  kind: "notify",
  author: "cos",
  body,
  ...(meta === undefined ? {} : { meta }),
});

test("only a notify frame asks for a notification", () => {
  expect(notifyFrom({ type: "event", seq: 1, at: 1, kind: "say", author: "boss", body: "hi" })).toBeNull();
  expect(notifyFrom({ type: "live", grpId: null, agentId: null, kind: "text", body: "…" })).toBeNull();

  expect(notifyFrom(notify({ url: "/#/g/7", title: "需求七" }))).toEqual({
    body: "有人在等你回话",
    at: 1000,
    meta: { url: "/#/g/7", title: "需求七" },
  });
  // Meta the server never sent, or sent wrong, costs the deep link and nothing else.
  expect(notifyFrom(notify(undefined))).toEqual({ body: "有人在等你回话", at: 1000 });
  expect(notifyFrom(notify("not an object"))).toEqual({ body: "有人在等你回话", at: 1000 });
});

test("a replayed alert from an hour ago is not re-announced", () => {
  expect(notifyPlan({ body: "旧的", at: Date.now() - 61_000 }, true)).toEqual({ show: "none" });
  // A frame with no clock is live by definition: the stream just delivered it.
  expect(notifyPlan({ body: "没有时间戳" }, false)).toEqual({ show: "toast", body: "没有时间戳" });
});

test("without permission the alert becomes a toast, with it a real notification", () => {
  const at = Date.now();
  expect(notifyPlan({ body: "要你批", at }, false)).toEqual({ show: "toast", body: "要你批" });

  expect(notifyPlan({ body: "要你批", at, meta: { url: "http://localhost/#/g/7", title: "需求七" } }, true)).toEqual({
    show: "notify",
    title: "需求七",
    body: "要你批",
    tag: "要你批",
    hash: "/g/7",
  });
});

test("a notification with no title of its own is signed by the panel", () => {
  const long = "一".repeat(50);
  const plan = notifyPlan({ body: long, at: Date.now() }, true);
  expect(plan).toEqual({ show: "notify", title: "orchestrator", body: long, tag: "一".repeat(40), hash: null });
});
