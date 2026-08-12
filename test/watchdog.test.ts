import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { openMemory, type DB } from "../src/db.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { Notifier, tierFor } from "../src/mech/notify.ts";
import { pause, resume, settlePausing, park } from "../src/mech/intercept.ts";
import { recordTurnOutcome, runWatchdog, IDLE_TURN_LIMIT, SAME_FILE_LIMIT } from "../src/mech/watchdog.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Ctx } from "../src/api.ts";

function harness(over: Partial<ReturnType<typeof loadConfig>> = {}) {
  const db: DB = openMemory();
  const bus = new Bus(db);
  const sched = new Scheduler(db, async () => {});
  const cfg = { ...loadConfig(), ...over };
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gitLock: new RepoLock(),
    git: async () => ({ code: 0, out: "" }),
    waiters: new Map(),
    config: { language: cfg.language, difficultyModel: cfg.difficultyModel, workRoot: "/tmp/x" },
  };
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'engineer', 'm', 't', 0)",
  );
  const deps = { ctx, cfg, git: ctx.git!, now: () => 1_000_000 };
  return { db, ctx, sched, cfg, deps };
}

test("a turn past its wall clock is killed and reported", async () => {
  const h = harness({ turnTimeoutMs: 1000 });
  h.db.run(
    "INSERT INTO job (kind, grp_id, state, started_at, enqueued_at) VALUES ('agent_turn', 1, 'running', 0, 0)",
  );
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("turn_timeout");
  expect(h.db.query<{ state: string }, []>("SELECT state FROM job").get()!.state).toBe("cancelled");
});

test("turns that write nothing accumulate, and productive ones reset", async () => {
  const h = harness();
  for (let i = 0; i < IDLE_TURN_LIMIT; i++) recordTurnOutcome(h.ctx, 1, [], false, false);
  let f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("no_progress");

  recordTurnOutcome(h.ctx, 1, ["a.ts"], false, false);
  f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).not.toContain("no_progress");
});

test("a note or a moved task counts as progress even with no file change", async () => {
  const h = harness();
  recordTurnOutcome(h.ctx, 1, [], true, false);
  recordTurnOutcome(h.ctx, 1, [], false, true);
  recordTurnOutcome(h.ctx, 1, [], false, false);
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).not.toContain("no_progress");
});

test("rewriting one file every turn is caught and sent to the Architect", async () => {
  const h = harness();
  for (let i = 0; i < SAME_FILE_LIMIT; i++) recordTurnOutcome(h.ctx, 1, ["auth/mw.ts"], false, false);
  const f = await runWatchdog(h.deps);
  const circling = f.find((x) => x.rule === "circling")!;
  expect(circling).toBeDefined();
  // The message names the likely cause: telling the writer to try harder does
  // not fix a design problem.
  expect(circling.body).toContain("Architect");
});

test("touching several files does not look like circling", async () => {
  const h = harness();
  for (let i = 0; i < SAME_FILE_LIMIT + 2; i++) recordTurnOutcome(h.ctx, 1, ["a.ts", "b.ts"], false, false);
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).not.toContain("circling");
});

test("the same lease failing twice on unchanged code blames the environment", async () => {
  const h = harness();
  h.db.run("INSERT INTO resource (name, template) VALUES ('build', 'true')");
  const ins = h.db.prepare(
    "INSERT INTO lease (resource, grp_id, state, head_sha, enqueued_at) VALUES ('build', 1, 'failed', ?, 0)",
  );
  ins.run("sha-a");
  ins.run("sha-a");
  const f = await runWatchdog(h.deps);
  const env = f.find((x) => x.rule === "env_suspect")!;
  expect(env).toBeDefined();
  expect(env.body).toContain("environment");
});

test("two failures at different commits are just two failures", async () => {
  const h = harness();
  h.db.run("INSERT INTO resource (name, template) VALUES ('build', 'true')");
  const ins = h.db.prepare(
    "INSERT INTO lease (resource, grp_id, state, head_sha, enqueued_at) VALUES ('build', 1, 'failed', ?, 0)",
  );
  ins.run("sha-a");
  ins.run("sha-b");
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).not.toContain("env_suspect");
});

test("budget warns at 80% and suspends the group at 100%", async () => {
  const h = harness();
  h.db.run("UPDATE grp SET budget_tokens = 1000, spent_tokens = 850 WHERE id = 1");
  let f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("budget_80");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("RUNNING");

  h.db.run("UPDATE grp SET spent_tokens = 1000 WHERE id = 1");
  f = await runWatchdog(h.deps);
  expect(f.find((x) => x.rule === "budget_exhausted")!.severity).toBe("blocker");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSED");
});

test("a long wait notifies first, then parks and frees the slot", async () => {
  const h = harness({ parkAfterPausedMs: 60_000 });
  h.db.run("UPDATE grp SET status = 'PAUSED', paused_at = ? WHERE id = 1", [1_000_000 - 20 * 60_000]);
  let f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("parked");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PARKED");

  const h2 = harness({ parkAfterPausedMs: 2 * 3600_000 });
  h2.db.run("UPDATE grp SET status = 'PAUSED', paused_at = ? WHERE id = 1", [1_000_000 - 20 * 60_000]);
  f = await runWatchdog(h2.deps);
  expect(f.map((x) => x.rule)).toContain("waiting_on_you");
  expect(h2.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSED");
});

test("pause reports how many turns it is waiting on, and settles later", () => {
  const h = harness();
  h.db.run("INSERT INTO job (kind, grp_id, state, enqueued_at) VALUES ('agent_turn', 1, 'running', 0)");
  expect(pause(h.ctx, 1)).toBe(1);
  // PAUSING, not PAUSED: an in-flight turn cannot be steered, and the status
  // should not claim otherwise.
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSING");

  h.db.run("UPDATE job SET state = 'done'");
  expect(settlePausing(h.ctx)).toBe(1);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSED");
});

test("pausing an idle group settles immediately", () => {
  const h = harness();
  expect(pause(h.ctx, 1)).toBe(0);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSED");
  resume(h.ctx, 1);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("RUNNING");
});

test("park drops queued turns, retires sessions, keeps the worktree", () => {
  const h = harness();
  h.db.run("UPDATE grp SET worktree = '/tmp/wt/g1' WHERE id = 1");
  h.db.run("UPDATE agent SET session_id = 'live', session_tokens = 5000 WHERE id = 1");
  h.sched.enqueue("agent_turn", { grp_id: 1 });
  h.sched.enqueue("agent_turn", { grp_id: 1 });

  park(h.ctx, 1, "waited for you");

  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'cancelled'").get()!.c).toBe(2);
  const a = h.db.query<{ session_id: string | null }, []>("SELECT session_id FROM agent").get()!;
  expect(a.session_id).toBeNull();
  // Park is resource reclamation, not an approval step: nothing is lost.
  expect(h.db.query<{ worktree: string }, []>("SELECT worktree FROM grp").get()!.worktree).toBe("/tmp/wt/g1");
});

// ------------------------------------------------------------------ notifier

test("blockers interrupt immediately; ordinary findings are batched", () => {
  expect(tierFor("budget_80")).toBe("batched");
  expect(tierFor("anything", "blocker")).toBe("immediate");
  expect(tierFor("waiting_on_you")).toBe("immediate");
});

test("a repeat of the same problem backs off instead of nagging every tick", async () => {
  let t = 0;
  const sent: string[] = [];
  const n = new Notifier({ now: () => t, deliver: (_title, body) => void sent.push(body) });

  expect(await n.push({ key: "esc:1", tier: "immediate", body: "answer me" })).toBe(true);
  t += 60_000;
  expect(await n.push({ key: "esc:1", tier: "immediate", body: "answer me" })).toBe(false);
  t += 5 * 60_000;
  expect(await n.push({ key: "esc:1", tier: "immediate", body: "answer me" })).toBe(true);
  // Second reminder waits 15 min, not another 5.
  t += 6 * 60_000;
  expect(await n.push({ key: "esc:1", tier: "immediate", body: "answer me" })).toBe(false);
  t += 10 * 60_000;
  expect(await n.push({ key: "esc:1", tier: "immediate", body: "answer me" })).toBe(true);
  expect(sent.length).toBe(3);
});

test("a different problem is not suppressed by an unrelated one", async () => {
  const n = new Notifier({ now: () => 0, deliver: () => {} });
  expect(await n.push({ key: "a", tier: "immediate", body: "x" })).toBe(true);
  expect(await n.push({ key: "b", tier: "immediate", body: "y" })).toBe(true);
});

test("batched notifications arrive as one interruption", async () => {
  const sent: string[] = [];
  const n = new Notifier({ batchSize: 3, now: () => 0, deliver: (_t, b) => void sent.push(b) });
  await n.push({ key: "1", tier: "batched", body: "one" });
  await n.push({ key: "2", tier: "batched", body: "two" });
  expect(sent.length).toBe(0);
  expect(n.pending()).toBe(2);

  await n.push({ key: "3", tier: "batched", body: "three" });
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain("3 things need you");
  expect(sent[0]).toContain("• two");
});

test("answering clears the reminder", async () => {
  let t = 0;
  const n = new Notifier({ now: () => t, deliver: () => {} });
  await n.push({ key: "esc:7", tier: "immediate", body: "q" });
  n.clear("esc:7");
  // Cleared, so the next occurrence is a new problem rather than a reminder.
  expect(await n.push({ key: "esc:7", tier: "immediate", body: "q" })).toBe(true);
});
