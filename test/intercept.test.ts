import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { openMemory } from "../src/db.ts";
import { interrupt } from "../src/mech/flow/intercept.ts";
import type { Ctx } from "../src/api.ts";
import { Scheduler } from "../src/scheduler.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";

/**
 * PLAN.md §7 L3: "打断并回滚" must end with the checkout back at the checkpoint the
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
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox,
    waiters: new Map(),
    config: { language: "中文"},
  } as unknown as Ctx;
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, state, created_at) VALUES (1, 1, 'engineer', 'sonnet', 'running', 0)",
  );
  db.run(
    `INSERT INTO job (kind, grp_id, agent_id, state, checkpoint_sha, pid, enqueued_at, started_at)
     VALUES ('agent_turn', 1, 1, 'running', ?, NULL, 0, 0)`,
    [checkpoint],
  );
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
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox,
    waiters: new Map(),
    config: { language: "中文"},
  } as unknown as Ctx;
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, state, created_at) VALUES (1, 1, 'engineer', 'sonnet', 'running', 0)",
  );
  db.run(
    `INSERT INTO job (kind, grp_id, agent_id, state, checkpoint_sha, pid, enqueued_at, started_at)
     VALUES ('agent_turn', 1, 1, 'running', ?, NULL, 0, 0)`,
    [SHA],
  );

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
