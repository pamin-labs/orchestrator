import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bus } from "../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../src/platform/config/load.ts";
import { openMemory, type DB } from "../src/platform/persistence/database.ts";
import { busDeliver, Notifier, notifiable, tierFor, batchForBoss } from "../src/mech/ops/notify.ts";
import { pause, resume, settlePausing, park } from "../src/mech/flow/intercept.ts";
import {
  DROP_AFTER_MS,
  GZIP_AFTER_MS,
  recordTurnOutcome,
  runWatchdog,
  sweepTurnLogs,
  IDLE_TURN_LIMIT,
  SAME_FILE_LIMIT,
} from "../src/mech/ops/watchdog.ts";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTurnPayloadSchema, Scheduler } from "../src/platform/scheduling/scheduler.ts";
import type { Ctx } from "../src/ctx.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";
import type { Json } from "../src/contracts/json.ts";
import { z } from "zod";

const NotifyMeta = z.object({ url: z.string() });
const WebhookBody = z.object({ message: z.string() });

/** A GitHub client that answers from a function and records the paths asked. */
const gh = (answer: (path: string) => Json) =>
  ({
    remaining: () => null,
    request: async (_method, path, schema) => ({ ok: true as const, status: 200, data: schema.parse(answer(path)) }),
  }) satisfies NonNullable<Ctx["gh"]>;

const watchdogDbImage = (() => {
  const db = openMemory();
  seedAuth(db);
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'engineer', 'm', 't', 0)",
  );
  const image = db.serialize();
  db.close();
  return image;
})();

function watchdogDb(): DB {
  const db = Database.deserialize(watchdogDbImage, { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

function harness(over: Partial<ReturnType<typeof loadConfig>> = {}) {
  const db = watchdogDb();
  const bus = new Bus(db);
  const sched = new Scheduler(db, async () => {});
  const cfg = { ...loadConfig(), ...over };
  const ctx: Ctx = {
    db,
    bus,
    sched,
    // `merge-base --is-ancestor` runs in the group's checkout, which lives in its
    // sandbox. Not an ancestor = the group has not rebased yet, which is the
    // condition every rule below is about.
    sandbox: fakeSandbox((cmd) => (cmd.includes("merge-base") ? { code: 1 } : { code: 0 })),
    waiters: new Map(),
    config: cfg,
  };
  // No network on a watchdog tick in tests, and that now covers two calls: the
  // usage endpoint (which once hung on its 10s timeout inside a gate sandbox and
  // took the suite red) and the reachability probe. Both are injected for the
  // same reason — a test that asks the network is a test that fails on a train.
  const deps = {
    ctx,
    cfg,
    now: () => 1_000_000,
    pollUsage: async () => {},
    probe: async () => ({ online: true, changed: false }),
  };
  return { db, ctx, sched, cfg, deps };
}

test("a turn past its wall clock is killed and reported", async () => {
  const h = harness({ turnTimeoutMs: 1000 });
  h.db.run("INSERT INTO job (kind, grp_id, state, started_at, enqueued_at) VALUES ('agent_turn', 1, 'running', 0, 0)");
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("turn_timeout");
  expect(h.db.query<{ state: string }, []>("SELECT state FROM job").get()!.state).toBe("cancelled");
});

test("a RUNNING group whose last turn failed is put back once, then handed to the boss", async () => {
  // Failure is terminal, so the chain just ends: RUNNING group, empty queue, no
  // error anywhere the boss looks. Six groups sat like this behind one bad path.
  const h = harness();
  h.db.run(
    `INSERT INTO job (kind, grp_id, slice_id, payload_json, state, error, enqueued_at)
     VALUES ('agent_turn', 1, NULL, '{"role":"engineer"}', 'failed', 'Settings file not found', 0)`,
  );
  expect((await runWatchdog(h.deps)).map((x) => x.rule)).not.toContain("stalled");
  const back = h.db.query<{ payload_json: string }, []>("SELECT payload_json FROM job WHERE state = 'pending'").all();
  expect(back).toHaveLength(1);
  expect(AgentTurnPayloadSchema.parse(JSON.parse(back[0]!.payload_json)).role).toBe("engineer");

  // It failed again. A third try is not going to work either — say so instead.
  h.db.run("UPDATE job SET state = 'failed', error = 'same thing' WHERE state = 'pending'");
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("stalled");
  expect(f.find((x) => x.rule === "stalled")!.body).toContain("same thing");
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'pending'").get()!.c).toBe(0);
});

test("a turn that ended cleanly without arranging the next one also counts as stalled", async () => {
  // The exit code is not the signal. A Dispatcher that finished without filing a
  // card leaves PLANNING with an empty queue, and that reads identically to
  // success from every view the boss has.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'PLANNING' WHERE id = 1");
  h.db.run(
    `INSERT INTO job (kind, grp_id, payload_json, state, enqueued_at)
     VALUES ('agent_turn', 1, '{"role":"dispatcher"}', 'done', 0)`,
  );
  await runWatchdog(h.deps);
  const back = h.db.query<{ payload_json: string }, []>("SELECT payload_json FROM job WHERE state = 'pending'").get()!;
  expect(AgentTurnPayloadSchema.parse(JSON.parse(back.payload_json)).role).toBe("dispatcher");
});

test("work queued for a dissolved group is cancelled, not left pending forever", async () => {
  // Drop and split both cancel what was pending, but a mail landing a moment later
  // enqueues another, and no status a dissolved group has is dispatchable.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'DISSOLVED' WHERE id = 1");
  h.db.run("INSERT INTO job (kind, grp_id, state, enqueued_at) VALUES ('agent_turn', 1, 'pending', 0)");
  await runWatchdog(h.deps);
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
  // The body follows output.language (中文 here); the resource name is a technical
  // term and stays verbatim in both.
  expect(env.body).toContain("build");
  expect(env.body).toContain("环境");
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

test("a group that reaches PAUSED always carries the time it got there", async () => {
  const h = harness();
  // The ask-boss blocker path writes PAUSING without a timestamp. Every
  // watchdog timer keys off paused_at, so a NULL here froze the group with
  // nobody nudged and nothing parked.
  h.db.run("UPDATE grp SET status = 'PAUSING' WHERE id = 1");
  settlePausing(h.ctx);
  expect(h.db.query<{ p: number | null }, []>("SELECT paused_at AS p FROM grp").get()!.p).toBeGreaterThan(0);

  // And an already-broken row is repaired rather than left invisible forever.
  h.db.run("UPDATE grp SET status = 'PAUSED', paused_at = NULL WHERE id = 1");
  await runWatchdog(h.deps);
  expect(h.db.query<{ p: number | null }, []>("SELECT paused_at AS p FROM grp").get()!.p).toBeGreaterThan(0);
});

test("pausing an idle group settles immediately", () => {
  const h = harness();
  expect(pause(h.ctx, 1)).toBe(0);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSED");
  resume(h.ctx, 1);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("RUNNING");
});

test("park drops queued turns and retires sessions, keeping the checkout", () => {
  const h = harness();
  h.db.run("UPDATE grp SET sandbox_id = 'sb-1' WHERE id = 1");
  h.db.run("UPDATE agent SET session_id = 'live', session_tokens = 5000 WHERE id = 1");
  h.sched.enqueue("agent_turn", { grp_id: 1 });
  h.sched.enqueue("agent_turn", { grp_id: 1 });

  park(h.ctx, 1, "waited for you");

  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'cancelled'").get()!.c).toBe(2);
  const a = h.db.query<{ session_id: string | null }, []>("SELECT session_id FROM agent").get()!;
  expect(a.session_id).toBeNull();
  // Park is resource reclamation, not an approval step: nothing is lost.
  // Parking is not dissolving: the sandbox, and the work in it, stay.
  expect(h.db.query<{ s: string }, []>("SELECT sandbox_id AS s FROM grp").get()!.s).toBe("sb-1");
});

// ------------------------------------------------------------------ notifier

test("only what the boss can act on is worth a notification", async () => {
  // "main 动到了 549e8bc，已经让它先 rebase" arrived under a heading that said
  // "5 things need you". It needed nobody: the system had already handled it. Two
  // of those in a row and the heading stops meaning anything, which costs the
  // notifications that were real.
  expect(notifiable("base_moved", "advisory")).toBe(false);
  expect(notifiable("repeat_failure", "advisory")).toBe(false);
  expect(notifiable("env_suspect", "advisory")).toBe(false);
  expect(notifiable("unshipped", "advisory")).toBe(false);
  expect(notifiable("parked", "advisory")).toBe(false);

  // The boss's own queue, and money running out.
  expect(notifiable("waiting_slice", "advisory")).toBe(true);
  expect(notifiable("waiting_merge", "advisory")).toBe(true);
  expect(notifiable("budget_exhausted", "advisory")).toBe(true);
  // Severity still wins: anything that stopped a group reaches them.
  expect(notifiable("stalled", "blocker")).toBe(true);
});

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

test("a batched finding re-derived every tick is not re-sent every tick", async () => {
  const sent: string[] = [];
  let t = 0;
  const n = new Notifier({ batchSize: 2, now: () => t, deliver: (_x, b) => void sent.push(b) });
  // The standup re-derives the same two findings every 30 s and pushes them again.
  for (let tick = 0; tick < 6; tick++) {
    await n.push({ key: "repeat_failure:0", tier: "batched", body: "typecheck is failing" });
    await n.push({ key: "stalled:3", tier: "batched", body: "g3 stopped" });
    t += 30_000;
  }
  expect(sent.length).toBe(1);

  // Past the first backoff step it is a reminder, and arrives once more.
  t += 5 * 60_000;
  await n.push({ key: "repeat_failure:0", tier: "batched", body: "typecheck is failing" });
  await n.push({ key: "stalled:3", tier: "batched", body: "g3 stopped" });
  expect(sent.length).toBe(2);
});

test("answering clears the reminder", async () => {
  let t = 0;
  const n = new Notifier({ now: () => t, deliver: () => {} });
  await n.push({ key: "esc:7", tier: "immediate", body: "q" });
  n.clear("esc:7");
  // Cleared, so the next occurrence is a new problem rather than a reminder.
  expect(await n.push({ key: "esc:7", tier: "immediate", body: "q" })).toBe(true);
});

// ------------------------------------------------------- boss batching backstop

test("several things waiting on the boss become one message", () => {
  const n = batchForBoss([
    { id: 1, severity: "advisory", question: "which library?", group: "auth" },
    { id: 2, severity: "advisory", question: "rename the flag?", group: "ui" },
  ])!;
  expect(n.body).toContain("2 waiting on you");
  expect(n.body).toContain("• auth:");
  expect(n.body).toContain("• ui:");
  expect(n.tier).toBe("batched");
});

test("one blocker in the set makes the whole batch immediate", () => {
  const n = batchForBoss([
    { id: 1, severity: "advisory", question: "a", group: "x" },
    { id: 2, severity: "blocker", question: "b", group: "y" },
  ])!;
  expect(n.tier).toBe("immediate");
  expect(n.body).toContain("1 blocking");
});

test("the batch key is the set, so a new arrival is news and a repeat is not", () => {
  const two = batchForBoss([
    { id: 1, severity: "advisory", question: "a", group: null },
    { id: 2, severity: "advisory", question: "b", group: null },
  ])!;
  const same = batchForBoss([
    { id: 2, severity: "advisory", question: "b", group: null },
    { id: 1, severity: "advisory", question: "a", group: null },
  ])!;
  const three = batchForBoss([
    { id: 1, severity: "advisory", question: "a", group: null },
    { id: 2, severity: "advisory", question: "b", group: null },
    { id: 3, severity: "advisory", question: "c", group: null },
  ])!;
  // Order-independent: the same set is the same reminder, and backs off.
  expect(same.key).toBe(two.key);
  expect(three.key).not.toBe(two.key);
});

test("a single item is not dressed up as a batch, and nothing waiting sends nothing", () => {
  expect(batchForBoss([])).toBeNull();
  const one = batchForBoss([{ id: 7, severity: "blocker", question: "which lib?", group: "auth" }])!;
  expect(one.key).toBe("escalation:7");
  expect(one.body).toContain("auth: which lib?");
});

test("a batched notification carries a link, and one item links to its requirement", () => {
  // Without this the batched path built notifications with no url, which fell
  // back to osascript: no click target, and the notification belonged to
  // whatever app ran the script rather than to the page it is about.
  const one = batchForBoss(
    [{ id: 7, grpId: 3, severity: "blocker", question: "which library?", group: "auth" }],
    "http://127.0.0.1:47821",
  )!;
  expect(one.url).toBe("http://127.0.0.1:47821/#g=3&v=progress");

  const many = batchForBoss(
    [
      { id: 7, grpId: 3, severity: "advisory", question: "a", group: "auth" },
      { id: 8, grpId: 4, severity: "advisory", question: "b", group: "bye" },
    ],
    "http://127.0.0.1:47821",
  )!;
  // Two requirements, so the link is the front page rather than an arbitrary one.
  expect(many.url).toBe("http://127.0.0.1:47821");
});

test("a rate-limited group resumes itself when the quota comes back", async () => {
  const h = harness();
  // docs/project/plan.md §11: on the cheapest tier there is nothing to downgrade to, so it waits —
  // and waiting is only useful if something watches the clock. Before this, one 429 at
  // 01:00 held the group until the boss woke up, which is the failure the whole system
  // exists to prevent.
  h.db.run("UPDATE grp SET status = 'PAUSED', paused_at = ?, rl_resets_at = ? WHERE id = 1", [
    1_000_000 - 60_000,
    1_000_000 - 1_000,
  ]);
  const found = await runWatchdog(h.deps);
  expect(found.some((f) => f.rule === "rate_limit_resumed")).toBe(true);
  const g = h.db
    .query<{ status: string; rl: number | null }, []>("SELECT status, rl_resets_at AS rl FROM grp WHERE id = 1")
    .get()!;
  expect(g.status).toBe("RUNNING");
  expect(g.rl).toBe(null);
});

test("a group waiting on quota is not parked out from under itself", async () => {
  const h = harness();
  // parkAfterPausedMs has passed, but the reset has not. Parking here retires the
  // sessions minutes before it could have resumed on its own.
  h.db.run("UPDATE grp SET status = 'PAUSED', paused_at = ?, rl_resets_at = ? WHERE id = 1", [
    1_000_000 - h.cfg.parkAfterPausedMs - 1000,
    1_000_000 + 600_000,
  ]);
  const found = await runWatchdog(h.deps);
  expect(found.some((f) => f.rule === "parked")).toBe(false);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PAUSED");
});

test("the group it was waiting on landed, so it starts again by itself", async () => {
  // `orch blocked` hands a defect outside a group's boundary to whoever can fix it
  // and stops the caller. Nothing else in the system knows that one group's merge
  // is another group's green light.
  const h = harness();
  h.db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'fixer', 'RUNNING', 0)");
  h.db.run("UPDATE grp SET status = 'PAUSED', paused_at = 0, blocked_on = 2 WHERE id = 1");

  // Still running: nothing to wake up for, and parking must not touch it either —
  // it is waiting on another group, not on the boss.
  await runWatchdog(h.deps);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PAUSED");

  h.db.run("UPDATE grp SET status = 'DISSOLVED' WHERE id = 2");
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("unblocked");
  const g = h.db
    .query<{ status: string; blocked_on: number | null }, []>("SELECT status, blocked_on FROM grp WHERE id = 1")
    .get()!;
  expect(g.status).toBe("RUNNING");
  expect(g.blocked_on).toBeNull();
});

test("a question stranded on a stopped group is lifted to the boss", async () => {
  // route() handles this at routing time, but a group can stop *after* a question
  // was handed to its PM — and every one filed before that fix is still sitting
  // where it was. Symptom: a stopped group and a 待办 count of zero.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'PAUSED', paused_at = 999_999 WHERE id = 1");
  h.db.run(
    `INSERT INTO escalation (grp_id, severity, question, chain_state, created_at)
     VALUES (1, 'blocker', 'S1 failed the gate 3 times', 'pm', 0)`,
  );
  await runWatchdog(h.deps);
  expect(h.db.query<{ chain_state: string }, []>("SELECT chain_state FROM escalation").get()!.chain_state).toBe("boss");
});

test("a parked group whose question got answered comes back", async () => {
  // answer() un-pauses PAUSED groups and silently skips PARKED ones, so a group
  // that waited long enough to be parked stayed parked even after the boss answered
  // the very thing it was waiting for.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'PARKED', paused_at = 100 WHERE id = 1");
  h.db.run(
    `INSERT INTO escalation (grp_id, severity, question, answer, answered_by, chain_state, created_at, answered_at)
     VALUES (1, 'blocker', 'which library?', 'the stdlib one', 'boss', 'answered', 0, 500)`,
  );
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("unparked");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).not.toBe("PARKED");
});

test("parking is not undone on the tick that did it", async () => {
  // Most parked groups never had a blocker at all. "No open blocker" would revive
  // every one of them immediately, including the one just parked for waiting.
  const h = harness({ parkAfterPausedMs: 60_000 });
  h.db.run("UPDATE grp SET status = 'PAUSED', paused_at = ? WHERE id = 1", [1_000_000 - 20 * 60_000]);
  await runWatchdog(h.deps);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PARKED");
  await runWatchdog(h.deps);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PARKED");
});

test("the three places that wait on the boss each carry a clock", async () => {
  // They are meant to wait. What was missing is that they waited in silence, so
  // "waiting since Tuesday" and "arrived a minute ago" looked exactly alike.
  const h = harness();
  const old = 1_000_000 - 5 * 3_600_000;
  h.db.run("UPDATE grp SET status = 'DRAFT' WHERE id = 1");
  h.db.run("INSERT INTO note (grp_id, kind, lang, body, frontmatter_json, at) VALUES (1, 'fact', 'zh', 'card', ?, ?)", [
    JSON.stringify({ draft_card: 1 }),
    old,
  ]);
  h.db.run(
    `INSERT INTO slice (grp_id, seq, title, accept_spec, status, awaiting_at, created_at)
     VALUES (1, 1, 'S1', 'a', 'awaiting_boss', ?, 0)`,
    [old],
  );
  h.db.run(
    "INSERT INTO grp (project_id, name, status, merge_seq, merge_seq_at, created_at) VALUES (1, 'q1', 'PR_OPEN', 1, ?, 0)",
    [old],
  );
  h.db.run(
    "INSERT INTO grp (project_id, name, status, merge_seq, merge_seq_at, created_at) VALUES (1, 'q2', 'PR_OPEN', 2, ?, 0)",
    [old],
  );

  const rules = (await runWatchdog(h.deps)).map((x) => x.rule);
  expect(rules).toContain("waiting_card");
  expect(rules).toContain("waiting_slice");
  expect(rules).toContain("waiting_merge");
  // Only the head — everything behind it is waiting on this one merge, and that
  // count is the whole reason to care.
  const merge = (await runWatchdog({ ...h.deps, now: () => 1_000_001 })).filter((x) => x.rule === "waiting_merge");
  expect(merge).toHaveLength(0); // deduplicated: nagging every half hour is noise
});

test("a rebase the Engineer could not finish goes to the Architect, not round again", async () => {
  // A conflict it lost twice is a design question — main moved for a reason, and
  // the Engineer only knows its own slice. Sending it back with more determination
  // produces code that compiles and points the wrong way, which nothing downstream
  // can catch.
  const h = harness();
  h.db.run(
    `INSERT INTO job (kind, grp_id, payload_json, state, error, enqueued_at)
     VALUES ('agent_turn', 1, '{"role":"engineer","conflict":true}', 'failed', 'could not rebase', 0)`,
  );
  await runWatchdog(h.deps);
  const p = AgentTurnPayloadSchema.parse(
    JSON.parse(
      h.db.query<{ payload_json: string }, []>("SELECT payload_json FROM job WHERE state = 'pending'").get()!
        .payload_json,
    ),
  );
  expect(p.role).toBe("architect");
  expect(p.rejection).toContain("could not rebase");
});

test("a rebase turn that finished is a stall, not a conflict", () => {
  // `conflict` marks a turn that was *told* to rebase (rule 15), not one that
  // failed to. Reading the flag without the outcome turned every clean rebase into
  // a design escalation as soon as the queue went quiet: pm-ai-agent was handed the
  // same false "could not rebase" eight times and its Architect refuted all eight.
  const h = harness();
  h.db.run(
    `INSERT INTO job (kind, grp_id, payload_json, state, enqueued_at)
     VALUES ('agent_turn', 1, '{"role":"engineer","conflict":true}', 'done', 0)`,
  );
  return runWatchdog(h.deps).then(() => {
    const queued = h.db
      .query<{ payload_json: string }, []>("SELECT payload_json FROM job WHERE state = 'pending'")
      .all()
      .map((q) => AgentTurnPayloadSchema.parse(JSON.parse(q.payload_json)));
    // The one-shot resume below, which is what an emptied queue always deserved —
    // and not a word to the Architect about a rebase that never failed.
    expect(queued.map((p) => p.role)).toEqual(["engineer"]);
    expect(queued[0]!.rejection).toBeUndefined();
  });
});

test("main moving under a running group sends it to rebase, once per commit", async () => {
  // landGroup tells the merge queue to rebase when another group lands. It does not
  // cover the boss pushing to main directly — and the boss is a person with a
  // terminal. Six groups spent a day on a base fifteen commits stale and would each
  // have found out at PR time, one conflict apiece.
  const h = harness();
  h.db.run("UPDATE grp SET sandbox_id = 'sb-1' WHERE id = 1");
  // GitHub answers with the base branch's sha; the group's own clone says it is
  // not an ancestor. There is no host checkout to ask since 007 step 6.
  h.ctx.gh = gh(() => ({ commit: { sha: "abc1234567" } }));
  const deps = h.deps;

  const f = await runWatchdog(deps);
  expect(f.map((x) => x.rule)).toContain("base_moved");
  const p = AgentTurnPayloadSchema.parse(
    JSON.parse(
      h.db.query<{ payload_json: string }, []>("SELECT payload_json FROM job ORDER BY id DESC LIMIT 1").get()!
        .payload_json,
    ),
  );
  expect(p.role).toBe("engineer");
  expect(p.rejection).toContain("rebase");
  // Told once per base — otherwise the same nudge fires every tick until the
  // rebase finishes, which is how an agent learns to skip the message.
  expect((await runWatchdog(deps)).map((x) => x.rule)).not.toContain("base_moved");
});

test("work that is finished but has no PR is sent back through the branch review", async () => {
  // The branch review is enqueued from the last acceptance and from writing a
  // retro, and neither fires again after the Auditor sends the branch back. So a
  // group with every slice accepted had nobody left to hand it to: no PR, no
  // error, and an Engineer still being woken by rebase nudges so it looked busy.
  const h = harness();
  h.db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at) VALUES (1, 1, 's', 'a', 'accepted', 0)",
  );
  await runWatchdog(h.deps);
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'reconcile'").get()!.c).toBe(1);

  // A question still travelling the chain is not a reason to leave it unshipped:
  // one group carried three stale advisories, two of them clearance denials nobody
  // was ever going to answer.
  h.db.run("DELETE FROM job");
  h.db.run(
    "INSERT INTO escalation (grp_id, severity, question, chain_state, created_at) VALUES (1, 'advisory', 'q', 'architect', 0)",
  );
  await runWatchdog(h.deps);
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'reconcile'").get()!.c).toBe(1);

  // The boss being asked IS: pr_retries is spent, and shipping anyway walks past
  // the person who was asked.
  h.db.run("DELETE FROM job");
  h.db.run("UPDATE escalation SET chain_state = 'boss' WHERE grp_id = 1");
  await runWatchdog(h.deps);
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'reconcile'").get()!.c).toBe(0);
});

test("a finished PR that never joined the queue gets in line", async () => {
  // `waiting_merge` reads merge_seq_at, so a PR_OPEN group with a null one is
  // invisible to it — no nudge, no place in the order, nothing else looking. The
  // same shape as a PAUSED group with no paused_at.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'PR_OPEN', pr_number = 5, merge_seq = NULL WHERE id = 1");
  await runWatchdog(h.deps);
  expect(h.db.query<{ m: number }, []>("SELECT merge_seq AS m FROM grp WHERE id = 1").get()!.m).toBe(1);
});

test("a pending slice under an idle group is started rather than waited on", async () => {
  // startNextSlice is only ever called at the end of something else — a group
  // starting, autoAdvance, an acceptance. A slice left pending when none of those
  // fires again has nobody to start it, and RUNNING with an empty queue looks
  // exactly like working.
  const h = harness();
  h.db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at) VALUES (1, 1, 's', 'a', 'pending', 0)",
  );
  await runWatchdog(h.deps);
  expect(h.db.query<{ s: string }, []>("SELECT status AS s FROM slice WHERE grp_id = 1").get()!.s).toBe("running");
  // The harness scheduler dispatches inline, so by now the turn is done and rule 8
  // has put another one back. What matters is that one exists at all.
  expect(
    h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'agent_turn'").get()!.c,
  ).toBeGreaterThan(0);
});

test("a stale PR branch is told to rebase too, with the measured remote base in its instructions", async () => {
  // PR_OPEN used to be excluded, so the one branch that has to merge only learned
  // main had moved when GitHub called it CONFLICTING — the late half of the same
  // news. And the base was read from the local checkout's HEAD, so a push from
  // another machine was invisible however often this ran.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'PR_OPEN', sandbox_id = 'sb-1' WHERE id = 1");
  // The base branch is a column now, written from GitHub's `default_branch` at
  // registration — never detected with host git, which has no checkout to ask.
  h.db.run("UPDATE project SET repo_path = 'acme/p-pr', base_branch = 'master' WHERE id = 1");
  const asked: string[] = [];
  h.ctx.gh = gh((path) => {
    asked.push(path);
    return { commit: { sha: "abc1234567" } };
  });
  const deps = h.deps;

  expect((await runWatchdog(deps)).map((x) => x.rule)).toContain("base_moved");
  // The branch it asks about is the project's base, named, not whatever some
  // checkout happens to be standing on.
  expect(asked).toContain("/repos/acme/p-pr/branches/master");
  const job = h.db
    .query<{ payload_json: string }, []>("SELECT payload_json FROM job WHERE kind = 'agent_turn' AND state = 'pending'")
    .get()!;
  const payload = AgentTurnPayloadSchema.parse(JSON.parse(job.payload_json));
  expect(payload.rejection).toContain("origin/master moved to abc12345");
  expect(payload.rejection).toContain("git fetch origin master");
  expect(payload.rejection).toContain("git rebase origin/master");
});

test("a group already on the base is not nudged", async () => {
  // The sha comparison is the whole rule: a group that has rebased must not be
  // told again, or an agent learns to skip the message. The old version of this
  // test protected against comparing with a *local* checkout's HEAD, which no
  // longer exists to be compared with.
  const h = harness();
  h.db.run("UPDATE grp SET sandbox_id = 'sb-1' WHERE id = 1");
  h.ctx.gh = gh(() => ({ commit: { sha: "def4560000000000000000000000000000000000" } }));
  const deps = h.deps;
  // `merge-base --is-ancestor` succeeds in the group's own clone: already on it.
  h.ctx.sandbox = fakeSandbox(() => ({ code: 0 }));

  const f = await runWatchdog(deps);
  expect(f.map((x) => x.rule)).not.toContain("base_moved");
  const jobs = h.db.query<{ payload_json: string }, []>("SELECT payload_json FROM job WHERE kind = 'agent_turn'").all();
  expect(jobs.map((j) => AgentTurnPayloadSchema.parse(JSON.parse(j.payload_json)).role)).not.toContain("engineer");
});

test("turn logs are compressed after a day and dropped after two weeks", () => {
  // Ten requirements produced 123 MB of raw NDJSON — median 324 KB a turn, 3 MB at
  // the tail — because a transcript is mostly tool output written verbatim. Worth
  // keeping (every measurement in PROGRESS came out of these), not worth keeping
  // uncompressed.
  const dir = mkdtempSync(join(tmpdir(), "orch-logs-"));
  const now = 10 * DROP_AFTER_MS;
  writeFileSync(join(dir, "1.jsonl"), "x".repeat(5000));
  writeFileSync(join(dir, "2.jsonl"), "y".repeat(5000));
  writeFileSync(join(dir, "3.jsonl.gz"), "old");
  utimesSync(join(dir, "1.jsonl"), 0, (now - GZIP_AFTER_MS * 2) / 1000);
  utimesSync(join(dir, "3.jsonl.gz"), 0, (now - DROP_AFTER_MS * 2) / 1000);

  const r = sweepTurnLogs(dir, now);
  expect(r).toEqual({ zipped: 1, dropped: 1 });
  expect(existsSync(join(dir, "1.jsonl.gz"))).toBe(true);
  expect(existsSync(join(dir, "1.jsonl"))).toBe(false);
  // Today's turn is left alone: it is still being written to.
  expect(existsSync(join(dir, "2.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "3.jsonl.gz"))).toBe(false);
});

test("a burst of pushes costs one rebase turn, and never delays one", async () => {
  const h = harness();
  h.db.run("UPDATE grp SET sandbox_id = 'sb-1' WHERE id = 1");
  h.db.run("UPDATE project SET repo_path = 'acme/p-burst' WHERE id = 1");
  let sha = "aaaa111111";
  h.ctx.gh = gh(() => ({ commit: { sha } }));
  const deps = h.deps;

  // Count the turns, not the findings: a finding is suppressed as a re-emit for
  // half an hour, and what is being asserted here is what the group was made to do.
  const turns = () =>
    h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE payload_json LIKE '%conflict%'").get()!.c;

  await runWatchdog(deps);
  expect(turns()).toBe(1);

  // Pushed again while the first nudge is still queued: same turn, not a second.
  sha = "bbbb222222";
  await runWatchdog(deps);
  expect(turns()).toBe(1);

  // It ran. A base that moved again is acted on immediately — there is no clock to
  // wait out, because a group whose PR is blocked on a rebase must not sit on it.
  h.db.run("UPDATE job SET state = 'done' WHERE state = 'pending'");
  sha = "cccc333333";
  await runWatchdog(deps);
  expect(turns()).toBe(2);
});

test("a question the work went past is closed rather than left in 待办", async () => {
  // review.ts files a blocker when a slice fails QA three times and pauses the
  // group. Nothing closed it if the group recovered: live, src-mech-watchdog-ts
  // had a merge-ready PR and an open blocker on the same requirement, in the same
  // list, asking the boss to unblock a group that was finished.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'PR_OPEN' WHERE id = 1");
  h.db.run(
    `INSERT INTO escalation (grp_id, severity, question, chain_state, created_at)
     VALUES (1, 'blocker', 'S1 failed qa 3 times', 'boss', 0)`,
  );
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("stale_ask");
  expect(h.db.query<{ chain_state: string }, []>("SELECT chain_state FROM escalation").get()!.chain_state).toBe(
    "revoked",
  );
});

test("a question on a group that is still working is left alone", async () => {
  const h = harness();
  h.db.run(
    `INSERT INTO escalation (grp_id, severity, question, chain_state, created_at)
     VALUES (1, 'blocker', 'which library?', 'boss', 0)`,
  );
  await runWatchdog(h.deps);
  expect(h.db.query<{ chain_state: string }, []>("SELECT chain_state FROM escalation").get()!.chain_state).toBe("boss");
});

test("a dissolved group's sandbox is killed, so it stops holding two containers", async () => {
  const h = harness();
  // Nothing removed one, ever, in the worktree era: twelve dead checkouts sat on
  // disk holding their branches. A sandbox is worse — two containers and their
  // memory, until a TTL a day out.
  h.db.run("UPDATE grp SET status = 'DISSOLVED', sandbox_id = 'sb-1', branch = 'orch/g1', pr_number = 7 WHERE id = 1");

  const killed: string[] = [];
  h.ctx.sandbox = {
    ...h.ctx.sandbox!,
    kill: async (_c, scope) => {
      killed.push(JSON.stringify(scope));
    },
  };

  const findings = await runWatchdog(h.deps);
  expect(findings.map((x) => x.rule)).toContain("sandbox_swept");
  expect(killed).toEqual(['{"grp":1}']);
});

test("losing the network holds the fleet without pausing a single requirement", async () => {
  const h = harness();
  h.db.run(
    "INSERT INTO job (kind, grp_id, agent_id, payload_json, state, started_at, enqueued_at) " +
      "VALUES ('agent_turn', 1, 1, '{\"role\":\"engineer\"}', 'running', 0, 0)",
  );
  h.db.run("UPDATE agent SET state = 'running' WHERE id = 1");

  const f = await runWatchdog({ ...h.deps, probe: async () => ({ online: false, changed: true }) });
  expect(f.map((x) => x.rule)).toContain("network_lost");

  // The work goes back on the queue and the requirement stays RUNNING. Pausing it
  // is what would need a human afterwards: nothing takes a group out of PAUSED,
  // and the park timer would file it away while the network was down.
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("RUNNING");
  expect(
    h.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM job WHERE state = 'pending' AND kind = 'agent_turn'")
      .get()!.n,
  ).toBe(1);
  expect(h.db.query<{ state: string }, []>("SELECT state FROM agent WHERE id = 1").get()!.state).toBe("idle");
});

test("an offline tick does not run the rules that need the network", async () => {
  // Every rule below the gate is a restatement of state we recorded ourselves, and
  // none is worth a two-second DNS timeout each. This one would otherwise fire.
  const h = harness({ turnTimeoutMs: 1000 });
  h.db.run("INSERT INTO job (kind, grp_id, state, started_at, enqueued_at) VALUES ('agent_turn', 1, 'running', 0, 0)");
  const f = await runWatchdog({ ...h.deps, probe: async () => ({ online: false, changed: false }) });
  expect(f.map((x) => x.rule)).not.toContain("turn_timeout");
});

test("one rule throwing costs that rule, not the twenty-four after it", async () => {
  // The tick is straight-line async: before this, a throw anywhere skipped every
  // rule below it, and `invariants.ts` names the watchdog as the `driver` for
  // about twelve states — so one bad rule meant twelve drivers silent for thirty
  // seconds, and the report said only "the watchdog broke".
  const h = harness();
  // Rule 7d3 reads subscription usage. It is injected, so it is the one rule a
  // test can make throw without pretending anything else is broken.
  const deps = {
    ...h.deps,
    pollUsage: async () => {
      throw new Error("usage endpoint exploded");
    },
  };
  // Rule 8's condition, which is checked *after* 7d3: a RUNNING group whose last
  // turn failed twice and has nothing queued.
  h.db.run(
    `INSERT INTO job (kind, grp_id, payload_json, state, error, enqueued_at)
     VALUES ('agent_turn', 1, '{"role":"engineer"}', 'failed', 'boom', 0)`,
  );
  const first = await runWatchdog(deps);
  // The rule that threw names itself, so the finding is actionable — "rule 7d3
  // broke" rather than "the watchdog broke".
  expect(first.map((x) => x.rule)).toContain("rule_broke:7d3");
  expect(first.find((x) => x.rule === "rule_broke:7d3")!.body).toContain("usage endpoint exploded");

  // The next tick, with 7d3 still throwing: the rules after it ran anyway, and
  // the breakage is not reported a second time — once per REEMIT_MS, or a rule
  // that throws every 30 seconds is 120 blocker lines an hour.
  h.db.run("UPDATE job SET state = 'failed', error = 'boom' WHERE state = 'pending'");
  const second = await runWatchdog(deps);
  expect(second.map((x) => x.rule)).toContain("stalled");
  expect(second.map((x) => x.rule)).not.toContain("rule_broke:7d3");
});

test("delivery is a bus frame the page can raise, plus an optional webhook", async () => {
  const db = openMemory();
  const bus = new Bus(db);
  const posted: Array<{ url: string; body: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      const body = init?.body;
      posted.push({
        url,
        body: body === undefined || body === null ? "" : typeof body === "string" ? body : (JSON.stringify(body) ?? ""),
      });
      return new Response("ok");
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    const n = new Notifier({ deliver: busDeliver(bus, "https://example.invalid/hook") });
    await n.push({
      key: "escalation:1",
      tier: "immediate",
      body: "谁来定一下基线分支",
      url: "http://127.0.0.1:47821/#g=3&v=progress",
    });

    // One frame, its own kind. The page raises a system notification for this and
    // for nothing else — "everything the boss might want" is what turns a
    // notification into noise, and the rules upstream exist to avoid exactly that.
    const [f] = db
      .query<{ kind: string; body: string; meta_json: string }, []>(
        "SELECT kind, body, meta_json FROM event WHERE kind = 'notify'",
      )
      .all();
    expect(f?.body).toBe("谁来定一下基线分支");
    expect(NotifyMeta.parse(JSON.parse(f!.meta_json)).url).toContain("#g=3");

    expect(posted).toHaveLength(1);
    expect(WebhookBody.parse(JSON.parse(posted[0]!.body)).message).toBe("谁来定一下基线分支");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a webhook that is down does not take the run with it", async () => {
  const db = openMemory();
  const bus = new Bus(db);
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    { preconnect: realFetch.preconnect },
  );
  try {
    const n = new Notifier({ deliver: busDeliver(bus, "https://example.invalid/hook") });
    // The frame is written before the POST is attempted, so the panel is told
    // even when the thing on the other end is not there.
    expect(await n.push({ key: "k", tier: "immediate", body: "x" })).toBe(true);
    expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM event WHERE kind = 'notify'").get()!.c).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
