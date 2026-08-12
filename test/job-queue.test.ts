import { expect, test } from "bun:test";
import { openMemory, type DB } from "../src/db.ts";
import { Scheduler, type Job } from "../src/scheduler.ts";

function seed(db: DB, groups: number, status = "RUNNING"): number[] {
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  const ids: number[] = [];
  for (let i = 1; i <= groups; i++) {
    const r = db
      .query<{ id: number }, [string, string]>(
        "INSERT INTO grp (project_id, name, status, created_at) VALUES (1, ?, ?, 0) RETURNING id",
      )
      .get(`g${i}`, status)!;
    ids.push(r.id);
  }
  return ids;
}

/** Executor that blocks until released, so we can inspect mid-flight state. */
function gate() {
  let release!: () => void;
  const started: Job[] = [];
  const p = new Promise<void>((r) => (release = r));
  return {
    started,
    release,
    exec: async (job: Job) => {
      started.push(job);
      await p;
    },
  };
}

test("per-group concurrency is 1 — the group's single writer", async () => {
  const db = openMemory();
  const [g] = seed(db, 1);
  const g1 = g!;
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec);
  s.enqueue("agent_turn", { grp_id: g1 });
  s.enqueue("agent_turn", { grp_id: g1 });
  s.tick();

  expect(started.length).toBe(1);
  release();
  await s.drain();
  expect(started.length).toBe(2);
});

test("maxGroups caps how many groups run at once", async () => {
  const db = openMemory();
  const ids = seed(db, 5);
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 3 });
  for (const id of ids) s.enqueue("agent_turn", { grp_id: id });
  s.tick();

  expect(started.length).toBe(3);
  release();
  await s.drain();
  expect(started.length).toBe(5);
});

test("leases use their own pool and do not consume group slots", async () => {
  const db = openMemory();
  const ids = seed(db, 3);
  db.run(
    "INSERT INTO resource (name, template) VALUES ('build', 'echo build')",
  );
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 3, leaseSlots: 1 });
  for (const id of ids) s.enqueue("agent_turn", { grp_id: id });
  s.enqueue("lease", { grp_id: ids[0] });
  s.enqueue("lease", { grp_id: ids[1] });
  s.tick();

  // 3 turns + 1 lease; the second lease waits on the Runner pool, not on groups.
  expect(started.length).toBe(4);
  expect(started.filter((j) => j.kind === "lease").length).toBe(1);
  release();
  await s.drain();
  expect(started.filter((j) => j.kind === "lease").length).toBe(2);
});

test("non-RUNNING group status is a barrier — this IS intercept L2", async () => {
  const db = openMemory();
  const [g] = seed(db, 1, "PAUSED");
  const g1 = g!;
  const ran: Job[] = [];
  const s = new Scheduler(db, async (j) => void ran.push(j));
  s.enqueue("agent_turn", { grp_id: g1 });
  await s.drain();
  expect(ran.length).toBe(0);

  db.run("UPDATE grp SET status = 'RUNNING' WHERE id = ?", [g1]);
  await s.drain();
  expect(ran.length).toBe(1);
});

test("exhausted slice budget blocks dispatch before the group budget does", async () => {
  const db = openMemory();
  const [g] = seed(db, 1);
  const g1 = g!;
  const sl = db
    .query<{ id: number }, []>(
      `INSERT INTO slice (grp_id, seq, title, accept_spec, budget_tokens, spent_tokens, created_at)
       VALUES (1, 1, 'S1', 'tests pass', 1000, 1000, 0) RETURNING id`,
    )
    .get()!;
  const ran: Job[] = [];
  const s = new Scheduler(db, async (j) => void ran.push(j));
  s.enqueue("agent_turn", { grp_id: g1, slice_id: sl.id });
  await s.drain();
  expect(ran.length).toBe(0);

  db.run("UPDATE slice SET budget_tokens = 5000 WHERE id = ?", [sl.id]);
  await s.drain();
  expect(ran.length).toBe(1);
});

test("watchdog and notify bypass the group slot pool", async () => {
  const db = openMemory();
  const [g] = seed(db, 1);
  const g1 = g!;
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 1 });
  s.enqueue("agent_turn", { grp_id: g1 });
  s.enqueue("watchdog", { grp_id: g1 });
  s.enqueue("notify", { grp_id: g1 });
  s.tick();

  // Housekeeping must never be starved by a busy group, or the watchdog can
  // never fire on the very group that is stuck.
  expect(started.length).toBe(3);
  release();
  await s.drain();
});

test("a job never stays in `running` — success and failure both settle", async () => {
  const db = openMemory();
  const [g] = seed(db, 1);
  const g1 = g!;
  let first = true;
  const s = new Scheduler(db, async () => {
    if (first) {
      first = false;
      throw new Error("boom");
    }
  });
  s.enqueue("agent_turn", { grp_id: g1 });
  s.enqueue("agent_turn", { grp_id: g1 });
  await s.drain();

  const states = db
    .query<{ state: string; error: string | null }, []>("SELECT state, error FROM job ORDER BY id")
    .all();
  expect(states.map((r) => r.state)).toEqual(["failed", "done"]);
  expect(states[0]!.error).toContain("boom");
  expect(
    db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'running'").get()!.c,
  ).toBe(0);
});

test("cancelPending drops queued work but leaves the in-flight job alone (park)", async () => {
  const db = openMemory();
  const [g] = seed(db, 1);
  const g1 = g!;
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec);
  s.enqueue("agent_turn", { grp_id: g1 });
  s.enqueue("agent_turn", { grp_id: g1 });
  s.enqueue("agent_turn", { grp_id: g1 });
  s.tick();
  expect(started.length).toBe(1);

  expect(s.cancelPending(g1, "parked")).toBe(2);
  release();
  await s.drain();

  expect(started.length).toBe(1);
  const cancelled = db
    .query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'cancelled'")
    .get()!.c;
  expect(cancelled).toBe(2);
});

test("higher priority dispatches first", async () => {
  const db = openMemory();
  const ids = seed(db, 2);
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 1 });
  s.enqueue("agent_turn", { grp_id: ids[0], priority: 0 });
  s.enqueue("agent_turn", { grp_id: ids[1], priority: 10 });
  s.tick();
  expect(started[0]!.grp_id).toBe(ids[1]!);
  release();
  await s.drain();
});
