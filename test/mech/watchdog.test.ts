import { describe, expect, test } from "bun:test";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { StoredSpanExporter } from "../../src/platform/observability/span-store.ts";
import { installTracerProvider } from "../../src/platform/observability/traces.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { renderSaid, said } from "../../src/platform/text/lang.ts";
import { publishWatchdogFinding } from "../../src/application/executor.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { openMemory, readSetting, type DB } from "../../src/platform/persistence/database.ts";
import { busDeliver, Notifier, notifiable, tierFor, batchForBoss } from "../../src/mech/ops/notify.ts";
import { pause, resume, settlePausing, park } from "../../src/mech/flow/intercept.ts";
import {
  DROP_AFTER_MS,
  GZIP_AFTER_MS,
  recordTurnOutcome,
  runWatchdog,
  sweepTurnLogs,
} from "../../src/mech/ops/watchdog.ts";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentTurnPayloadSchema, Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { and, count, desc, eq, like, sql } from "drizzle-orm";
import {
  agent as agentTable,
  escalation as escalationTable,
  event as eventTable,
  grp as grpTable,
  job as jobTable,
  project as projectTable,
  runtime_auth as runtimeAuthTable,
  slice as sliceTable,
  span as spanTable,
} from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import type { Json } from "../../src/contracts/json.ts";
import { z } from "zod";
import { tempDir } from "../support/temp.ts";

/** The shipped thresholds. The subject is the rule, not the number it is tuned to. */
const LIMITS = loadConfig().watchdog;

/** The one column most rules here move. */
const grpStatus = async (db: DB, id = 1): Promise<string> =>
  (await db.select({ status: grpTable.status }).from(grpTable).where(eq(grpTable.id, id)))[0]!.status;

/**
 * The queued turns, oldest first.
 *
 * `ORDER BY id` is stated rather than inherited: sqlite handed these back in
 * rowid order and every assertion below was written against that, which
 * Postgres does not promise for an unordered select.
 */
const pending = async (db: DB) =>
  (
    await db
      .select({ p: jobTable.payload_json })
      .from(jobTable)
      .where(eq(jobTable.state, "pending"))
      .orderBy(jobTable.id)
  ).map((r) => r.p);

const NotifyMeta = z.object({ url: z.string() });
const WebhookBody = z.object({ message: z.string() });

/** A GitHub client that answers from a function and records the paths asked. */
const gh = (answer: (path: string) => Json) =>
  ({
    remaining: () => null,
    request: async (_method, path, schema) => ({ ok: true as const, status: 200, data: schema.parse(answer(path)) }),
  }) satisfies NonNullable<Ctx["gh"]>;

/**
 * One project, one running group, one agent — the shape every rule below reads.
 *
 * This used to be a serialised sqlite image restored per test. Postgres has no
 * equivalent, and it needs none: `openMemory()` truncates and restarts identity,
 * so the four inserts are the fixture and the ids are 1 again either way.
 */
async function watchdogDb(): Promise<DB> {
  const db = await openMemory();
  const f = fx.on(db);
  await seedAuth(db);
  const p = await f.project.create({ name: "p" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  await f.agent.create({ project_id: p.id, grp_id: g.id, token: "t" });
  return db;
}

/**
 * The repo-map check runs on its own interval, so a test about the *gate* has to
 * turn the interval off or it measures the cadence instead.
 */
const EVERY_MAP_TICK = {
  watchdog: { ...loadConfig().watchdog, repoMapEveryMs: 0 },
} satisfies Partial<ReturnType<typeof loadConfig>>;

async function harness(over: Partial<ReturnType<typeof loadConfig>> = {}) {
  const db = await watchdogDb();
  const sched = new Scheduler(db, async () => {});
  const cfg = { ...loadConfig(), ...over };
  // The bus renders the `body` column from the key an emitter names, so it needs
  // the same `output.language` the rest of this context has.
  const bus = new Bus(db, () => cfg.language);
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
    // `ps -Ao` on every tick, and nothing in this file asserts on the server
    // rules — so the probe is stubbed rather than run forty-eight times.
    runningServer: () => null,
  };
  return { db, ctx, sched, cfg, deps };
}

test("a turn past its wall clock is killed and reported", async () => {
  const h = await harness({ turnTimeoutMs: 1000 });
  await fx.on(h.db).job.create({ grp_id: 1, state: "running", started_at: 0 });
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("turn_timeout");
  expect((await h.db.select({ state: jobTable.state }).from(jobTable))[0]!.state).toBe("cancelled");
});

test("a RUNNING group whose last turn failed is put back once, then handed to the boss", async () => {
  // Failure is terminal, so the chain just ends: RUNNING group, empty queue, no
  // error anywhere the boss looks. Six groups sat like this behind one bad path.
  const h = await harness();
  await fx.on(h.db).job.create({
    grp_id: 1,
    payload_json: { role: "engineer" },
    state: "failed",
    error: "Settings file not found",
  });
  expect((await runWatchdog(h.deps)).map((x) => x.rule)).not.toContain("stalled");
  const back = await pending(h.db);
  expect(back).toHaveLength(1);
  expect(AgentTurnPayloadSchema.parse(back[0]).role).toBe("engineer");

  // It failed again. A third try is not going to work either — say so instead.
  await h.db.update(jobTable).set({ state: "failed", error: "same thing" }).where(eq(jobTable.state, "pending"));
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("stalled");
  expect(f.find((x) => x.rule === "stalled")!.say.values?.why).toContain("same thing");
  expect(await pending(h.db)).toHaveLength(0);
});

test("a turn that ended cleanly without arranging the next one also counts as stalled", async () => {
  // The exit code is not the signal. A Dispatcher that finished without filing a
  // card leaves PLANNING with an empty queue, and that reads identically to
  // success from every view the boss has.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "PLANNING" }).where(eq(grpTable.id, 1));
  await fx.on(h.db).job.create({ grp_id: 1, payload_json: { role: "dispatcher" }, state: "done" });
  await runWatchdog(h.deps);
  const [back] = await pending(h.db);
  expect(AgentTurnPayloadSchema.parse(back).role).toBe("dispatcher");
});

test("a PM turn that dies answering a review is picked up, not left in PR_OPEN", async () => {
  // PR feedback used to move the group to RUNNING, where this rule covered it. It
  // stays in PR_OPEN now, so the rule has to cover every state a turn dispatches
  // from — otherwise a turn that fails while answering a reviewer leaves the group
  // holding the head of the merge queue with an empty queue and nobody looking.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "PR_OPEN", pr_number: 7, merge_seq: 1 }).where(eq(grpTable.id, 1));
  await fx.on(h.db).job.create({
    grp_id: 1,
    payload_json: { role: "pm" },
    state: "failed",
    error: "the model was unreachable",
  });

  await runWatchdog(h.deps);
  const [back] = await pending(h.db);
  expect(AgentTurnPayloadSchema.parse(back).role).toBe("pm");
});

test("work queued for a dissolved group is cancelled, not left pending forever", async () => {
  // Drop and split both cancel what was pending, but a mail landing a moment later
  // enqueues another, and no status a dissolved group has is dispatchable.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "DISSOLVED" }).where(eq(grpTable.id, 1));
  await fx.on(h.db).job.create({ grp_id: 1, state: "pending" });
  await runWatchdog(h.deps);
  expect((await h.db.select({ state: jobTable.state }).from(jobTable))[0]!.state).toBe("cancelled");
});

test("turns that write nothing accumulate, and productive ones reset", async () => {
  const h = await harness();
  for (let i = 0; i < LIMITS.idleTurns; i++) await recordTurnOutcome(h.ctx, 1, [], false, false);
  let f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("no_progress");

  await recordTurnOutcome(h.ctx, 1, ["a.ts"], false, false);
  f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).not.toContain("no_progress");
});

test("a note or a moved task counts as progress even with no file change", async () => {
  const h = await harness();
  await recordTurnOutcome(h.ctx, 1, [], true, false);
  await recordTurnOutcome(h.ctx, 1, [], false, true);
  await recordTurnOutcome(h.ctx, 1, [], false, false);
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).not.toContain("no_progress");
});

test("rewriting one file every turn is caught and sent to the Architect", async () => {
  const h = await harness();
  for (let i = 0; i < LIMITS.sameFile; i++) await recordTurnOutcome(h.ctx, 1, ["auth/mw.ts"], false, false);
  const f = await runWatchdog(h.deps);
  const circling = f.find((x) => x.rule === "circling")!;
  expect(circling).toBeDefined();
  // The message names the likely cause: telling the writer to try harder does
  // not fix a design problem.
  expect(renderSaid("en", circling.say)).toContain("Architect");
});

test("touching several files does not look like circling", async () => {
  const h = await harness();
  for (let i = 0; i < LIMITS.sameFile + 2; i++) await recordTurnOutcome(h.ctx, 1, ["a.ts", "b.ts"], false, false);
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).not.toContain("circling");
});

test("the same lease failing twice on unchanged code blames the environment", async () => {
  const h = await harness();
  await fx.on(h.db).resource.create({ name: "build" });
  const failedAt = (head_sha: string) =>
    fx.on(h.db).lease.create({ resource: "build", grp_id: 1, state: "failed", head_sha });
  await failedAt("sha-a");
  await failedAt("sha-a");
  const f = await runWatchdog(h.deps);
  const env = f.find((x) => x.rule === "env_suspect")!;
  expect(env).toBeDefined();
  // The body follows output.language (中文 here); the resource name is a technical
  // term and stays verbatim in both.
  expect(env.say.values?.resource).toBe("build");
  expect(renderSaid(h.ctx.config.language, env.say)).toContain("环境");
});

test("two failures at different commits are just two failures", async () => {
  const h = await harness();
  await fx.on(h.db).resource.create({ name: "build" });
  const failedAt = (head_sha: string) =>
    fx.on(h.db).lease.create({ resource: "build", grp_id: 1, state: "failed", head_sha });
  await failedAt("sha-a");
  await failedAt("sha-b");
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).not.toContain("env_suspect");
});

test("budget warns at 80% and suspends the group at 100%", async () => {
  const h = await harness();
  await h.db.update(grpTable).set({ budget_tokens: 1000, spent_tokens: 850 }).where(eq(grpTable.id, 1));
  let f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("budget_80");
  expect(await grpStatus(h.db)).toBe("RUNNING");

  await h.db.update(grpTable).set({ spent_tokens: 1000 }).where(eq(grpTable.id, 1));
  f = await runWatchdog(h.deps);
  expect(f.find((x) => x.rule === "budget_exhausted")!.severity).toBe("blocker");
  expect(await grpStatus(h.db)).toBe("PAUSED");
});

test("a long wait notifies first, then parks and frees the slot", async () => {
  const h = await harness({ parkAfterPausedMs: 60_000 });
  await h.db
    .update(grpTable)
    .set({ status: "PAUSED", paused_at: 1_000_000 - 20 * 60_000 })
    .where(eq(grpTable.id, 1));
  let f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("parked");
  expect(await grpStatus(h.db)).toBe("PARKED");

  const h2 = await harness({ parkAfterPausedMs: 2 * 3600_000 });
  await h2.db
    .update(grpTable)
    .set({ status: "PAUSED", paused_at: 1_000_000 - 20 * 60_000 })
    .where(eq(grpTable.id, 1));
  f = await runWatchdog(h2.deps);
  expect(f.map((x) => x.rule)).toContain("waiting_on_you");
  expect(await grpStatus(h2.db)).toBe("PAUSED");
});

test("pause reports how many turns it is waiting on, and settles later", async () => {
  const h = await harness();
  await fx.on(h.db).job.create({ grp_id: 1, state: "running" });
  expect(await pause(h.ctx, 1)).toBe(1);
  // PAUSING, not PAUSED: an in-flight turn cannot be steered, and the status
  // should not claim otherwise.
  expect(await grpStatus(h.db)).toBe("PAUSING");

  await h.db.update(jobTable).set({ state: "done" });
  expect(await settlePausing(h.ctx)).toBe(1);
  expect(await grpStatus(h.db)).toBe("PAUSED");
});

test("a group that reaches PAUSED always carries the time it got there", async () => {
  const h = await harness();
  // The ask-boss blocker path writes PAUSING without a timestamp. Every
  // watchdog timer keys off paused_at, so a NULL here froze the group with
  // nobody nudged and nothing parked.
  await h.db.update(grpTable).set({ status: "PAUSING" }).where(eq(grpTable.id, 1));
  await settlePausing(h.ctx);
  expect((await h.db.select({ p: grpTable.paused_at }).from(grpTable))[0]!.p).toBeGreaterThan(0);

  // And an already-broken row is repaired rather than left invisible forever.
  await h.db.update(grpTable).set({ status: "PAUSED", paused_at: null }).where(eq(grpTable.id, 1));
  await runWatchdog(h.deps);
  expect((await h.db.select({ p: grpTable.paused_at }).from(grpTable))[0]!.p).toBeGreaterThan(0);
});

test("pausing an idle group settles immediately", async () => {
  const h = await harness();
  expect(await pause(h.ctx, 1)).toBe(0);
  expect(await grpStatus(h.db)).toBe("PAUSED");
  await resume(h.ctx, 1);
  expect(await grpStatus(h.db)).toBe("RUNNING");
});

test("park drops queued turns and retires sessions, keeping the checkout", async () => {
  const h = await harness();
  await h.db.update(grpTable).set({ sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  await h.db.update(agentTable).set({ session_id: "live", session_tokens: 5000 }).where(eq(agentTable.id, 1));
  await h.sched.enqueue("agent_turn", { grp_id: 1 });
  await h.sched.enqueue("agent_turn", { grp_id: 1 });

  await park(h.ctx, 1, "waited for you");

  const cancelled = await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.state, "cancelled"));
  expect(cancelled[0]!.c).toBe(2);
  const [a] = await h.db.select({ session_id: agentTable.session_id }).from(agentTable);
  expect(a!.session_id).toBeNull();
  // Park is resource reclamation, not an approval step: nothing is lost.
  // Parking is not dissolving: the sandbox, and the work in it, stay.
  expect((await h.db.select({ s: grpTable.sandbox_id }).from(grpTable))[0]!.s).toBe("sb-1");
});

// ------------------------------------------------------------------ notifier

/**
 * Only what the boss can act on is worth a notification.
 *
 * "main 动到了 549e8bc，已经让它先 rebase" arrived under a heading saying "5
 * things need you"; it needed nobody. Two of those and the heading stops meaning
 * anything, so a failure has to name the rule that leaked.
 */
describe("only what the boss can act on is worth a notification", () => {
  test.each([
    ["base_moved", "advisory", false],
    ["repeat_failure", "advisory", false],
    ["env_suspect", "advisory", false],
    ["unshipped", "advisory", false],
    ["parked", "advisory", false],
    // The boss's own queue, and money running out.
    ["waiting_slice", "advisory", true],
    ["waiting_merge", "advisory", true],
    ["budget_exhausted", "advisory", true],
    // Severity still wins: anything that stopped a group reaches them.
    ["stalled", "blocker", true],
  ] as const)("%s at %s notifies: %p", (rule, severity, notifies) => {
    expect(notifiable(rule, severity)).toBe(notifies);
  });
});

test("blockers interrupt immediately; ordinary findings are batched", async () => {
  expect(tierFor("budget_80")).toBe("batched");
  expect(tierFor("anything", "blocker")).toBe("immediate");
  expect(tierFor("waiting_on_you")).toBe("immediate");
});

test("a repeat of the same problem backs off instead of nagging every tick", async () => {
  let t = 0;
  const sent: string[] = [];
  const n = new Notifier({ now: () => t, deliver: (_title, body) => void sent.push(body) });

  // Collected rather than asserted one at a time: the fact under test is the
  // shape of the whole sequence, which five separate booleans could not name.
  const answered: boolean[] = [];
  const push = async () => answered.push(await n.push({ key: "esc:1", tier: "immediate", body: "answer me" }));

  await push();
  t += 60_000;
  await push();
  t += 5 * 60_000;
  await push();
  // Second reminder waits 15 min, not another 5.
  t += 6 * 60_000;
  await push();
  t += 10 * 60_000;
  await push();

  expect(answered).toEqual([true, false, true, false, true]);
  expect(sent.length).toBe(3);
});

test("a different problem is not suppressed by an unrelated one", async () => {
  const n = new Notifier({ now: () => 0, deliver: () => {} });
  const first = await n.push({ key: "a", tier: "immediate", body: "x" });
  expect([first, await n.push({ key: "b", tier: "immediate", body: "y" })]).toEqual([true, true]);
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

test("several things waiting on the boss become one message", async () => {
  const n = batchForBoss([
    { id: 1, severity: "advisory", question: "which library?", group: "auth" },
    { id: 2, severity: "advisory", question: "rename the flag?", group: "ui" },
  ])!;
  expect(n.body).toContain("2 waiting on you");
  expect(n.body).toContain("• auth:");
  expect(n.body).toContain("• ui:");
  expect(n.tier).toBe("batched");
});

test("one blocker in the set makes the whole batch immediate", async () => {
  const n = batchForBoss([
    { id: 1, severity: "advisory", question: "a", group: "x" },
    { id: 2, severity: "blocker", question: "b", group: "y" },
  ])!;
  expect(n.tier).toBe("immediate");
  expect(n.body).toContain("1 blocking");
});

test("the batch key is the set, so a new arrival is news and a repeat is not", async () => {
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

test("a single item is not dressed up as a batch, and nothing waiting sends nothing", async () => {
  expect(batchForBoss([])).toBeNull();
  const one = batchForBoss([{ id: 7, severity: "blocker", question: "which lib?", group: "auth" }])!;
  expect(one.key).toBe("escalation:7");
  expect(one.body).toContain("auth: which lib?");
});

test("a batched notification carries a link, and one item links to its requirement", async () => {
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
  const h = await harness();
  // docs/project/plan.md §11: on the cheapest tier there is nothing to downgrade to, so it waits —
  // and waiting is only useful if something watches the clock. Before this, one 429 at
  // 01:00 held the group until the boss woke up, which is the failure the whole system
  // exists to prevent.
  await h.db
    .update(grpTable)
    .set({ status: "PAUSED", paused_at: 1_000_000 - 60_000, rl_resets_at: 1_000_000 - 1_000 })
    .where(eq(grpTable.id, 1));
  const found = await runWatchdog(h.deps);
  expect(found.some((f) => f.rule === "rate_limit_resumed")).toBe(true);
  const [g] = await h.db
    .select({ status: grpTable.status, rl: grpTable.rl_resets_at })
    .from(grpTable)
    .where(eq(grpTable.id, 1));
  expect(g!.status).toBe("RUNNING");
  expect(g!.rl).toBe(null);
});

test("a group waiting on quota is not parked out from under itself", async () => {
  const h = await harness();
  // parkAfterPausedMs has passed, but the reset has not. Parking here retires the
  // sessions minutes before it could have resumed on its own.
  await h.db
    .update(grpTable)
    .set({
      status: "PAUSED",
      paused_at: 1_000_000 - h.cfg.parkAfterPausedMs - 1000,
      rl_resets_at: 1_000_000 + 600_000,
    })
    .where(eq(grpTable.id, 1));
  const found = await runWatchdog(h.deps);
  expect(found.filter((f) => f.rule === "parked")).toEqual([]);
  expect(await grpStatus(h.db)).toBe("PAUSED");
});

test("the group it was waiting on landed, so it starts again by itself", async () => {
  // `orch blocked` hands a defect outside a group's boundary to whoever can fix it
  // and stops the caller. Nothing else in the system knows that one group's merge
  // is another group's green light.
  const h = await harness();
  await fx.on(h.db).runningGrp.create({ project_id: 1, name: "fixer" });
  await h.db.update(grpTable).set({ status: "PAUSED", paused_at: 0, blocked_on: 2 }).where(eq(grpTable.id, 1));

  // Still running: nothing to wake up for, and parking must not touch it either —
  // it is waiting on another group, not on the boss.
  await runWatchdog(h.deps);
  expect(await grpStatus(h.db)).toBe("PAUSED");

  await h.db.update(grpTable).set({ status: "DISSOLVED" }).where(eq(grpTable.id, 2));
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("unblocked");
  const [g] = await h.db
    .select({ status: grpTable.status, blocked_on: grpTable.blocked_on })
    .from(grpTable)
    .where(eq(grpTable.id, 1));
  expect(g!.status).toBe("RUNNING");
  expect(g!.blocked_on).toBeNull();
});

test("a question stranded on a stopped group is lifted to the boss", async () => {
  // route() handles this at routing time, but a group can stop *after* a question
  // was handed to its PM — and every one filed before that fix is still sitting
  // where it was. Symptom: a stopped group and a 待办 count of zero.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "PAUSED", paused_at: 999_999 }).where(eq(grpTable.id, 1));
  await fx.on(h.db).escalation.create({ grp_id: 1, severity: "blocker", question: "S1 failed the gate 3 times" });
  await runWatchdog(h.deps);
  expect((await h.db.select({ s: escalationTable.chain_state }).from(escalationTable))[0]!.s).toBe("boss");
});

test("a parked group whose question got answered comes back", async () => {
  // answer() un-pauses PAUSED groups and silently skips PARKED ones, so a group
  // that waited long enough to be parked stayed parked even after the boss answered
  // the very thing it was waiting for.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "PARKED", paused_at: 100 }).where(eq(grpTable.id, 1));
  await fx.on(h.db).escalation.create({
    grp_id: 1,
    severity: "blocker",
    question: "which library?",
    answer: "the stdlib one",
    answered_by: "boss",
    chain_state: "answered",
    answered_at: 500,
  });
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("unparked");
  expect(await grpStatus(h.db)).not.toBe("PARKED");
});

test("parking is not undone on the tick that did it", async () => {
  // Most parked groups never had a blocker at all. "No open blocker" would revive
  // every one of them immediately, including the one just parked for waiting.
  const h = await harness({ parkAfterPausedMs: 60_000 });
  await h.db
    .update(grpTable)
    .set({ status: "PAUSED", paused_at: 1_000_000 - 20 * 60_000 })
    .where(eq(grpTable.id, 1));
  await runWatchdog(h.deps);
  expect(await grpStatus(h.db)).toBe("PARKED");
  await runWatchdog(h.deps);
  expect(await grpStatus(h.db)).toBe("PARKED");
});

test("the three places that wait on the boss each carry a clock", async () => {
  // They are meant to wait. What was missing is that they waited in silence, so
  // "waiting since Tuesday" and "arrived a minute ago" looked exactly alike.
  const h = await harness();
  const old = 1_000_000 - 5 * 3_600_000;
  await h.db.update(grpTable).set({ status: "DRAFT" }).where(eq(grpTable.id, 1));
  await fx.on(h.db).note.create({
    grp_id: 1,
    body: "card",
    // `true`, not `1`: what writes this is `planning.ts`, and every reader is a
    // `@> '{"draft_card": true}'` containment test that a number does not satisfy.
    frontmatter_json: { draft_card: true },
    at: old,
  });
  await fx.on(h.db).slice.create({
    grp_id: 1,
    seq: 1,
    title: "S1",
    accept_spec: "a",
    status: "awaiting_boss",
    awaiting_at: old,
  });
  for (const merge_seq of [1, 2]) {
    await fx.on(h.db).grp.create({
      project_id: 1,
      name: `q${merge_seq}`,
      status: "PR_OPEN",
      merge_seq,
      merge_seq_at: old,
    });
  }

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
  const h = await harness();
  await fx.on(h.db).job.create({
    grp_id: 1,
    payload_json: { role: "engineer", conflict: true },
    state: "failed",
    error: "could not rebase",
  });
  await runWatchdog(h.deps);
  const p = AgentTurnPayloadSchema.parse((await pending(h.db))[0]);
  expect(p.role).toBe("architect");
  expect(p.rejection).toContain("could not rebase");
});

test("a rebase turn that finished is a stall, not a conflict", async () => {
  // `conflict` marks a turn that was *told* to rebase (rule 15), not one that
  // failed to. Reading the flag without the outcome turned every clean rebase into
  // a design escalation as soon as the queue went quiet: pm-ai-agent was handed the
  // same false "could not rebase" eight times and its Architect refuted all eight.
  const h = await harness();
  await fx.on(h.db).job.create({ grp_id: 1, payload_json: { role: "engineer", conflict: true }, state: "done" });
  return runWatchdog(h.deps).then(async () => {
    const queued = (await pending(h.db)).map((q) => AgentTurnPayloadSchema.parse(q));
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
  const h = await harness();
  await h.db.update(grpTable).set({ sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  // GitHub answers with the base branch's sha; the group's own clone says it is
  // not an ancestor. There is no host checkout to ask since 007 step 6.
  h.ctx.gh = gh(() => ({ commit: { sha: "abc1234567" } }));
  const deps = h.deps;

  const f = await runWatchdog(deps);
  expect(f.map((x) => x.rule)).toContain("base_moved");
  const [newest] = await h.db.select({ p: jobTable.payload_json }).from(jobTable).orderBy(desc(jobTable.id)).limit(1);
  const p = AgentTurnPayloadSchema.parse(newest!.p);
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
  const h = await harness();
  await fx.on(h.db).acceptedSlice.create({ grp_id: 1, seq: 1, title: "s", accept_spec: "a" });
  await runWatchdog(h.deps);
  expect((await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "reconcile")))[0]!.c).toBe(1);

  // A question still travelling the chain is not a reason to leave it unshipped:
  // one group carried three stale advisories, two of them clearance denials nobody
  // was ever going to answer.
  await h.db.delete(jobTable);
  await fx.on(h.db).escalation.create({ grp_id: 1, chain_state: "architect" });
  await runWatchdog(h.deps);
  expect((await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "reconcile")))[0]!.c).toBe(1);

  // The boss being asked IS: pr_retries is spent, and shipping anyway walks past
  // the person who was asked.
  await h.db.delete(jobTable);
  await h.db.update(escalationTable).set({ chain_state: "boss" }).where(eq(escalationTable.grp_id, 1));
  await runWatchdog(h.deps);
  expect((await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "reconcile")))[0]!.c).toBe(0);
});

test("a finished PR that never joined the queue gets in line", async () => {
  // `waiting_merge` reads merge_seq_at, so a PR_OPEN group with a null one is
  // invisible to it — no nudge, no place in the order, nothing else looking. The
  // same shape as a PAUSED group with no paused_at.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "PR_OPEN", pr_number: 5, merge_seq: null }).where(eq(grpTable.id, 1));
  await runWatchdog(h.deps);
  expect((await h.db.select({ m: grpTable.merge_seq }).from(grpTable).where(eq(grpTable.id, 1)))[0]!.m).toBe(1);
});

test("a pending slice under an idle group is started rather than waited on", async () => {
  // startNextSlice is only ever called at the end of something else — a group
  // starting, autoAdvance, an acceptance. A slice left pending when none of those
  // fires again has nobody to start it, and RUNNING with an empty queue looks
  // exactly like working.
  const h = await harness();
  await fx.on(h.db).slice.create({ grp_id: 1, seq: 1, title: "s", accept_spec: "a", status: "pending" });
  await runWatchdog(h.deps);
  expect((await h.db.select({ s: sliceTable.status }).from(sliceTable).where(eq(sliceTable.grp_id, 1)))[0]!.s).toBe(
    "running",
  );
  // The harness scheduler dispatches inline, so by now the turn is done and rule 8
  // has put another one back. What matters is that one exists at all.
  expect(
    (await h.db.select({ c: count() }).from(jobTable).where(eq(jobTable.kind, "agent_turn")))[0]!.c,
  ).toBeGreaterThan(0);
});

test("a stale PR branch is told to rebase too, with the measured remote base in its instructions", async () => {
  // PR_OPEN used to be excluded, so the one branch that has to merge only learned
  // main had moved when GitHub called it CONFLICTING — the late half of the same
  // news. And the base was read from the local checkout's HEAD, so a push from
  // another machine was invisible however often this ran.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "PR_OPEN", sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  // The base branch is a column now, written from GitHub's `default_branch` at
  // registration — never detected with host git, which has no checkout to ask.
  await h.db.update(projectTable).set({ repo_path: "acme/p-pr", base_branch: "master" }).where(eq(projectTable.id, 1));
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
  const [job] = await h.db
    .select({ p: jobTable.payload_json })
    .from(jobTable)
    .where(and(eq(jobTable.kind, "agent_turn"), eq(jobTable.state, "pending")));
  const payload = AgentTurnPayloadSchema.parse(job!.p);
  expect(payload.rejection).toContain("origin/master moved to abc12345");
  expect(payload.rejection).toContain("git fetch origin master");
  expect(payload.rejection).toContain("git rebase origin/master");
});

test("a group already on the base is not nudged", async () => {
  // The sha comparison is the whole rule: a group that has rebased must not be
  // told again, or an agent learns to skip the message.
  const h = await harness();
  await h.db.update(grpTable).set({ sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  h.ctx.gh = gh(() => ({ commit: { sha: "def4560000000000000000000000000000000000" } }));
  const deps = h.deps;
  // `merge-base --is-ancestor` succeeds in the group's own clone: already on it.
  h.ctx.sandbox = fakeSandbox(() => ({ code: 0 }));

  const f = await runWatchdog(deps);
  expect(f.map((x) => x.rule)).not.toContain("base_moved");
  const jobs = await h.db.select({ p: jobTable.payload_json }).from(jobTable).where(eq(jobTable.kind, "agent_turn"));
  expect(jobs.map((j) => AgentTurnPayloadSchema.parse(j.p).role)).not.toContain("engineer");
});

test("turn logs are compressed after a day and dropped after two weeks", async () => {
  // A transcript is mostly tool output written verbatim, so these are worth
  // keeping and not worth keeping uncompressed.
  const dir = tempDir("orch-logs-");
  const now = 10 * DROP_AFTER_MS;
  writeFileSync(join(dir, "1.jsonl"), "x".repeat(5000));
  writeFileSync(join(dir, "2.jsonl"), "y".repeat(5000));
  writeFileSync(join(dir, "3.jsonl.gz"), "old");
  utimesSync(join(dir, "1.jsonl"), 0, (now - GZIP_AFTER_MS * 2) / 1000);
  utimesSync(join(dir, "3.jsonl.gz"), 0, (now - DROP_AFTER_MS * 2) / 1000);

  const r = sweepTurnLogs(dir, now);
  expect(r).toEqual({ zipped: 1, dropped: 1 });
  // Today's turn is left alone: it is still being written to. Asserted as one
  // map so a failure names the file that survived or vanished, which four bare
  // booleans on four lines did not.
  const kept = (...names: string[]) => Object.fromEntries(names.map((n) => [n, existsSync(join(dir, n))]));
  expect(kept("1.jsonl.gz", "1.jsonl", "2.jsonl", "3.jsonl.gz")).toEqual({
    "1.jsonl.gz": true,
    "1.jsonl": false,
    "2.jsonl": true,
    "3.jsonl.gz": false,
  });
});

test("a burst of pushes costs one rebase turn, and never delays one", async () => {
  const h = await harness();
  await h.db.update(grpTable).set({ sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  await h.db.update(projectTable).set({ repo_path: "acme/p-burst" }).where(eq(projectTable.id, 1));
  let sha = "aaaa111111";
  h.ctx.gh = gh(() => ({ commit: { sha } }));
  const deps = h.deps;

  // Count the turns, not the findings: a finding is suppressed as a re-emit for
  // half an hour, and what is being asserted here is what the group was made to do.
  // Containment, not a LIKE over the rendered payload: `jsonb` prints a space
  // after every colon and does not keep key order, so the substring the sqlite
  // version matched is not a string Postgres produces.
  const turns = async () =>
    (
      await h.db
        .select({ c: count() })
        .from(jobTable)
        .where(sql`${jobTable.payload_json} @> '{"conflict":true}'::jsonb`)
    )[0]!.c;

  await runWatchdog(deps);
  expect(await turns()).toBe(1);

  // Pushed again while the first nudge is still queued: same turn, not a second.
  sha = "bbbb222222";
  await runWatchdog(deps);
  expect(await turns()).toBe(1);

  // It ran. A base that moved again is acted on immediately — there is no clock to
  // wait out, because a group whose PR is blocked on a rebase must not sit on it.
  await h.db.update(jobTable).set({ state: "done" }).where(eq(jobTable.state, "pending"));
  sha = "cccc333333";
  await runWatchdog(deps);
  expect(await turns()).toBe(2);
});

test("a question the work went past is closed rather than left in 待办", async () => {
  // review.ts files a blocker when a slice fails QA three times and pauses the
  // group. Nothing closed it if the group recovered: live, src-mech-watchdog-ts
  // had a merge-ready PR and an open blocker on the same requirement, in the same
  // list, asking the boss to unblock a group that was finished.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "PR_OPEN" }).where(eq(grpTable.id, 1));
  await fx.on(h.db).escalation.create({
    grp_id: 1,
    severity: "blocker",
    question: "S1 failed qa 3 times",
    chain_state: "boss",
  });
  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("stale_ask");
  expect((await h.db.select({ s: escalationTable.chain_state }).from(escalationTable))[0]!.s).toBe("revoked");
});

test("a question on a group that is still working is left alone", async () => {
  const h = await harness();
  await fx.on(h.db).escalation.create({
    grp_id: 1,
    severity: "blocker",
    question: "which library?",
    chain_state: "boss",
  });
  await runWatchdog(h.deps);
  expect((await h.db.select({ s: escalationTable.chain_state }).from(escalationTable))[0]!.s).toBe("boss");
});

test("a dissolved group's sandbox is killed, so it stops holding two containers", async () => {
  const h = await harness();
  // Nothing removed one, ever, in the worktree era: twelve dead checkouts sat on
  // disk holding their branches. A sandbox is worse — two containers and their
  // memory, until a TTL a day out.
  await h.db
    .update(grpTable)
    .set({ status: "DISSOLVED", sandbox_id: "sb-1", branch: "orch/g1", pr_number: 7 })
    .where(eq(grpTable.id, 1));

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
  const h = await harness();
  await fx.on(h.db).job.create({
    grp_id: 1,
    agent_id: 1,
    payload_json: { role: "engineer" },
    state: "running",
    started_at: 0,
  });
  await h.db.update(agentTable).set({ state: "running" }).where(eq(agentTable.id, 1));

  const f = await runWatchdog({ ...h.deps, probe: async () => ({ online: false, changed: true }) });
  expect(f.map((x) => x.rule)).toContain("network_lost");

  // The work goes back on the queue and the requirement stays RUNNING. Pausing it
  // is what would need a human afterwards: nothing takes a group out of PAUSED,
  // and the park timer would file it away while the network was down.
  expect(await grpStatus(h.db)).toBe("RUNNING");
  const requeued = await h.db
    .select({ n: count() })
    .from(jobTable)
    .where(and(eq(jobTable.state, "pending"), eq(jobTable.kind, "agent_turn")));
  expect(requeued[0]!.n).toBe(1);
  expect((await h.db.select({ state: agentTable.state }).from(agentTable).where(eq(agentTable.id, 1)))[0]!.state).toBe(
    "idle",
  );
});

test("an offline tick does not run the rules that need the network", async () => {
  // Every rule below the gate is a restatement of state we recorded ourselves, and
  // none is worth a two-second DNS timeout each. This one would otherwise fire.
  const h = await harness({ turnTimeoutMs: 1000 });
  await fx.on(h.db).job.create({ grp_id: 1, state: "running", started_at: 0 });
  const f = await runWatchdog({ ...h.deps, probe: async () => ({ online: false, changed: false }) });
  expect(f.map((x) => x.rule)).not.toContain("turn_timeout");
});

test("one rule throwing costs that rule, not the twenty-four after it", async () => {
  // The tick is straight-line async: before this, a throw anywhere skipped every
  // rule below it, and `invariants.ts` names the watchdog as the `driver` for
  // about twelve states — so one bad rule meant twelve drivers silent for thirty
  // seconds, and the report said only "the watchdog broke".
  const h = await harness();
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
  await fx.on(h.db).job.create({ grp_id: 1, payload_json: { role: "engineer" }, state: "failed", error: "boom" });
  const first = await runWatchdog(deps);
  // The rule that threw names itself, so the finding is actionable — "rule 7d3
  // broke" rather than "the watchdog broke".
  expect(first.map((x) => x.rule)).toContain("rule_broke:7d3");
  expect(first.find((x) => x.rule === "rule_broke:7d3")!.say.values?.why).toContain("usage endpoint exploded");

  // The next tick, with 7d3 still throwing: the rules after it ran anyway, and
  // the breakage is not reported a second time — once per REEMIT_MS, or a rule
  // that throws every 30 seconds is 120 blocker lines an hour.
  await h.db.update(jobTable).set({ state: "failed", error: "boom" }).where(eq(jobTable.state, "pending"));
  const second = await runWatchdog(deps);
  expect(second.map((x) => x.rule)).toContain("stalled");
  expect(second.map((x) => x.rule)).not.toContain("rule_broke:7d3");
});

test("delivery is a bus frame the page can raise, plus an optional webhook", async () => {
  const db = await openMemory();
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
    const [f] = await db
      .select({ kind: eventTable.kind, body: eventTable.body, meta_json: eventTable.meta_json })
      .from(eventTable)
      .where(eq(eventTable.kind, "notify"));
    expect(f?.body).toBe("谁来定一下基线分支");
    expect(NotifyMeta.parse(f!.meta_json).url).toContain("#g=3");

    expect(posted).toHaveLength(1);
    expect(WebhookBody.parse(JSON.parse(posted[0]!.body)).message).toBe("谁来定一下基线分支");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a webhook that is down does not take the run with it", async () => {
  const db = await openMemory();
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
    expect((await db.select({ c: count() }).from(eventTable).where(eq(eventTable.kind, "notify")))[0]!.c).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * The container sweep is hourly, and the hour has to survive a restart.
 *
 * It was a module-level `lastSweep` held in process memory, so every restart
 * swept again and two concurrent ticks each saw the other's zero.
 */
test("the container sweep runs hourly, and the clock is not in this process", async () => {
  const h = await harness();
  // The harness's own driver is typed as the interface, which does not carry the
  // recorder. Same behaviour, kept as the concrete fake so `commands` is typed.
  const sandbox = fakeSandbox((cmd) => (cmd.includes("merge-base") ? { code: 1 } : { code: 0 }));
  h.ctx.sandbox = sandbox;
  await h.db.update(grpTable).set({ sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  let clock = 1_000_000;
  const deps = { ...h.deps, now: () => clock };
  const swept = () => sandbox.commands.filter((c) => c.includes("sessions -type f -mtime +7")).length;

  await runWatchdog(deps);
  expect(swept()).toBe(1);

  // The next tick, 30s later. The old code answered this correctly too; what it
  // could not answer is the two below.
  clock += 30_000;
  await runWatchdog(deps);
  expect(swept()).toBe(1);

  // A restart: fresh module state, same database. `lastSweep` was zero here, so
  // the sweep ran again — one `execIn` per live sandbox, deleting nothing.
  clock += 30_000;
  await runWatchdog({ ...deps, ctx: { ...h.ctx } });
  expect(swept()).toBe(1);

  clock += 60 * 60 * 1000;
  await runWatchdog(deps);
  expect(swept()).toBe(2);
});

/**
 * A rule that threw has to look broken in the panel, not merely in the findings.
 *
 * The catch used to sit outside `startActiveSpan`, so the span ended green and a
 * rule that threw was indistinguishable there from one that worked — in the one
 * surface built to answer "which rule". The finding is for the boss; the status
 * is for whoever is looking at where the tick went.
 */
test("a rule that throws marks its own span, not just the findings", async () => {
  const h = await harness();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new StoredSpanExporter(h.db))] });
  installTracerProvider(provider);
  try {
    await runWatchdog({
      ...h.deps,
      pollUsage: async () => {
        throw new Error("usage endpoint exploded");
      },
    });
    await provider.forceFlush();

    const rows = await h.db
      .select({ name: spanTable.name, status: spanTable.status })
      .from(spanTable)
      .where(like(spanTable.name, "watchdog.%"));
    // Lowercase: `spanStatusName` is what the column stores, and the aggregation
    // in `span-store.ts` counts `status = 'error'`.
    expect(rows.find((r) => r.name === "watchdog.subscription_usage")?.status).toBe("error");
    // And only that one: a tick where one rule throws still reports the rest as
    // having run, or the panel would blame twenty-three innocent rules.
    expect(rows.filter((r) => r.status === "error").map((r) => r.name)).toEqual(["watchdog.subscription_usage"]);
  } finally {
    installTracerProvider(new NodeTracerProvider());
  }
});

test("the two reconcilers above the rules cost themselves, not the twenty-four below", async () => {
  // `runInvariants` and `sweepApproved` run before every rule and were the only
  // two things on the tick outside `step`. A throw in either escaped to
  // `runWatchdog`'s catch, so all twenty-four rules were skipped — every thirty
  // seconds, reported as one deduped line every half hour. Rule 18 stops renewing
  // sandbox TTLs on that path, and the fleet is reaped in a day.
  const h = await harness({ turnTimeoutMs: 1000 });
  // `publishBranch` is the one `Ctx` callback `runInvariants` reaches
  // (invariants.ts:175), so it is how a test makes that half throw without
  // pretending anything else is broken.
  h.ctx.publishBranch = () => {
    throw new Error("publish exploded");
  };
  // That repair's condition: PR_OPEN, no PR number, has a merge_seq, and no live
  // turn — so the timed-out turn below has to belong to a different group, or it
  // satisfies the NOT EXISTS and the repair never runs.
  await h.db.update(grpTable).set({ status: "PR_OPEN", pr_number: null, merge_seq: 1 }).where(eq(grpTable.id, 1));
  const other = await fx.on(h.db).runningGrp.create({ project_id: 1, name: "g2" });
  // Rule 1's condition, which is checked after both reconcilers.
  await fx.on(h.db).job.create({ grp_id: other.id, state: "running", started_at: 0 });

  const findings = await runWatchdog(h.deps);
  const rules = findings.map((f) => f.rule);

  // The reconciler that threw names itself, rather than "the watchdog broke".
  expect(rules).toContain("rule_broke:0a");
  expect(rules).toContain("turn_timeout");
});

test("a rebase nudge that fails to enqueue is not recorded as delivered", async () => {
  // `rebase_seen` is the record that this base movement was handled, and it was
  // written *before* the enqueue. A throw there left the row claiming delivery,
  // so that movement was never nudged again — the group silently stays stale.
  // Act first, record after, which is the same order a reconciler writes
  // `observedGeneration`.
  const h = await harness();
  await h.db.update(grpTable).set({ sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  h.ctx.gh = gh(() => ({ commit: { sha: "abc1234567" } }));
  h.ctx.sched.enqueue = () => {
    throw new Error("enqueue exploded");
  };

  await runWatchdog(h.deps);

  expect((await h.db.select({ s: grpTable.rebase_seen }).from(grpTable).where(eq(grpTable.id, 1)))[0]!.s).toBeNull();
});

test("a question on a group nobody can answer is closed, not pushed to the boss first", async () => {
  // Rule 11 routes stranded blockers to the boss; rule 16 revokes questions on
  // groups that have no caller left. Rule 11 ran first and its predicate — "not a
  // dispatchable state" — includes exactly the states rule 16 revokes. So a
  // dissolved group's blocker was pushed to the boss's phone and killed three
  // hundred lines later in the same sweep.
  const h = await harness();
  const pushed: number[] = [];
  h.ctx.notifyBoss = (escId) => void pushed.push(escId);
  await h.db.update(grpTable).set({ status: "DISSOLVED" }).where(eq(grpTable.id, 1));
  await fx.on(h.db).escalation.create({ grp_id: 1, chain_state: "pm", severity: "blocker", question: "which schema?" });

  const findings = await runWatchdog(h.deps);

  expect(findings.map((f) => f.rule)).toContain("stale_ask");
  expect(pushed).toEqual([]);
});

/**
 * One request per project, not per group.
 *
 * Every group in a project asks the same repository for the same branch, so ten
 * groups meant ten identical calls against one rate limit every thirty seconds.
 * Whether the base *moved* is still per group: that compares what each last saw.
 */
test("groups sharing a project ask GitHub about their base once between them", async () => {
  const h = await harness();
  await h.db.update(grpTable).set({ status: "RUNNING", sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  await h.db.update(projectTable).set({ repo_path: "acme/p-pr", base_branch: "master" }).where(eq(projectTable.id, 1));
  for (const name of ["g2", "g3"]) {
    const { id } = await fx.on(h.db).grp.create({ project_id: 1, name });
    await h.db.update(grpTable).set({ status: "RUNNING", sandbox_id: "sb-1" }).where(eq(grpTable.id, id));
  }
  const asked: string[] = [];
  h.ctx.gh = gh((path) => {
    asked.push(path);
    return { commit: { sha: "abc1234567" } };
  });

  await runWatchdog(h.deps);

  expect(asked.filter((p) => p.includes("/branches/master"))).toHaveLength(1);
  // All three still learned about it: the shared answer is not a shared verdict.
  expect((await h.db.select({ c: count() }).from(grpTable).where(eq(grpTable.rebase_seen, "abc1234567")))[0]!.c).toBe(
    3,
  );
});

/**
 * One sentence per network transition, not two.
 *
 * `networkReady` announced the change twice: a `bus.emit` from `orchestrator` as
 * a state change, and the finding, which `emit` renders as a `watchdog`
 * escalation. Same body, same second — visible in the feed as the identical line
 * from two authors. The direct call had no dedup either, so it also re-announced
 * a standing outage on every transition into a retry, while the finding path
 * backs off for `REEMIT_MS`.
 */
test("losing the network is announced once, by the path that dedups", async () => {
  const h = await harness();
  const offline = { online: false, changed: true };
  const found = await runWatchdog({ ...h.deps, probe: async () => offline });

  expect(found.filter((f) => f.rule === "network_lost")).toHaveLength(1);
  const said = (await h.db.select({ c: count() }).from(eventTable).where(like(eventTable.body, "%断网%")))[0]!.c;
  expect(said).toBe(1);
});

/**
 * The idle fleet paid for a rebuild that found nothing.
 *
 * `repo_map` runs every tick, per project, and made both its round trips before
 * it knew whether anything had changed — the second one carrying every tracked
 * file's contents out of the container. A repository nobody touched cost four
 * container execs and 0.8 MB every thirty seconds to produce a map byte for byte
 * identical to the stored one.
 */
test("an idle project pays one cheap exec a tick, not the whole corpus", async () => {
  const h = await harness(EVERY_MAP_TICK);
  let head = "1111111111111111111111111111111111111111";
  const sandbox = fakeSandbox((cmd) => {
    if (cmd.includes("merge-base")) return { code: 1 };
    if (cmd.includes("rev-parse")) return { out: head };
    if (cmd.includes("ls-tree")) return { out: "src/a.ts\n" };
    return { code: 0 };
  });
  h.ctx.sandbox = sandbox;
  await h.db.update(projectTable).set({ remote: "https://example.invalid/o/r.git" }).where(eq(projectTable.id, 1));
  const mapWork = () => sandbox.commands.filter((c) => /ls-tree|ls-files|test -d|git .*clone/.test(c)).length;

  await runWatchdog(h.deps);
  expect(mapWork()).toBe(4);

  // A restart between the ticks: fresh module state, same database. The stamp has
  // to be in the database, or every restart re-does the work — and two ticks each
  // see the other's nothing.
  sandbox.commands.length = 0;
  await runWatchdog({ ...h.deps, ctx: { ...h.ctx } });
  expect(mapWork()).toBe(0);
  // The whole tick, not just this rule: one `rev-parse HEAD`, 41 bytes back.
  expect(sandbox.commands).toHaveLength(1);
  expect(sandbox.commands[0]).toContain("rev-parse");

  // The point of the gate is that it still notices. HEAD moves, the map is rebuilt.
  head = "2222222222222222222222222222222222222222";
  sandbox.commands.length = 0;
  await runWatchdog(h.deps);
  expect(mapWork()).toBe(4);
});

/**
 * An unreadable container builds the map once, then says so and stops.
 *
 * It used to rebuild every tick, because a stamp that cannot be taken is not a
 * stamp saying "unchanged". Measured over 2,766 real ticks that cost **6,351
 * seconds — 95% of the whole watchdog tick** and bought nothing: the container
 * that cannot answer `rev-parse` is the one `treeHeads` reads contents from, so
 * each rebuild stored a *paths-only* map over a better one. The first build
 * stays — a paths-only map beats none; the repetition was the defect.
 */
test("an unreadable container builds the map once, then reports instead of rebuilding", async () => {
  const h = await harness(EVERY_MAP_TICK);
  const sandbox = fakeSandbox((cmd) => {
    if (cmd.includes("rev-parse")) return { code: 128, err: "not a git repository" };
    if (cmd.includes("ls-tree")) return { out: "src/a.ts\n" };
    return { code: 0 };
  });
  h.ctx.sandbox = sandbox;
  await h.db.update(projectTable).set({ remote: "https://example.invalid/o/r.git" }).where(eq(projectTable.id, 1));

  const ticks = [await runWatchdog(h.deps), await runWatchdog(h.deps), await runWatchdog(h.deps)];

  // One build, not one per tick — and the stamp is still absent, so the moment the
  // container answers again the ordinary gate takes over with no special case.
  expect(sandbox.commands.filter((c) => c.includes("ls-tree"))).toHaveLength(1);
  expect(await readSetting(h.db, "watchdog.repo_map.1")).toBeNull();
  // Said once, and it names why rebuilding would not help.
  const said = ticks.flat().filter((f) => f.say.id === "ev.wd.map_stale");
  expect(said).toHaveLength(1);
});

test("every live container is renewed on the tick: groups, projects and the utility one", async () => {
  // The TTL is short enough to reap a group that is merely thinking, and renewal is
  // the other half of that bargain. Miss it and every container in the fleet is
  // reaped under whatever was using it, about a day later, with no error anywhere:
  // the next command in a live checkout simply says the sandbox is gone.
  const h = await harness();
  // Rule 17b kills a container older than the newest credential, which is every
  // container in this fixture. Silenced here so the renewals are the only subject.
  await h.db.update(runtimeAuthTable).set({ updated_at: 0 });
  await h.db.update(grpTable).set({ sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  await h.db.update(projectTable).set({ sandbox_id: "sb-p" }).where(eq(projectTable.id, 1));

  const renewed: string[] = [];
  h.ctx.sandbox = {
    ...h.ctx.sandbox!,
    renew: async (_c, scope) => {
      renewed.push(JSON.stringify(scope));
    },
  };

  await runWatchdog(h.deps);
  expect(renewed).toEqual(['{"grp":1}', '{"project":1}', '{"util":true}']);
});

test("a sandbox older than the credential it is bound to is recycled, a newer one is left alone", async () => {
  // A sidecar is loaded once, when its sandbox is built, so a rotated token never
  // reaches a container that was already up. It keeps pushing with the old one and
  // GitHub refuses it — the boss-bucket failure 007 §6 says must never present as
  // an agent problem, and the container looks perfectly healthy while it happens.
  const h = await harness();
  await h.db.update(runtimeAuthTable).set({ updated_at: 5000 });
  const fresh = await fx
    .on(h.db)
    .runningGrp.create({ project_id: 1, name: "g-fresh", sandbox_id: "sb-2", sandbox_at: 9000 });
  await h.db.update(grpTable).set({ sandbox_id: "sb-1", sandbox_at: 1000 }).where(eq(grpTable.id, 1));

  const killed: string[] = [];
  h.ctx.sandbox = {
    ...h.ctx.sandbox!,
    kill: async (_c, scope) => {
      killed.push(JSON.stringify(scope));
    },
  };

  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("sandbox_stale_credential");
  expect(killed).toEqual(['{"grp":1}']);
  expect(killed).not.toContain(`{"grp":${fresh.id}}`);
});

test("a burnt budget puts a decision in front of the boss, not only a line in the feed", async () => {
  // Suspending without a row to answer left the group stopped with no reason
  // attached: 继续 did nothing the scheduler would honour, and the only visible
  // state was a paused requirement nobody could unpause.
  const h = await harness();
  await h.db.update(grpTable).set({ budget_tokens: 100, spent_tokens: 100 }).where(eq(grpTable.id, 1));

  await runWatchdog(h.deps);
  const [e] = await h.db
    .select({ chain_state: escalationTable.chain_state, question: escalationTable.question })
    .from(escalationTable);
  expect(e!.chain_state).toBe("boss");
  expect(e!.question).toStartWith("budget:");
  expect(await grpStatus(h.db)).toBe("PAUSED");
});

test("an agent that keeps writing nothing is blocked, and its count starts over", async () => {
  // The finding is a sentence; blocking it is the effect. Without it the same agent
  // is dispatched on every tick, writes nothing again, and the only symptom is
  // money leaving — which is the exact failure this rule was bought for.
  const h = await harness();
  await h.db.update(agentTable).set({ idle_turns: LIMITS.idleTurns }).where(eq(agentTable.id, 1));

  await runWatchdog(h.deps);
  const [worker] = await h.db
    .select({ state: agentTable.state, idle_turns: agentTable.idle_turns })
    .from(agentTable)
    .where(eq(agentTable.id, 1));
  expect(worker).toEqual({ state: "blocked", idle_turns: 0 });
});

test("a parked group with a question still open is not revived by an older answer", async () => {
  // Waking it puts a group back to work on the very thing it is still waiting to be
  // told, and it parks itself again on the next clock: a loop with two containers
  // at each turn of it.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "PARKED", paused_at: 100 }).where(eq(grpTable.id, 1));
  await fx.on(h.db).escalation.create({
    grp_id: 1,
    severity: "blocker",
    question: "which library?",
    answer: "the stdlib one",
    answered_by: "boss",
    chain_state: "answered",
    answered_at: 500,
  });
  await fx
    .on(h.db)
    .escalation.create({ grp_id: 1, severity: "blocker", question: "and the schema?", chain_state: "boss" });

  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).not.toContain("unparked");
  expect(await grpStatus(h.db)).toBe("PARKED");
});

test("a group waiting on another group is not parked out from under itself either", async () => {
  // Same bargain as the quota wait: rule 10 wakes this one the moment the group it
  // is blocked on lands, and parking retires the sessions minutes before that.
  const h = await harness();
  const other = await fx.on(h.db).runningGrp.create({ project_id: 1, name: "g-blocker" });
  await h.db
    .update(grpTable)
    .set({ status: "PAUSED", paused_at: 1_000_000 - h.cfg.parkAfterPausedMs - 1000, blocked_on: other.id })
    .where(eq(grpTable.id, 1));

  const f = await runWatchdog(h.deps);
  expect(f.filter((x) => x.rule === "parked")).toEqual([]);
  expect(await grpStatus(h.db)).toBe("PAUSED");
});

test("closing a question the work went past also lets go of whoever was waiting on it", async () => {
  // The revoke closes the row; the waiter is what holds a job alive. Left hanging,
  // the requirement is merged and a turn is still parked on an answer that is never
  // coming — a running job row nothing will ever end.
  const h = await harness();
  await h.db.update(grpTable).set({ status: "PR_OPEN" }).where(eq(grpTable.id, 1));
  const e = await fx
    .on(h.db)
    .escalation.create({ grp_id: 1, severity: "blocker", question: "S1 failed qa", chain_state: "pm" });
  const released: string[] = [];
  h.ctx.waiters.set(`escalation:${e.id}`, (v) => {
    released.push(v);
  });

  await runWatchdog(h.deps);
  expect(released[0]).toContain("stale");
  expect(h.ctx.waiters.has(`escalation:${e.id}`)).toBe(false);
});

test("the tick sweeps the turn logs where the config says they are", async () => {
  // The executor gzips its own log when the turn ends, so this sweep only ever
  // meets what a crash left behind — and it is the only thing that does. Pointed at
  // the wrong directory it reports nothing and the disk fills with raw transcripts.
  const dir = tempDir("orch-wd-turns-");
  mkdirSync(join(dir, "turns"));
  const log = join(dir, "turns", "9.jsonl");
  writeFileSync(log, "x".repeat(5000));
  const now = 10 * DROP_AFTER_MS;
  utimesSync(log, 0, (now - GZIP_AFTER_MS * 2) / 1000);

  const h = await harness({ dataDir: dir });
  await runWatchdog({ ...h.deps, now: () => now });
  expect({ raw: existsSync(log), gz: existsSync(`${log}.gz`) }).toEqual({ raw: false, gz: true });
});

test("a group already told about this commit is not told again once the turn has ended", async () => {
  // The pending-turn check only covers the nudge still sitting in the queue. Once
  // it has run and the branch is still not on the base — a conflict it could not
  // finish — the commit recorded as announced is the only thing between the group
  // and a fresh rebase order every thirty seconds, for as long as it stays stuck.
  const h = await harness();
  await h.db.update(grpTable).set({ sandbox_id: "sb-1" }).where(eq(grpTable.id, 1));
  h.ctx.gh = gh(() => ({ commit: { sha: "abc1234567" } }));
  const nudges = async () =>
    (
      await h.db
        .select({ c: count() })
        .from(jobTable)
        .where(sql`${jobTable.payload_json} @> '{"conflict":true}'::jsonb`)
    )[0]!.c;

  await runWatchdog(h.deps);
  expect(await nudges()).toBe(1);
  await h.db.update(jobTable).set({ state: "failed", error: "could not rebase" }).where(eq(jobTable.state, "pending"));
  await runWatchdog(h.deps);
  expect(await nudges()).toBe(1);
});

test("a group parked and forgotten is still asked about", async () => {
  // Nothing takes a group out of PARKED on its own and it will not ask again, so
  // the reminder is the whole of what is owed: without it the requirement is filed
  // away silently and the boss finds it by accident, weeks later.
  const h = await harness();
  await h.db
    .update(grpTable)
    .set({ status: "PARKED", paused_at: 1_000_000 - LIMITS.nudgeAfterMs - 1000 })
    .where(eq(grpTable.id, 1));

  const f = await runWatchdog(h.deps);
  expect(f.map((x) => x.rule)).toContain("waiting_parked");
});

test("an approval that cannot land is withdrawn on the tick, not retried every thirty seconds", async () => {
  // The boss approves while a boundary holds the group; the tick is what starts it
  // afterwards. A checkout failure is almost always permanent, so leaving the
  // intent set retried it forever and returned the error to nobody.
  const h = await harness();
  const g = await fx.on(h.db).grp.create({ project_id: 1, name: "g-approved", approved_at: 1 });

  await runWatchdog(h.deps);
  const [row] = await h.db.select({ approved_at: grpTable.approved_at }).from(grpTable).where(eq(grpTable.id, g.id));
  expect(row!.approved_at).toBe(null);
  const asked = await h.db.select({ c: count() }).from(escalationTable).where(eq(escalationTable.grp_id, g.id));
  expect(asked[0]!.c).toBe(1);
});

test("a merge queue held up behind the head interrupts, one PR waiting on its own does not", async () => {
  // A blocker reaches the boss's phone now; an advisory waits for the next batch.
  // The head of a queue with three requirements stopped behind it is the one thing
  // in this rule that costs a working day per hour of silence.
  const h = await harness();
  const old = 1_000_000 - 5 * 3_600_000;
  const queued = (n: number) =>
    fx.on(h.db).grp.create({ project_id: 1, name: `q${n}`, status: "PR_OPEN", merge_seq: n, merge_seq_at: old });
  await queued(1);

  const alone = (await runWatchdog(h.deps)).find((x) => x.rule === "waiting_merge")!;
  expect(alone.severity).toBe("advisory");

  const h2 = await harness();
  const queued2 = (n: number) =>
    fx.on(h2.db).grp.create({ project_id: 1, name: `q${n}`, status: "PR_OPEN", merge_seq: n, merge_seq_at: old });
  await queued2(1);
  await queued2(2);
  const head = (await runWatchdog(h2.deps)).find((x) => x.rule === "waiting_merge")!;
  expect(head.severity).toBe("blocker");
  expect(head.say.values?.n).toBe(1);
});

/**
 * The staleness check has its own clock, and it is a setting.
 *
 * Asking costs a container round trip — 947ms of a 30s interval, measured over
 * 2,766 ticks — to be told "unchanged" on 1,534 of them, about a map whose input
 * is somebody pushing a commit. Freshness here costs nothing an agent can feel:
 * the map is navigation, not a gate.
 */
test("the repo map is not asked about on every tick, and the period is configurable", async () => {
  const h = await harness({ watchdog: { ...loadConfig().watchdog, repoMapEveryMs: 60_000 } });
  const sandbox = fakeSandbox((cmd) => {
    if (cmd.includes("merge-base")) return { code: 1 };
    if (cmd.includes("rev-parse")) return { out: "1111111111111111111111111111111111111111" };
    if (cmd.includes("ls-tree")) return { out: "src/a.ts\n" };
    return { code: 0 };
  });
  h.ctx.sandbox = sandbox;
  await h.db.update(projectTable).set({ remote: "https://example.invalid/o/r.git" }).where(eq(projectTable.id, 1));

  const asked = () => sandbox.commands.filter((c) => c.includes("rev-parse")).length;
  await runWatchdog(h.deps);
  expect(asked()).toBe(1);
  // Three more ticks inside the minute, and it does not ask again.
  await runWatchdog(h.deps);
  await runWatchdog(h.deps);
  await runWatchdog(h.deps);
  expect(asked()).toBe(1);

  // A rule that has never run is due, so the first tick is never delayed; that is
  // what makes this a period and not a warm-up.
  const fresh = await harness({ watchdog: { ...loadConfig().watchdog, repoMapEveryMs: 60_000 } });
  fresh.ctx.sandbox = sandbox;
  await fresh.db.update(projectTable).set({ remote: "https://example.invalid/o/r.git" }).where(eq(projectTable.id, 1));
  const before = asked();
  await runWatchdog(fresh.deps);
  expect(asked()).toBe(before + 1);
});

/**
 * The other half of ADR 035 §3, which the panel's half is easy to break.
 *
 * A finding now travels as an id, and the panel renders it. The notifier does
 * not: `busDeliver` POSTs what it is handed to a webhook, and there is no
 * browser on that path — so `publishWatchdogFinding` has to render, in
 * `output.language`, before `onFinding` ever sees it.
 */
test("a finding reaches the notifier as a sentence in output.language, not as an id", async () => {
  const h = await harness();
  const seen: string[] = [];
  h.ctx.onFinding = (_rule, _severity, body) => seen.push(body);

  publishWatchdogFinding(h.ctx, {
    rule: "turn_timeout",
    grpId: 1,
    severity: "advisory",
    say: said("ev.wd.turn_timeout", { min: 30 }),
  });

  expect(seen).toEqual(["一个 turn 超过 30 分钟，已掐断"]);
});
