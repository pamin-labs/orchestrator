import { expect, test } from "bun:test";
import type { Ctx } from "../src/api.ts";
import { Bus } from "../src/bus.ts";
import { openMemory, type DB } from "../src/db.ts";
import { Scheduler, type Job } from "../src/scheduler.ts";
import { restoreWorkspace } from "../src/mech/start.ts";
import { fakeSandbox } from "./fake-sandbox.ts";

/**
 * A sandbox is where the work lives and it is replaceable — the TTL reaps an
 * idle one, a credential change kills it, the server restarts. Rebuilding gave
 * back an empty container: no clone, no dependencies, and the next turn
 * reporting that the repository was broken.
 */
function harness(opts: { install?: string | null; installFails?: boolean } = {}) {
  const db: DB = openMemory();
  const bus = new Bus(db);
  const ran: Job[] = [];
  const queued: Job[] = [];
  const sched = new Scheduler(db, async (j) => void ran.push(j));
  const realEnqueue = sched.enqueue.bind(sched);
  sched.enqueue = ((kind: string, spec: Record<string, unknown>) => {
    queued.push({ kind, ...spec } as unknown as Job);
    return realEnqueue(kind as never, spec as never);
  }) as typeof sched.enqueue;

  const sandbox = fakeSandbox((cmd) => {
    if (cmd.includes("test -d")) return { out: "" }; // no clone in there yet
    if (opts.installFails && cmd.includes("install")) return { code: 1, err: "boom" };
    return {};
  });
  const ctx = {
    db,
    bus,
    sched,
    sandbox,
    waiters: new Map(),
    // Answers where origin is, and says the branch is not on this host — the
    // bundle path is `seedBranch`'s and has its own tests.
    git: (async (_repo: string, argv: string[]) =>
      argv[0] === "remote"
        ? { code: 0, out: "https://example.com/x.git", err: "" }
        : { code: 1, out: "", err: "no such ref" }) as never,
    config: { language: "中文", workRoot: "/tmp/orch-test/wt", installTimeoutMs: 1000 },
  } as unknown as Ctx;

  db.run("INSERT INTO project (name, repo_path, config_json, created_at) VALUES ('p', '/tmp/p', ?, 0)", [
    JSON.stringify(opts.install === undefined ? {} : { install: opts.install }),
  ]);
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
  expect(queued.some((j) => (j as { payload?: { role?: string } }).payload?.role === "bootstrap")).toBe(true);
});

test("a recorded command that stopped working hands the failure to that role", async () => {
  const { ctx, queued } = harness({ install: "bun install", installFails: true });
  await restoreWorkspace(ctx, 1);
  const boot = queued.find((j) => (j as { payload?: { role?: string } }).payload?.role === "bootstrap");
  expect((boot as { payload?: { rejection?: string } })?.payload?.rejection).toContain("bun install");
});

test("a group that never started is left to startGroup", async () => {
  const { ctx, sandbox, db } = harness();
  db.run("UPDATE grp SET branch = NULL WHERE id = 1");
  await restoreWorkspace(ctx, 1);
  expect(sandbox.commands).toEqual([]);
});
