import { expect, test } from "bun:test";
import { z } from "zod";
import { makeApp } from "../src/api.ts";
import { testContext } from "./test-context.ts";

/**
 * `/api/*` is the boss's own surface and it takes no token: the caller is a
 * browser on 127.0.0.1 and the port was the whole story. It stops the network and
 * not a web page — a POST with the default `text/plain` is a simple request, no
 * preflight, delivered. The reply is unreadable to the attacker and every side
 * effect still lands: credentials wiped, a DRAFT approved, a group dropped.
 *
 * The rule is `hono/csrf` now, so these go through `makeApp` rather than calling
 * a predicate. That is the point of the test: what a route sees is the whole
 * middleware stack in the order `makeApp` registers it, and a check exported as
 * a function stays green while nothing calls it.
 */
const app = makeApp(testContext());
const ErrorResponse = z.object({ error: z.string() });
const write = (headers: Record<string, string>, method = "POST") =>
  app(new Request("http://127.0.0.1:47821/api/auth", { method, headers }));

test("a page on another origin cannot write", async () => {
  expect((await write({ "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await write({ "sec-fetch-site": "same-site" })).status).toBe(403);
  expect((await write({ origin: "https://evil.example" })).status).toBe(403);
  // Another local process's server is still another origin.
  expect((await write({ origin: "http://127.0.0.1:3000" })).status).toBe(403);
  // A form is the shape that needs no preflight, so it is the shape the attack
  // takes — and the one `csrf()` exists to name.
  expect(
    (await write({ origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" })).status,
  ).toBe(403);
});

test("the panel writes, however the boss spelled the host", async () => {
  // `Sec-Fetch-Site` is the one that survives `localhost` vs `127.0.0.1`: the
  // browser calls both same-origin, `Origin` calls them different strings.
  expect((await write({ "sec-fetch-site": "same-origin", origin: "http://localhost:47821" })).status).not.toBe(403);
  // No `Sec-Fetch-Site` at all: `Origin` is matched against the URL the request
  // arrived on, which is the host the boss typed, not a port read from config.
  expect((await write({ origin: "http://127.0.0.1:47821" })).status).not.toBe(403);
  // Typed into the address bar, or a redirect: no initiator at all.
  expect((await write({ "sec-fetch-site": "none" })).status).not.toBe(403);
});

test("callers that are not browsers are not refused", async () => {
  // A deny-list rather than an allow-list, because `curl`, `bun test` and the
  // mailbox replay send neither header — refusing those would refuse everything
  // that is not the panel. Every browser able to mount the attack sends one.
  expect((await write({})).status).not.toBe(403);
});

test("reads are never refused", async () => {
  // The attacker cannot read a cross-origin reply anyway, and blocking GETs would
  // break the panel's own SSE stream.
  expect((await write({ "sec-fetch-site": "cross-site" }, "GET")).status).not.toBe(403);
});

test("a refusal keeps its own status through onError", async () => {
  // `app.onError` replaces Hono's default handler outright, and the default is
  // what turns an `HTTPException` back into its response. Without the branch for
  // it, every middleware refusal in the stack arrives as a 500.
  const r = await write({ "sec-fetch-site": "cross-site" });
  expect(r.status).toBe(403);
  expect(r.headers.get("content-type")).toContain("application/json");
  expect(ErrorResponse.parse(await r.json())).toEqual({ error: "cross-site writes are refused" });
});

test("a cross-site write is refused whatever it claims to be", async () => {
  // `csrf()` alone fires only on the content types a cross-site request can send
  // without a preflight, so a cross-site POST labelled `application/json` reached
  // the schema — measured, 400 not 403. The argument for allowing it is sound and
  // it is an argument about somebody else's browser; the header that settles it
  // is in the request. Only a browser sets `Sec-Fetch-Site`, script cannot, and
  // no legitimate caller of this surface sets it to anything but same-origin/none.
  for (const type of ["application/json", "text/plain", "multipart/form-data"]) {
    expect((await write({ "sec-fetch-site": "cross-site", "content-type": type })).status).toBe(403);
    expect((await write({ "sec-fetch-site": "same-site", "content-type": type })).status).toBe(403);
    // And with no Sec-Fetch-Site at all, which is where Origin has to answer.
    expect((await write({ origin: "https://evil.example", "content-type": type })).status).toBe(403);
    expect((await write({ origin: "http://127.0.0.1:3000", "content-type": type })).status).toBe(403);
    // The panel itself, however the boss spelled the host.
    expect((await write({ origin: "http://localhost:47821", "content-type": type })).status).not.toBe(403);
  }
  // Still a read, still allowed.
  expect((await write({ "sec-fetch-site": "cross-site", "content-type": "application/json" }, "GET")).status).not.toBe(
    403,
  );
});

test("JSON routes require the JSON content type", async () => {
  // Hono owns request extraction. Its `json` validation target only reads a body
  // declared as JSON; panel, CLI, and mailbox callers all send this header.
  const send = (headers: Record<string, string>) =>
    app(
      new Request("http://127.0.0.1:47821/api/settings", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", ...headers },
        body: JSON.stringify({ path: "maxGroups", value: 3 }),
      }),
    );
  const wrongTypes: Record<string, string>[] = [{}, { "content-type": "text/plain" }];
  for (const h of wrongTypes) {
    const r = await send(h);
    expect(r.status).toBe(415);
    expect(ErrorResponse.parse(await r.json())).toEqual({ error: "Content-Type must be application/json" });
  }

  const json = await send({ "content-type": "application/json" });
  expect(json.status).not.toBe(415);

  const structured = await send({ "content-type": "application/problem+json; charset=utf-8" });
  expect(structured.status).not.toBe(415);
});
