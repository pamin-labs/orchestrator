import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { newScheduler } from "../support/scheduler.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { keepQaSteps, replayQa } from "../../src/mech/flow/qa-suite.ts";
import { gateState } from "../../src/mech/gate.ts";
import { resource as resourceTable, slice as sliceTable } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import type { Ctx } from "../../src/mech/ctx.ts";

/**
 * A browser run that passed is a QA procedure. It used to be written into the
 * worktree, leased, and gone by the next slice — so the behaviour a reviewer
 * accepted was never checked again, and slice seven could break what slice one
 * was accepted on with nothing to say so.
 */
async function harness(commands: (cmd: string) => { code: number; out?: string }) {
  const db = await openMemory();
  await seedAuth(db);
  const ran: string[] = [];
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: newScheduler(db, async () => {}),
    sandbox: fakeSandbox((cmd) => {
      ran.push(cmd);
      return commands(cmd);
    }),
    waiters: new Map(),
    config: loadConfig(),
  };
  const f = fx.on(db);
  const p = await f.project.create({ name: "p", repo_path: "o/r" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  await f.slice.create({ grp_id: g.id, seq: 1, title: "S1", accept_spec: "the menu opens" });
  return { db, ctx, ran, grpId: g.id };
}

test("a browser run that passed is kept, named for what it says", async () => {
  const h = await harness((cmd) => (cmd.startsWith("cat ") ? { code: 0, out: '[{"goto":"#p=1"}]' } : { code: 0 }));
  await keepQaSteps(h.ctx, { grp: h.grpId }, "/work", "browser", { steps: "qa-steps.json" });

  // Copied under the repository's own directory, so it lands in the pull request
  // and travels with the branch.
  expect(h.ran.some((c) => c.includes("mkdir -p .orch/qa") && c.includes("cp 'qa-steps.json'"))).toBe(true);
  // Named by content: the same scenario recorded twice is one file.
  expect(h.ran.find((c) => c.includes("cp "))).toContain(".json");
});

test("a lease that is not the browser, or did not pass, keeps nothing", async () => {
  const h = await harness(() => ({ code: 0, out: "[]" }));
  await keepQaSteps(h.ctx, { grp: h.grpId }, "/work", "test", { steps: "qa-steps.json" });
  expect(h.ran.filter((c) => c.includes("mkdir -p .orch/qa"))).toEqual([]);
});

/**
 * One lease for the whole suite, not one per file: the steps are arrays, so they
 * concatenate, and each set seeds the state it needs through its own `api` steps.
 */
test("every accepted procedure is replayed together, and the verdict is recorded", async () => {
  const h = await harness((cmd) => {
    if (cmd.startsWith("ls -1 .orch/qa")) return { code: 0, out: ".orch/qa/aa.json\n.orch/qa/bb.json" };
    if (cmd.startsWith("cat ")) return { code: 0, out: '[{"goto":"#p=1"}]' };
    return { code: 0 };
  });
  await h.db.insert(resourceTable).values({
    name: "browser",
    template: "bun run scripts/browse.ts --steps {steps}",
    arg_schema_json: { steps: { type: "string", pattern: "^[A-Za-z0-9_./-]+\\.json$" } },
  });

  await replayQa(h.ctx, loadConfig(), h.grpId, 1, 1);

  expect((await gateState(h.db, 1)).regression).toBe("pass");
  // Two files, one run.
  expect(h.ran.filter((c) => c.includes("browse.ts"))).toHaveLength(1);
});

test("a project with no browser resource has no suite and no opinion", async () => {
  const h = await harness(() => ({ code: 0 }));
  await replayQa(h.ctx, loadConfig(), h.grpId, 1, 1);
  expect(await gateState(h.db, 1)).toEqual({});
  expect(h.ran).toEqual([]);
});

test("a slice that breaks an accepted procedure is recorded as breaking it", async () => {
  const h = await harness((cmd) => {
    if (cmd.startsWith("ls -1 .orch/qa")) return { code: 0, out: ".orch/qa/aa.json" };
    if (cmd.startsWith("cat ")) return { code: 0, out: '[{"expect":"Abandon"}]' };
    if (cmd.includes("browse.ts")) return { code: 1, out: "FAIL: expected Abandon" };
    return { code: 0 };
  });
  await h.db.insert(resourceTable).values({
    name: "browser",
    template: "bun run scripts/browse.ts --steps {steps}",
    arg_schema_json: { steps: { type: "string", pattern: "^[A-Za-z0-9_./-]+\\.json$" } },
  });

  await replayQa(h.ctx, loadConfig(), h.grpId, 1, 1);
  expect((await gateState(h.db, 1)).regression).toBe("fail");
  const [slice] = await h.db.select({ id: sliceTable.id }).from(sliceTable);
  expect(slice!.id).toBe(1);
});
