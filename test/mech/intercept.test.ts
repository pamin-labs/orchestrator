import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
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
function harness(checkpoint: string) {
  const db = openMemory();
  seedAuth(db);
  const sandbox = fakeSandbox();
  const ctx = testContext({ db, sandbox });
  const p = fx.project.insert(db, { name: "p" });
  const g = fx.runningGrp.insert(db, { project_id: p.id, name: "g1" });
  const a = fx.agent.insert(db, { project_id: p.id, grp_id: g.id, model: "sonnet", state: "running" });
  fx.job.insert(db, { grp_id: g.id, agent_id: a.id, state: "running", checkpoint_sha: checkpoint, started_at: 0 });
  return { db, ctx, sandbox };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("打断并回滚 resets the group's own checkout to the checkpoint", async () => {
  const h = harness(SHA);

  const out = await interrupt(h.ctx, 1, "rollback");

  expect(out.rolledBackTo).toBe(SHA);
  const ran = h.sandbox.commands.join("\n");
  expect(ran).toContain(`git 'reset' '--hard' '${SHA}'`);
  // Untracked leftovers go too, or the next turn inherits a scratch file it
  // never wrote and reasons about it as its own.
  expect(ran).toContain("git 'clean' '-fd'");
});

test("a rollback that fails says so instead of reporting a clean tree", async () => {
  const db = openMemory();
  seedAuth(db);
  // `reset` refusing is the case that matters: "interrupted and rolled back" that
  // only interrupted leaves a dirty tree the boss believes is clean.
  const sandbox = fakeSandbox((cmd) => (cmd.includes("'reset'") ? { code: 1, out: "fatal: bad object" } : {}));
  const ctx = testContext({ db, sandbox });
  const p = fx.project.insert(db, { name: "p" });
  const g = fx.runningGrp.insert(db, { project_id: p.id, name: "g1" });
  const a = fx.agent.insert(db, { project_id: p.id, grp_id: g.id, model: "sonnet", state: "running" });
  fx.job.insert(db, { grp_id: g.id, agent_id: a.id, state: "running", checkpoint_sha: SHA, started_at: 0 });

  const out = await interrupt(ctx, 1, "rollback");
  expect(out.rolledBackTo).toBeUndefined();
  const said = db.query<{ body: string }, []>("SELECT body FROM event WHERE kind = 'escalation'").all();
  expect(said.map((e) => e.body).join(" ")).toContain("fatal: bad object");
});

test("打断但保留 leaves the work and tells the next turn", async () => {
  const h = harness(SHA);

  const out = await interrupt(h.ctx, 1, "keep");

  // A half-done change usually has value, so nothing touches the checkout.
  expect(out.rolledBackTo).toBeUndefined();
  expect(h.sandbox.commands.join("\n")).not.toContain("reset");
  // ...and the group still stops.
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PAUSED");
});
