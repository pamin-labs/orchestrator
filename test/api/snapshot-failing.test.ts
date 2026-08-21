import { expect, test } from "bun:test";
import { z } from "zod";
import { snapshot } from "../../src/api/panel/snapshot.ts";
import { HostFailure } from "../../src/contracts/panel.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The readiness result reaches the panel, and only the part of it that is news.
 *
 * The finding used to leave through `consola.warn` on every readiness tick — a
 * terminal the boss does not have open, re-printed for as long as the fault
 * lasted. It rides the snapshot now, which is polled anyway, so the cost of
 * carrying it is the failures themselves and nothing on a healthy host.
 */

test("only the broken checks cross the wire, with the two strings that say what to do", async () => {
  const ctx = await testContext();
  ctx.checks = () => [
    { name: "database", ok: true, detail: "migrated and queryable" },
    { name: "docker", ok: false, detail: "daemon is not running", fix: "colima start" },
    // No `fix`: not every failure has a command, and the field is optional
    // rather than an empty string the panel would draw an empty box for.
    { name: "sandbox-server", ok: false, detail: "HTTP 500" },
  ];

  const failing = (await snapshot(ctx)).failing;
  const parsed = z.array(HostFailure).safeParse(failing);
  expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  expect(failing).toEqual([
    { name: "docker", detail: "daemon is not running", fix: "colima start" },
    { name: "sandbox-server", detail: "HTTP 500" },
  ]);
});

/**
 * `ctx.checks` is wired by the server and by nothing else: `orch`, the unit
 * tests, and any process with no readiness timer have none. That is a host
 * nobody has checked, which is an empty list — not a crash on the one payload
 * the whole panel is built from.
 */
test("a context with no readiness timer reports nothing rather than throwing", async () => {
  const ctx = await testContext();
  expect((await snapshot(ctx)).failing).toEqual([]);
});
