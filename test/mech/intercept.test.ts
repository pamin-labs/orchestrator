import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { event, grp } from "../../src/platform/persistence/schema.ts";
import { interrupt } from "../../src/mech/flow/intercept.ts";
import * as fx from "../support/factories.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { testContext } from "../support/test-context.ts";

/**
 * docs/project/plan.md §7 L3: "打断并回滚" must end with the checkout back at the checkpoint the
 * turn started from. The pieces were tested apart — rollbackTo in worktree.test.ts,
 * the chain's revoke in chain.test.ts — and this end of it, kill plus rollback,
 * never was.
 *
 * The checkout is `/work` inside the group's container now. This asserted a host
 * directory before, which is why it kept passing while the real path was gated on
 * `grp.worktree` — a column nothing has ever written, so the rollback never ran.
 */
async function harness(checkpoint: string) {
  const db = await openMemory();
  const f = fx.on(db);
  await seedAuth(db);
  const sandbox = fakeSandbox();
  const ctx = await testContext({ db, sandbox });
  const p = await f.project.create({ name: "p" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  const a = await f.agent.create({ project_id: p.id, grp_id: g.id, model: "sonnet", state: "running" });
  await f.job.create({ grp_id: g.id, agent_id: a.id, state: "running", checkpoint_sha: checkpoint, started_at: 0 });
  return { db, ctx, sandbox };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("打断并回滚 resets the group's own checkout to the checkpoint", async () => {
  const h = await harness(SHA);

  const out = await interrupt(h.ctx, 1, "rollback");

  expect(out.rolledBackTo).toBe(SHA);
  const ran = h.sandbox.commands.join("\n");
  expect(ran).toContain(`git 'reset' '--hard' '${SHA}'`);
  // Untracked leftovers go too, or the next turn inherits a scratch file it
  // never wrote and reasons about it as its own.
  expect(ran).toContain("git 'clean' '-fd'");
});

test("a rollback that fails says so instead of reporting a clean tree", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  await seedAuth(db);
  // `reset` refusing is the case that matters: "interrupted and rolled back" that
  // only interrupted leaves a dirty tree the boss believes is clean.
  const sandbox = fakeSandbox((cmd) => (cmd.includes("'reset'") ? { code: 1, out: "fatal: bad object" } : {}));
  const ctx = await testContext({ db, sandbox });
  const p = await f.project.create({ name: "p" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  const a = await f.agent.create({ project_id: p.id, grp_id: g.id, model: "sonnet", state: "running" });
  await f.job.create({ grp_id: g.id, agent_id: a.id, state: "running", checkpoint_sha: SHA, started_at: 0 });

  const out = await interrupt(ctx, 1, "rollback");
  expect(out.rolledBackTo).toBeUndefined();
  const said = await db.select({ body: event.body }).from(event).where(eq(event.kind, "escalation"));
  expect(said.map((e) => e.body).join(" ")).toContain("fatal: bad object");
});

test("打断但保留 leaves the work and tells the next turn", async () => {
  const h = await harness(SHA);

  const out = await interrupt(h.ctx, 1, "keep");

  // A half-done change usually has value, so nothing touches the checkout.
  expect(out.rolledBackTo).toBeUndefined();
  expect(h.sandbox.commands.join("\n")).not.toContain("reset");
  // ...and the group still stops.
  const [row] = await h.db.select({ status: grp.status }).from(grp).where(eq(grp.id, 1));
  expect(row!.status).toBe("PAUSED");
});
