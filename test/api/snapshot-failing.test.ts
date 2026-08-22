import { expect, test } from "bun:test";
import { z } from "zod";
import { snapshot } from "../../src/api/panel/snapshot.ts";
import { HostFailure } from "../../src/contracts/panel.ts";
import { makeCheck } from "../../src/mech/ops/preflight.ts";
import { said } from "../support/said.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The readiness result reaches the panel, and only the part of it that is news.
 *
 * The finding used to leave through `consola.warn` on every readiness tick — a
 * terminal the boss does not have open, re-printed for as long as the fault
 * lasted. It rides the snapshot now, which is polled anyway, so the cost of
 * carrying it is the failures themselves and nothing on a healthy host.
 */

const ok = said("migrated and queryable");
const silent = said("installed, but the daemon is not answering");
const start = said("Start Docker Desktop, or run colima start, and wait for it to report running.");
const http500 = said("HTTP {status}");

test("only the broken checks cross the wire, with the two strings that say what to do", async () => {
  const ctx = await testContext();
  ctx.checks = () => [
    makeCheck("database", true, ok),
    makeCheck("docker", false, silent, start),
    // No `fix`: not every failure has a command, and the field is optional
    // rather than an empty string the panel would draw an empty box for.
    makeCheck("sandbox-server", false, { ...http500, values: { status: 500 } }),
  ];

  const failing = (await snapshot(ctx)).failing;
  const parsed = z.array(HostFailure).safeParse(failing);
  expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  // The English rides along with the key: `/readyz` and the console read it,
  // and it is what the panel falls back to for a key it does not know yet.
  expect(failing).toEqual([
    { name: "docker", detail: silent.message, said: silent, fix: start.message, fixSaid: start },
    {
      name: "sandbox-server",
      detail: "HTTP 500",
      said: { ...http500, values: { status: 500 } },
    },
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
