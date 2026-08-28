import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { newScheduler } from "../support/scheduler.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { modelAsk } from "../../src/mech/knowledge/pageindex.ts";
import { event } from "../../src/platform/persistence/schema.ts";
import type { Ctx } from "../../src/mech/ctx.ts";

/**
 * ADR 040 measured this layer failing 36 times out of 36 in one seven-hour
 * window, 20.5 seconds each, while the lexical half it falls through to answers
 * in 0.32ms. Every `orch ctx query` in that window paid about a minute for three
 * calls that returned nothing.
 *
 * The ADR decided not to cut the layer. This does not cut it either — it stops
 * *repeating* a failure, which is a different decision and the one the wall clock
 * was asking for.
 */
async function harness(exec: (cmd: string) => { code: number; out?: string; err?: string }) {
  const db = await openMemory();
  const calls: string[] = [];
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: newScheduler(db, async () => {}),
    sandbox: fakeSandbox((cmd) => {
      if (cmd.includes("claude") || cmd.includes("codex")) calls.push(cmd);
      return exec(cmd);
    }),
    waiters: new Map(),
    config: loadConfig(),
  };
  return { db, ctx, calls };
}

test("a navigator that has never answered stops being asked", async () => {
  const h = await harness(() => ({ code: 1, err: "credential expired" }));
  const ask = modelAsk(h.ctx, { model: "haiku", runtime: "claude" }, { project: 1 });

  for (let i = 0; i < 6; i++) expect(await ask("where is the gate")).toBe("");

  // Three attempts, then silence: the fourth query answers in no time at all
  // rather than in three model round trips.
  expect(h.calls).toHaveLength(3);
});

test("the boss is told once, on the way past the threshold", async () => {
  const h = await harness(() => ({ code: 1, err: "credential expired" }));
  const ask = modelAsk(h.ctx, { model: "haiku", runtime: "claude" }, { project: 1 });
  for (let i = 0; i < 6; i++) await ask("q");

  const said = await h.db.select({ body: event.body }).from(event);
  expect(said.filter((row) => row.body.includes("failed"))).toHaveLength(1);
});

/**
 * The two settings events in that window show both runtimes being tried and
 * reverted, so the breaker must not be what stands in the way of the fix.
 */
test("changing the model starts a fresh count", async () => {
  const h = await harness(() => ({ code: 1, err: "nope" }));
  const first = modelAsk(h.ctx, { model: "haiku", runtime: "claude" }, { project: 1 });
  for (let i = 0; i < 4; i++) await first("q");
  expect(h.calls).toHaveLength(3);

  const second = modelAsk(h.ctx, { model: "sonnet", runtime: "claude" }, { project: 1 });
  await second("q");
  expect(h.calls).toHaveLength(4);
});

test("one answer clears it, because the count is of consecutive failures", async () => {
  let fail = true;
  const h = await harness(() => (fail ? { code: 1, err: "nope" } : { code: 0, out: '{"result":"src/mech/gate.ts"}' }));
  const ask = modelAsk(h.ctx, { model: "haiku", runtime: "claude" }, { project: 1 });

  await ask("q");
  await ask("q");
  fail = false;
  expect(await ask("q")).toBe("src/mech/gate.ts");
  fail = true;
  // Two failures, then an answer, then two more: still under the threshold, so
  // the layer is still being asked.
  await ask("q");
  await ask("q");
  expect(h.calls).toHaveLength(5);
});
