import { expect, test } from "bun:test";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { AgentTurnPayloadSchema, Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { restoreWorkspace } from "../../src/mech/flow/start.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";

/**
 * A sandbox is where the work lives and it is replaceable — the TTL reaps an
 * idle one, a credential change kills it, the server restarts. Rebuilding gave
 * back an empty container: no clone, no dependencies, and the next turn
 * reporting that the repository was broken.
 */
function harness(opts: { install?: string | null; installFails?: boolean } = {}) {
  const db: DB = openMemory();
  const sched = new Scheduler(db, async () => {});
  const queued = () =>
    db
      .query<{ payload_json: string }, []>("SELECT payload_json FROM job WHERE kind = 'agent_turn'")
      .all()
      .map(({ payload_json }) => AgentTurnPayloadSchema.parse(JSON.parse(payload_json)));

  const sandbox = fakeSandbox((cmd) => {
    if (cmd.includes("test -d")) return { out: "" }; // no clone in there yet
    if (opts.installFails && cmd.includes("install")) return { code: 1, err: "boom" };
    return {};
  });
  const ctx = testContext({
    db,
    sched,
    sandbox,
  });
  ctx.config = { ...ctx.config, installTimeoutMs: 1000 };

  // The remote is a column, not something read back out of a host checkout: the
  // host stopped being a git participant at 007 step 5, and a rebuilt container
  // gets its branch off the remote rather than out of a bundle the host kept.
  db.run(
    "INSERT INTO project (name, repo_path, remote, config_json, created_at) VALUES ('p', '/tmp/p', 'https://github.com/me/x.git', ?, 0)",
    [JSON.stringify(opts.install === undefined ? {} : { install: opts.install })],
  );
  db.run("INSERT INTO grp (project_id, name, status, branch, created_at) VALUES (1, 'g1', 'RUNNING', 'orch/g1', 0)");
  return { ctx, sandbox, queued, db };
}

test("a rebuilt sandbox gets the branch back and its dependencies installed", async () => {
  const { ctx, sandbox } = harness({ install: "bun install --frozen-lockfile" });
  await restoreWorkspace(ctx, 1);
  expect(sandbox.commands.some((c) => c.startsWith("git clone"))).toBe(true);
  expect(sandbox.commands.some((c) => c.includes("bun install"))).toBe(true);
});

test("with no recorded install command, the role that works it out is queued", async () => {
  const { ctx, queued } = harness();
  await restoreWorkspace(ctx, 1);
  expect(queued().some((payload) => payload.role === "bootstrap")).toBe(true);
});

test("a recorded command that stopped working hands the failure to that role", async () => {
  const { ctx, queued } = harness({ install: "bun install", installFails: true });
  await restoreWorkspace(ctx, 1);
  const boot = queued().find((payload) => payload.role === "bootstrap");
  expect(boot?.rejection).toContain("bun install");
});

test("a rebuilt container takes its branch off the remote, not out of a bundle", async () => {
  // `seedBranch` is gone with 007 step 5. It existed because a group's commits
  // lived on the host between turns, which was also the only reason the host
  // held a checkout at all — and it was the one thing that carried a bundle
  // *into* an agent's container. Bundles are one-way now: out, never in.
  const { ctx, sandbox } = harness({ install: "bun install" });
  await restoreWorkspace(ctx, 1);

  // `ls-remote` finds it, so this is a checkout of an existing branch rather
  // than cutting a new one from the base.
  expect(sandbox.commands.some((c) => c.includes("ls-remote"))).toBe(true);
  expect(sandbox.commands.some((c) => c.includes("git checkout 'orch/g1'"))).toBe(true);
  expect(sandbox.commands.some((c) => c.includes("checkout -b"))).toBe(false);

  // Nothing was written into the container, and nothing fetched from a file.
  expect([...sandbox.files.keys()].filter((p) => p.endsWith(".bundle"))).toEqual([]);
  expect(sandbox.commands.some((c) => c.includes("fetch") && c.includes(".bundle"))).toBe(false);
});

test("a group that never started is left to startGroup", async () => {
  const { ctx, sandbox, db } = harness();
  db.run("UPDATE grp SET branch = NULL WHERE id = 1");
  await restoreWorkspace(ctx, 1);
  expect(sandbox.commands).toEqual([]);
});
