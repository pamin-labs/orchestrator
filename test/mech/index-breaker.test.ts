import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { newScheduler } from "../support/scheduler.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { modelAsk } from "../../src/mech/knowledge/pageindex.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";
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

/**
 * Signing the runtime in is the fix, and it was the one thing that did not reopen
 * the breaker.
 *
 * `record` clears the count only on a success and `tripped` returns before the
 * call that could produce one, so the single way back sat behind the door it
 * locked.
 */
/**
 * Measured on a live installation: tripped while codex had no credential, codex
 * signed in at 14:04, still returning an empty string twelve times a tick at
 * 00:50 — and the panel said "all 12 calls came back with nothing, check the
 * account" over an account that was fine and had never been asked.
 */
test("a credential arriving starts a fresh count, because that is what could fix it", async () => {
  const h = await harness(() => ({ code: 1, err: "no credential" }));
  const spec = { model: "haiku", runtime: "claude" } as const;
  for (let i = 0; i < 4; i++) await modelAsk(h.ctx, spec, { project: 1 })("q");
  expect(h.calls).toHaveLength(3);

  // The same key, the same model, the same runtime — only the credentials moved.
  await saveAuth(h.db, { runtime: "claude", mode: "oauth_token", secret: "sk-ant-new" });
  await modelAsk(h.ctx, spec, { project: 1 })("q");
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
