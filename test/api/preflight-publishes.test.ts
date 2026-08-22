import { expect, test } from "bun:test";
import { z } from "zod";
import { getPreflight } from "../../src/api/panel/sandbox.ts";
import { makeCheck } from "../../src/mech/ops/preflight.ts";
import { HostFailure } from "../../src/contracts/panel.ts";
import { testContext } from "../support/test-context.ts";

/**
 * One owner for "is the host well", and `/preflight` is not a second one.
 *
 * The settings page asks after the boss has just fixed something. It used to run
 * its own copy of the checks, so the pane went green while the shell's banner —
 * fed from the readiness timer's array through the snapshot — kept quoting the
 * answer from before the fix, for as long as the timer took to come round.
 */

// Any id renders, because the descriptor carries the English it was hashed
// from; what this file is about is which copy of the checks the route answers with.
const ok = makeCheck("opensandbox-server", true, { id: "check.server.reachable", message: "reachable" });

/** The wire shape, parsed rather than asserted: the response is `unknown` data. */
// The contract's own schema rather than a third model of it. Both halves cross:
// the English for `/readyz` and the console, and the key the settings pane
// renders in whatever language this browser reads.
const Body = z.object({ checks: z.array(HostFailure.extend({ ok: z.boolean() })) });
const bodyOf = async (response: Promise<Response>) => Body.parse(await (await response).json());

test("the endpoint reports what it published, not a copy of its own", async () => {
  const published: Array<ReadonlyArray<typeof ok>> = [];
  const ctx = await testContext({
    recheck: async () => {
      published.push([ok]);
      return [ok];
    },
  });

  const body = await bodyOf(getPreflight(ctx));
  // Ran the owner's refresh exactly once, and answered with what that returned.
  expect(published).toHaveLength(1);
  expect(body.checks).toEqual([ok]);
});

/**
 * The fallback is not decoration: `makeApp` is built in tests and CLI paths with
 * no server behind it, and a context without `recheck` must still answer rather
 * than throw — this endpoint is what the settings page renders.
 */
test("a context with no server behind it still answers", async () => {
  const body = await bodyOf(getPreflight(await testContext()));
  // The shape, not the verdicts: what the checks say depends on the machine, and
  // what this asserts is that the endpoint answered rather than threw.
  expect(Array.isArray(body.checks)).toBe(true);
});
