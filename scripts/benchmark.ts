import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { openMemory, type DB } from "../src/db.ts";
import { snapshot } from "../src/api/panel/snapshot.ts";
import { reconcile } from "../src/mech/flow/reconcile.ts";
import { runWatchdog } from "../src/mech/ops/watchdog.ts";
import { assemble, type StablePrompt } from "../src/prompt/assemble.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Ctx } from "../src/ctx.ts";

async function budget(name: string, limitMs: number, work: () => void | Promise<void>): Promise<void> {
  const started = performance.now();
  await work();
  const elapsed = performance.now() - started;
  console.log(`${name}: ${elapsed.toFixed(2)}ms / ${limitMs}ms`);
  if (elapsed > limitMs) throw new Error(`${name} exceeded its significant-regression budget`);
}

const db = openMemory();
const cfg = loadConfig();
const bus = new Bus(db);
const scheduler = new Scheduler(db, async () => {}, { maxGroups: 1_000 });
const ctx: Ctx = { db, bus, sched: scheduler, waiters: new Map(), config: cfg };
const stable: StablePrompt = {
  systemAppend: "system",
  model: "benchmark",
  tools: [],
  allowedTools: [],
  addDirs: [],
  hash: "stable",
};

db.run("INSERT INTO project (name, repo_path, base_branch, created_at) VALUES ('bench', 'acme/bench', 'main', 0)");
db.run("INSERT INTO runtime_auth (runtime, mode, secret, updated_at) VALUES ('claude', 'api_key', 'bench-secret', 0)");

function seedGroup(index: number): void {
  const group = db
    .query<{ id: number }, [string, string]>(
      "INSERT INTO grp (project_id, name, branch, status, created_at) VALUES (1, ?, ?, 'RUNNING', 0) RETURNING id",
    )
    .get(`bench-${index}`, `orch/bench-${index}`)!;
  const slice = db
    .query<{ id: number }, [number, string]>(
      "INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at) VALUES (?, 1, ?, 'passes', 'running', 0) RETURNING id",
    )
    .get(group.id, `slice-${index}`)!;
  const agent = db
    .query<{ id: number }, [number, string]>(
      "INSERT INTO agent (project_id, grp_id, role, model, runtime, created_at) VALUES (1, ?, 'engineer', ?, 'claude', 0) RETURNING id",
    )
    .get(group.id, `model-${index % 3}`)!;
  const channel = db
    .query<{ id: number }, [number]>(
      "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (1, ?, 'group', 0) RETURNING id",
    )
    .get(group.id)!;
  db.run("INSERT INTO task (grp_id, slice_id, title, status, created_at) VALUES (?, ?, 'work', 'open', 0)", [
    group.id,
    slice.id,
  ]);
  db.run(
    "INSERT INTO event (channel_id, grp_id, author, kind, body, at) VALUES (?, ?, 'engineer', 'say', 'working', 0)",
    [channel.id, group.id],
  );
  db.run(
    "INSERT INTO job (kind, grp_id, agent_id, slice_id, payload_json, state, enqueued_at, ended_at) VALUES ('agent_turn', ?, ?, ?, '{}', 'done', 0, 1)",
    [group.id, agent.id, slice.id],
  );
}

function snapshotQueries(): number {
  let queries = 0;
  const counted = new Proxy(db, {
    get(target, property) {
      if (property !== "query") throw new Error(`snapshot accessed unsupported database member ${String(property)}`);
      return (...args: Parameters<DB["query"]>) => {
        queries += 1;
        return target.query(...args);
      };
    },
  });
  snapshot({ ...ctx, db: counted });
  return queries;
}

seedGroup(1);
const oneGroupQueries = snapshotQueries();
for (let i = 2; i <= 50; i++) seedGroup(i);
const fiftyGroupQueries = snapshotQueries();
console.log(`snapshot query count: 1 group=${oneGroupQueries}, 50 groups=${fiftyGroupQueries}`);
if (fiftyGroupQueries !== oneGroupQueries) throw new Error("snapshot query count grows with group rows");

await budget("snapshot x200", 200, () => {
  for (let i = 0; i < 200; i++) snapshot(ctx);
});
await budget("prompt assemble x10000", 40, () => {
  for (let i = 0; i < 10_000; i++) assemble(stable, { card: `slice ${i}`, extra: "delta" });
});
await budget("reconcile x10000", 60, () => {
  for (let i = 0; i < 10_000; i++) {
    reconcile({ claims: [{ files: ["src/a.ts"], summary: "changed" }], changedFiles: ["src/a.ts", "test/a.test.ts"] });
  }
});
await budget("scheduler x500", 400, async () => {
  for (let i = 0; i < 500; i++) scheduler.enqueue("agent_turn", { grp_id: (i % 50) + 1 });
  scheduler.tick();
  await scheduler.drain();
});
await budget("watchdog x20", 1_200, async () => {
  for (let i = 0; i < 20; i++) {
    await runWatchdog({
      ctx,
      cfg,
      now: () => 1_000_000,
      pollUsage: async () => {},
      probe: async () => ({ online: true, changed: false }),
    });
  }
});

db.close();
