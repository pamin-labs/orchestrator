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

test("DRAFT stops the writers, not the planners", async () => {
  // A refused approval enqueues an Architect turn to cut the boundary — and the
  // group it enqueues it on is the one sitting in DRAFT. Blocking every role there
  // meant the boundary was never cut, so the approval never landed and the boss was
  // told to click again. Three groups were holding a job like this at once.
  const db = openMemory();
  const [g] = seed(db, 1, "DRAFT");
  const g1 = g!;
  const ran: Job[] = [];
  const s = new Scheduler(db, async (j) => void ran.push(j));
  s.enqueue("agent_turn", { grp_id: g1, payload: { role: "engineer" } });
  await s.drain();
  expect(ran.length).toBe(0);

  s.enqueue("agent_turn", { grp_id: g1, payload: { role: "architect" } });
  await s.drain();
  expect(ran.map((j) => JSON.parse(j.payload_json).role)).toEqual(["architect"]);
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

test("a standing agent's turn takes a slot like anyone else's", async () => {
  const db = openMemory();
  seed(db, 1);
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 1 });
  s.enqueue("agent_turn", { grp_id: null, payload: { role: "librarian" } });
  s.enqueue("agent_turn", { grp_id: 1 });
  s.tick();

  // A standing turn costs the same money and CPU as a group's, so bypassing the
  // pool would make a concurrency limit meaningless.
  expect(started.length).toBe(1);
  release();
  await s.drain();
  expect(started.length).toBe(2);
});

test("two standing turns do not run at once", async () => {
  const db = openMemory();
  seed(db, 1);
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 3 });
  s.enqueue("agent_turn", { grp_id: null, payload: { role: "librarian" } });
  s.enqueue("agent_turn", { grp_id: null, payload: { role: "architect" } });
  s.tick();
  expect(started.length).toBe(1);
  release();
  await s.drain();
  expect(started.length).toBe(2);
});

test("maxGroups 0 means nothing runs at all", async () => {
  const db = openMemory();
  seed(db, 1);
  const ran: Job[] = [];
  const s = new Scheduler(db, async (j) => void ran.push(j), { maxGroups: 0 });
  s.enqueue("agent_turn", { grp_id: 1 });
  s.enqueue("agent_turn", { grp_id: null });
  await s.drain();
  expect(ran.length).toBe(0);
});

test("a turn left running by a dead server is reclaimed, not left holding the slot", async () => {
  const db = openMemory();
  seed(db, 1);
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, state, created_at) VALUES (1, 1, 'qa', 'm', 'running', 0)",
  );
  // Started just now, so it is the dead pid that identifies the orphan rather
  // than the age check.
  db.run(
    "INSERT INTO job (kind, grp_id, state, pid, started_at, enqueued_at) VALUES ('agent_turn', 1, 'running', 89992, ?, 0)",
    [Date.now()],
  );
  db.run("INSERT INTO job (kind, grp_id, state, enqueued_at) VALUES ('reconcile', 1, 'pending', 0)");

  const { reclaimOrphans } = await import("../src/scheduler.ts");
  // The pid belongs to nothing: the previous server exited mid-turn.
  expect(reclaimOrphans(db, { alive: () => false })).toHaveLength(1);

  const j = db.query<{ error: string }, []>("SELECT error FROM job WHERE id = 1").get()!;
  expect(j.error).toContain("process 89992 is gone");
  // The agent believed it was mid-turn too, and a running agent is skipped forever.
  expect(db.query<{ state: string }, []>("SELECT state FROM agent").get()!.state).toBe("idle");

  // And the queue moves again — which it never would have while the slot was held.
  const ran: Job[] = [];
  await new Scheduler(db, async (job) => void ran.push(job)).drain();
  expect(ran.map((r) => r.kind)).toEqual(["reconcile"]);
});

test("a live process is left alone", () => {
  const db = openMemory();
  seed(db, 1);
  db.run(
    "INSERT INTO job (kind, grp_id, state, pid, started_at, enqueued_at) VALUES ('agent_turn', 1, 'running', 4242, ?, 0)",
    [Date.now()],
  );
  const { reclaimOrphans } = require("../src/scheduler.ts");
  expect(reclaimOrphans(db, { alive: () => true })).toHaveLength(0);
  expect(db.query<{ state: string }, []>("SELECT state FROM job").get()!.state).toBe("running");
});

test("a job with no pid, or one running impossibly long, is also an orphan", () => {
  const db = openMemory();
  seed(db, 1);
  db.run("INSERT INTO job (kind, grp_id, state, started_at, enqueued_at) VALUES ('agent_turn', 1, 'running', 0, 0)");
  db.run(
    "INSERT INTO job (kind, grp_id, state, pid, started_at, enqueued_at) VALUES ('agent_turn', 1, 'running', 1, 0, 0)",
  );
  const { reclaimOrphans } = require("../src/scheduler.ts");
  // Never recorded a pid, and still "running" long past any turn's limit.
  expect(reclaimOrphans(db, { alive: () => true, maxAgeMs: 1000, now: () => 10_000_000 })).toHaveLength(2);
});

test("a restart resumes the turn it interrupted, but only once", async () => {
  const db = openMemory();
  seed(db, 1);
  db.run(
    `INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at)
     VALUES (1, 1, 't', 'a', 'running', 0)`,
  );
  db.run(
    `INSERT INTO job (kind, grp_id, slice_id, payload_json, state, pid, started_at, enqueued_at)
     VALUES ('agent_turn', 1, 1, '{"role":"engineer"}', 'running', 89992, 0, 0)`,
  );
  // The timer re-adds these itself; resuming them would just double them up.
  db.run("INSERT INTO job (kind, state, pid, started_at, enqueued_at) VALUES ('watchdog', 'running', 89992, 0, 0)");

  const { reclaimOrphans, resumeReclaimed } = await import("../src/scheduler.ts");
  const sched = new Scheduler(db, async () => {});
  expect(resumeReclaimed(sched, reclaimOrphans(db, { alive: () => false }))).toBe(1);

  const back = db
    .query<{ kind: string; slice_id: number | null; payload_json: string }, []>(
      "SELECT kind, slice_id, payload_json FROM job WHERE state = 'pending'",
    )
    .all();
  expect(back).toHaveLength(1);
  expect(back[0]!.slice_id).toBe(1);
  expect(JSON.parse(back[0]!.payload_json).role).toBe("engineer");

  // Second restart: a turn that takes the server down with it must not be
  // resurrected forever.
  db.run("UPDATE job SET state = 'running', pid = 89992, started_at = 0 WHERE state = 'pending'");
  expect(resumeReclaimed(sched, reclaimOrphans(db, { alive: () => false }))).toBe(0);
});
