import { expect, test } from "bun:test";
import { crossSiteWrite } from "../src/api.ts";

/**
 * `/api/*` is the boss's own surface and it takes no token: the caller is a
 * browser on 127.0.0.1 and the port was the whole story. It stops the network and
 * not a web page — `body<T>()` never checks `content-type`, so a POST with the
 * default `text/plain` is a simple request, no preflight, delivered. The reply is
 * unreadable to the attacker and every side effect still lands: credentials
 * wiped, a DRAFT approved, a group dropped.
 */

const PORT = 47821;
const write = (headers: Record<string, string>, method = "POST") =>
  new Request("http://127.0.0.1:47821/api/auth", { method, headers });

test("a page on another origin cannot write", () => {
  expect(crossSiteWrite(write({ "sec-fetch-site": "cross-site" }), PORT)).toBe(true);
  expect(crossSiteWrite(write({ "sec-fetch-site": "same-site" }), PORT)).toBe(true);
  expect(crossSiteWrite(write({ origin: "https://evil.example" }), PORT)).toBe(true);
  // Another local process's server is still another origin.
  expect(crossSiteWrite(write({ origin: "http://127.0.0.1:3000" }), PORT)).toBe(true);
});

test("the panel writes, however the boss spelled the host", () => {
  // `Sec-Fetch-Site` is the one that survives `localhost` vs `127.0.0.1`: the
  // browser calls both same-origin, `Origin` calls them different strings.
  expect(crossSiteWrite(write({ "sec-fetch-site": "same-origin", origin: "http://localhost:47821" }), PORT)).toBe(false);
  expect(crossSiteWrite(write({ origin: "http://localhost:47821" }), PORT)).toBe(false);
  expect(crossSiteWrite(write({ origin: "http://127.0.0.1:47821" }), PORT)).toBe(false);
  // Typed into the address bar, or a redirect: no initiator at all.
  expect(crossSiteWrite(write({ "sec-fetch-site": "none" }), PORT)).toBe(false);
});

test("callers that are not browsers are not refused", () => {
  // A deny-list rather than an allow-list, because `curl`, `bun test` and the
  // mailbox replay send neither header — refusing those would refuse everything
  // that is not the panel. Every browser able to mount the attack sends one.
  expect(crossSiteWrite(write({}), PORT)).toBe(false);
});

test("reads are never refused", () => {
  // The attacker cannot read a cross-origin reply anyway, and blocking GETs would
  // break the panel's own SSE stream.
  expect(crossSiteWrite(write({ "sec-fetch-site": "cross-site" }, "GET"), PORT)).toBe(false);
});
