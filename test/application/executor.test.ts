import { afterEach, expect, test } from "bun:test";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig, loadRoles } from "../../src/platform/config/load.ts";
import { and, asc, count, desc, eq, like, sql } from "drizzle-orm";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import * as t from "../../src/platform/persistence/schema.ts";
import type { TurnResult, TurnSpec } from "../../src/runtime/claude.ts";
import { cacheRatio, type ExecDeps, hire, LOST_SESSION, makeExecutor } from "../../src/application/executor.ts";
import { AgentTurnPayloadSchema, type Executor } from "../../src/platform/scheduling/scheduler.ts";
import { abortJob } from "../../src/platform/process/running-turns.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { tempDir } from "../support/temp.ts";
import { newScheduler } from "../support/scheduler.ts";

function ok(over: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "s1",
    ok: true,
    terminalReason: "completed",
    text: "done",
    usage: { input: 10, output: 20, cacheRead: 5000, cacheCreate: 100, thinking: 0 },
    numTurns: 1,
    toolSummaries: [],
    filesTouched: [],
    ...over,
  };
}

async function harness(turn: (spec: TurnSpec) => Promise<TurnResult>) {
  const db = await openMemory();
  await seedAuth(db);
  const bus = new Bus(db);
  const cfg = { ...loadConfig(), dataDir: tempDir("orch-data-") };
  const specs: TurnSpec[] = [];
  let exec: Executor;
  const sched = newScheduler(db, (j) => exec(j));
  const sandbox = fakeSandbox();
  const ctx: Ctx = {
    db,
    bus,
    sched,
    sandbox,
    waiters: new Map(),
    config: cfg,
  };
  const deps: ExecDeps = {
    ctx,
    cfg,
    roles: loadRoles("roles"), // no repo in these tests
    runTurn: async (spec) => {
      specs.push(spec);
      return turn(spec);
    },
  };
  exec = makeExecutor(deps);

  const f = fx.on(db);
  const p = await f.project.create({ name: "p" });
  await f.runningGrp.create({ project_id: p.id, name: "g1" });
  return { db, ctx, sched, deps, specs, sandbox, f, app: makeApp(ctx) };
}

// One database serves the file and `TRUNCATE` does not drop a trigger, so the
// wake failure armed below would arm every test after it.
afterEach(async () => {
  await (await openMemory()).execute(sql.raw("DROP TRIGGER IF EXISTS fail_lease_wake ON job"));
});

async function expectDurableLeaseWake(db: DB, agentId: number, body: string): Promise<void> {
  expect((await db.select({ state: t.agent.state }).from(t.agent).where(eq(t.agent.id, agentId)))[0]?.state).toBe(
    "idle",
  );
  const [wake] = await db
    .select({ agent_id: t.job.agent_id, payload_json: t.job.payload_json })
    .from(t.job)
    .where(and(eq(t.job.kind, "agent_turn"), eq(t.job.agent_id, agentId)))
    .orderBy(desc(t.job.id))
    .limit(1);
  expect(wake?.agent_id).toBe(agentId);
  // `payload_json` is jsonb: it arrives parsed, and the schema still decides.
  const mail = AgentTurnPayloadSchema.parse(wake?.payload_json).mail;
  expect(mail).toMatchObject({ from: "runner", from_group: 1, intent: "inform" });
  expect(mail?.body).toContain(body);
}

test("a turn hires the role's agent on first use, with a token", async () => {
  const { db, sched } = await harness(async () => ok());
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  const [a] = await db.select({ role: t.agent.role, token: t.agent.token, model: t.agent.model }).from(t.agent);
  expect(a?.role).toBe("engineer");
  expect(a?.token).toBeTruthy();
});

test("the slice's difficulty picks the model — the boss's cost knob", async () => {
  const { db, sched, specs, f } = await harness(async () => ok());
  await f.slice.create({ grp_id: 1, seq: 1, title: "S1", difficulty: "trivial" });
  await sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  // The tier, not the family: the Engineer runs on codex, so the knob moves it
  // along that provider's ladder. Reading the id out of config rather than naming
  // one keeps this a test of the mechanism instead of of today's roster.
  const cfg = loadConfig("config/default.yaml");
  const eng = loadRoles("roles").get("engineer")!;
  const table = cfg.difficultyModel[eng.runtime ?? "claude"]!;
  expect(specs[0]!.stable.model).toBe(table.trivial!);

  await f.slice.create({ grp_id: 1, seq: 2, title: "S2", difficulty: "hard" });
  await db.delete(t.agent);
  await sched.enqueue("agent_turn", { grp_id: 1, slice_id: 2, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs[1]!.stable.model).toBe(table.hard!);
  expect(specs[1]!.stable.model).not.toBe(specs[0]!.stable.model);
});

test("the dispatcher ignores difficulty and always takes the strong tier", async () => {
  const { sched, specs, f } = await harness(async () => ok());
  await f.slice.create({ grp_id: 1, seq: 1, title: "S1", difficulty: "trivial" });
  await sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "dispatcher" } });
  await sched.drain();
  expect(specs[0]!.stable.model).toContain("opus");
});

test("the second turn resumes the session instead of starting one", async () => {
  const { sched, specs } = await harness(async () => ok());
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  expect(specs[0]!.newSessionId).toBeTruthy();
  expect(specs[0]!.resumeSessionId).toBeUndefined();
  // The id the runtime reported, not the one we minted — codex starts a thread of
  // its own and only that id is resumable.
  expect(specs[1]!.resumeSessionId).toBe("s1");
  // Same stable half both times, or the cache would have died between turns.
  expect(specs[1]!.stable.hash).toBe(specs[0]!.stable.hash);
});

test("a changed stable half rotates the session rather than paying full price", async () => {
  const { sched, specs, f } = await harness(async () => ok());
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  // A new lesson changes the stable half. Mutating it in place would invalidate
  // the cached prefix on every remaining turn of the session.
  await f.note.create({ project_id: 1, kind: "lesson", body: "always run gate first" });
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  expect(specs[1]!.stable.hash).not.toBe(specs[0]!.stable.hash);
  expect(specs[1]!.resumeSessionId).toBeUndefined();
  expect(specs[1]!.newSessionId).toBeTruthy();
  expect(specs[1]!.newSessionId).not.toBe(specs[0]!.newSessionId);
  // A rotated session is told it is fresh, so it re-queries instead of assuming.
  expect(specs[1]!.prompt).toContain("orch ctx query");
});

test("the delta is the prompt and never leaks into the stable half", async () => {
  const { sched, specs, f } = await harness(async () => ok());
  await f.slice.create({ grp_id: 1, seq: 1, title: "move token check", accept_spec: "mw tests pass" });
  await sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  expect(specs[0]!.prompt).toContain("move token check");
  expect(specs[0]!.stable.systemAppend).not.toContain("move token check");
});

test("cost lands on the agent, the slice and the group", async () => {
  const { db, sched, f } = await harness(async () => ok());
  await f.slice.create({ grp_id: 1, seq: 1, title: "S1" });
  await sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  const total = 10 + 20 + 5000 + 100;
  expect((await db.select({ t: t.agent.total_tokens }).from(t.agent))[0]?.t).toBe(total);
  // Tokens are the unit of account now: two subscriptions pay for this, so the
  // dollar figure was API-rate fiction on one half and absent on the other.
  // Tokens are the unit of account now: two subscriptions pay for this, so the
  // dollar figure was API-rate fiction on one half and absent on the other.
  expect((await db.select({ t: t.slice.spent_tokens }).from(t.slice))[0]?.t).toBe(total);
  expect((await db.select({ t: t.grp.spent_tokens }).from(t.grp))[0]?.t).toBe(total);
});

test("a rate limit holds the whole provider, not just the group that hit it", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const { db, sched, specs } = await harness(async () =>
    ok({ rateLimit: { status: "rejected", rateLimitType: "five_hour", resetsAt } }),
  );
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect((await db.select({ status: t.grp.status }).from(t.grp))[0]?.status).toBe("PAUSED");

  // The window belongs to the account. Before this, every other group spent a turn
  // discovering the same wall, and a standing agent — no group to pause — retried
  // into it. The held job is never started, so waiting costs nothing.
  const [hold] = await db
    .select({ runtime: t.usage_snapshot.runtime, hold_until: t.usage_snapshot.hold_until })
    .from(t.usage_snapshot);
  expect(hold?.runtime).toBe((await db.select({ runtime: t.agent.runtime }).from(t.agent))[0]?.runtime);
  expect(hold?.hold_until).toBe(resetsAt * 1000);

  // With the group running again, the hold is the only thing left holding it —
  // which is the point: the two are independent, and the account-level one is not
  // a property of any group.
  await db.update(t.grp).set({ status: "RUNNING", paused_at: null, rl_resets_at: null });
  const before = specs.length;
  await sched.enqueue("agent_turn", { grp_id: 1, agent_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs.length).toBe(before);
  expect((await db.select({ state: t.job.state }).from(t.job).orderBy(desc(t.job.id)))[0]?.state).toBe("pending");

  // And it lifts by clock — nobody has to be awake for the reset.
  await db.update(t.usage_snapshot).set({ hold_until: 1 });
  await sched.drain();
  expect(specs.length).toBe(before + 1);
});

test("a failed turn is recorded as failed, not silently swallowed", async () => {
  const { db, sched } = await harness(async () => ok({ ok: false, terminalReason: "api_error", text: "boom" }));
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  const [failed] = await db.select({ state: t.job.state, error: t.job.error }).from(t.job);
  expect(failed?.state).toBe("failed");
  expect(failed?.error).toContain("api_error");
  expect((await db.select({ state: t.agent.state }).from(t.agent))[0]?.state).toBe("idle");
});

test("unread channel messages are injected once, then the cursor advances", async () => {
  const { ctx, sched, specs, f } = await harness(async () => ok());
  await f.channel.create({ project_id: 1, grp_id: 1 });
  await ctx.bus.emit({
    channelId: 1,
    grpId: 1,
    author: "boss",
    kind: "boss_say",
    intent: "request",
    body: "prefer iteration",
  });

  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs[0]!.prompt).toContain("prefer iteration");

  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  // Re-sending it every turn is how ambient chat quietly becomes the whole bill.
  expect(specs[1]!.prompt).not.toContain("prefer iteration");
});

test("a lease runs its template and durably wakes the waiting agent", async () => {
  const { db, ctx, sched, sandbox, f } = await harness(async () => ok());
  const agent = await hire(harnessDeps(ctx), 1, "engineer");
  await db.update(t.agent).set({ state: "waiting_lease" }).where(eq(t.agent.id, agent.id));
  await f.resource.create({ name: "echo", template: "echo hello-lease", error_regex: "^error" });
  const lease = await f.lease.create({ resource: "echo", grp_id: 1, agent_id: agent.id });

  await sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  // The template reached the sandbox as argv, quoted, with nothing shell-parsed
  // on the way — that is the whole of hard constraint 2 now that `orch` is the
  // only interface an agent has.
  expect(sandbox.commands).toContain("'echo' 'hello-lease'");
  const [row] = await db.select({ state: t.lease.state, exit_code: t.lease.exit_code }).from(t.lease);
  expect(row?.state).toBe("done");
  expect(row?.exit_code).toBe(0);
  await expectDurableLeaseWake(db, agent.id, "exit 0");
});

test("a lease that finishes twice wakes its agent once", async () => {
  // The UPDATE is guarded on the lease still being queued or running, and that
  // guard is what makes `finishLease` the single resolver: it is the only thing
  // that resolves `waiters.get("lease:N")`, and the agent's own `orch lease` call
  // has no deadline. A second finish that changed rows would enqueue a second
  // wake turn for work that ran once.
  const { db, ctx, sched, f } = await harness(async () => ok());
  const agent = await hire(harnessDeps(ctx), 1, "engineer");
  await db.update(t.agent).set({ state: "waiting_lease" }).where(eq(t.agent.id, agent.id));
  await f.resource.create({ name: "echo", template: "echo ok" });
  const lease = await f.lease.create({ resource: "echo", grp_id: 1, agent_id: agent.id });

  await sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();
  // Again, against a lease that is already `done`. The job is what a restart
  // replays, so this is the ordinary case rather than a contrived one.
  await sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  const [wakes] = await db
    .select({ c: count() })
    .from(t.job)
    .where(
      and(eq(t.job.kind, "agent_turn"), eq(t.job.agent_id, agent.id), sql`${t.job.payload_json}::text LIKE '%runner%'`),
    );
  expect(wakes?.c).toBe(1);
});

test("finishLease rollback never fans a result whose wake job was not committed", async () => {
  const { db, ctx, sched, f } = await harness(async () => ok());
  const agent = await hire(harnessDeps(ctx), 1, "engineer");
  await db.update(t.agent).set({ state: "waiting_lease" }).where(eq(t.agent.id, agent.id));
  await f.resource.create({ name: "echo", template: "echo ok" });
  const lease = await f.lease.create({ resource: "echo", grp_id: 1, agent_id: agent.id });
  await sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  // The wake insert, made to fail. SQLite raised from the trigger body; Postgres
  // needs a plpgsql function, and `execute` carries one statement at a time.
  for (const statement of [
    `CREATE OR REPLACE FUNCTION fail_lease_wake() RETURNS trigger AS $fn$
       BEGIN RAISE EXCEPTION 'wake failure'; END $fn$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS fail_lease_wake ON job`,
    `CREATE TRIGGER fail_lease_wake BEFORE INSERT ON job FOR EACH ROW
       WHEN (NEW.kind = 'agent_turn') EXECUTE FUNCTION fail_lease_wake()`,
  ]) {
    await db.execute(sql.raw(statement));
  }
  const results: string[] = [];
  ctx.bus.subscribe((frame) => {
    if (frame.type === "event" && frame.kind === "lease_result") results.push(frame.body ?? "");
  });

  await sched.drain();
  await Promise.resolve();

  expect(results).toEqual([]);
  expect((await db.select({ n: count() }).from(t.event).where(eq(t.event.kind, "lease_result")))[0]?.n).toBe(0);
  expect((await db.select({ state: t.agent.state }).from(t.agent).where(eq(t.agent.id, agent.id)))[0]?.state).toBe(
    "waiting_lease",
  );
});

test("a lease whose args stopped validating fails instead of running", async () => {
  const { db, ctx, sched, f } = await harness(async () => ok());
  const agent = await hire(harnessDeps(ctx), 1, "engineer");
  await db.update(t.agent).set({ state: "waiting_lease" }).where(eq(t.agent.id, agent.id));
  await f.resource.create({
    name: "build",
    template: "make {target}",
    arg_schema_json: { target: { type: "enum", values: ["debug"] } },
  });
  // Queued when the enum still allowed it; the template changed underneath.
  const lease = await f.lease.create({
    resource: "build",
    grp_id: 1,
    agent_id: agent.id,
    args_json: { target: "release" },
  });
  await sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  expect((await db.select({ state: t.lease.state }).from(t.lease))[0]?.state).toBe("failed");
  await expectDurableLeaseWake(db, agent.id, "one of");
});

test("persisted lease arguments must be a flat object of supported scalars", async () => {
  const { db, ctx, sched, f } = await harness(async () => ok());
  const agent = await hire(harnessDeps(ctx), 1, "engineer");
  await db.update(t.agent).set({ state: "waiting_lease" }).where(eq(t.agent.id, agent.id));
  await f.resource.create({
    name: "build",
    template: "make {target}",
    arg_schema_json: { target: { type: "enum", values: ["release"] } },
  });
  const lease = await f.lease.create({
    resource: "build",
    grp_id: 1,
    agent_id: agent.id,
    args_json: { target: { nested: "release" } },
  });
  await sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  expect((await db.select({ state: t.lease.state }).from(t.lease).where(eq(t.lease.id, lease.id)))[0]?.state).toBe(
    "failed",
  );
  await expectDurableLeaseWake(db, agent.id, "flat JSON object of string, number, or boolean values");
});

test("cancelling a running lease aborts its sandbox command", async () => {
  const { db, ctx, sched, sandbox, f } = await harness(async () => ok());
  await f.resource.create({ name: "slow", template: "sleep 30" });
  const lease = await f.lease.create({ resource: "slow", grp_id: 1 });
  const started = Promise.withResolvers<void>();
  let resourceSignal: AbortSignal | undefined;
  ctx.sandbox = {
    ...sandbox,
    exec: async (_ctx, _scope, command, options) => {
      if (command.includes("rev-parse")) return { code: 0, out: "abc123\n", err: "" };
      resourceSignal = options?.signal;
      started.resolve();
      return await new Promise((resolve, reject) => {
        resourceSignal?.addEventListener("abort", () => reject(resourceSignal?.reason), { once: true });
      });
    },
  };

  const jobId = await sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.tick();
  await started.promise;
  expect(abortJob(jobId)).toBe(true);
  await sched.drain();

  expect(resourceSignal?.aborted).toBe(true);
  expect((await db.select({ state: t.job.state }).from(t.job).where(eq(t.job.id, jobId)))[0]?.state).toBe("failed");
});

test("a lease job without an integer id fails instead of disappearing", async () => {
  const { db, sched } = await harness(async () => ok());
  const job = await sched.enqueue("lease", { grp_id: 1 });
  await db
    .update(t.job)
    .set({ payload_json: { lease_id: "1" } })
    .where(eq(t.job.id, job));
  await sched.drain();
  const [row] = await db.select({ state: t.job.state, error: t.job.error }).from(t.job).where(eq(t.job.id, job));
  expect(row?.state).toBe("failed");
  expect(row?.error).toContain("invalid lease payload");
});

test("cacheRatio reports the only visible signal that caching still works", () => {
  expect(cacheRatio(ok())).toBeCloseTo(5000 / 5110, 3);
  expect(cacheRatio(ok({ usage: { input: 100, output: 5, cacheRead: 0, cacheCreate: 0, thinking: 0 } }))).toBe(0);
});

test("a turn records whether it opened a cold session, and what caused it", async () => {
  const { db, sched } = await harness(async () => ok());
  // `->>` is Postgres's json_extract: `meta_json` is jsonb and the key is read out
  // of it as text, so an absent key stays null rather than becoming "null".
  const reasons = async () =>
    (
      await db
        .select({ why: sql<string | null>`${t.event.meta_json} ->> 'rotate'` })
        .from(t.event)
        .where(eq(t.event.kind, "tool_summary"))
        .orderBy(asc(t.event.seq))
    ).map((r) => r.why);

  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer", rotate: true } });
  await sched.drain();

  // Null is the healthy case and has to stay distinguishable from the others: a
  // cache ratio alone cannot tell "the prefix moved" from "a send-back asked for
  // a clean head", and those have opposite fixes.
  expect(await reasons()).toEqual(["new", null, "explicit"]);
});

test("malformed persisted payloads fail before a turn starts", async () => {
  const { db, sched, specs } = await harness(async () => ok());
  const first = await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  // JSON `null`, not a SQL NULL: the column is jsonb NOT NULL, and what this test
  // stores is a valid JSON value the payload schema rejects.
  await db.update(t.job).set({ payload_json: sql`'null'::jsonb` }).where(eq(t.job.id, first));
  await sched.drain();
  expect(specs).toHaveLength(0);
  const [failed] = await db.select({ state: t.job.state, error: t.job.error }).from(t.job).where(eq(t.job.id, first));
  expect(failed?.state).toBe("failed");
  expect(failed?.error).toContain("invalid agent_turn payload");

  const second = await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await db
    .update(t.job)
    .set({ payload_json: { role: "engineer", rotate: "false", boundary: [null], mail: { from: 1 } } })
    .where(eq(t.job.id, second));
  await sched.drain();
  expect(specs).toHaveLength(0);
  expect((await db.select({ state: t.job.state }).from(t.job).where(eq(t.job.id, second)))[0]?.state).toBe("failed");
});

/** Minimal deps for calling `hire` directly. */
function harnessDeps(ctx: Ctx): ExecDeps {
  return {
    ctx,
    cfg: { ...loadConfig(), dataDir: "data" },
    roles: loadRoles("roles"),
  };
}

test("a woken agent is never handed an empty prompt", async () => {
  const { sched, specs } = await harness(async () => ok());
  // No payload, no slice, no unread: `claude -p` rejects an empty prompt outright,
  // so the turn would crash on something that is really a bug upstream.
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs[0]!.prompt.trim().length).toBeGreaterThan(0);
  expect(specs[0]!.prompt).toContain("orch task list");
});

test("a mailed message travels with the job, not via the channel cursor", async () => {
  const { sched, specs } = await harness(async () => ok());
  await sched.enqueue("agent_turn", {
    grp_id: null,
    payload: {
      role: "architect",
      mail: { from: "dispatcher", from_group: 1, intent: "ask", body: "objection to this split?" },
    },
  });
  await sched.drain();
  // A standing recipient is in nobody's channel, so the unread cursor would have
  // woken it with nothing to read.
  expect(specs[0]!.prompt).toContain("objection to this split?");
  expect(specs[0]!.prompt).toContain("orch mail dispatcher");
});

test("QA is handed the slice id and the exact command to file its verdict", async () => {
  const { sched, specs, f } = await harness(async () => ok());
  await f.slice.create({
    grp_id: 1,
    seq: 1,
    title: "S1",
    accept_spec: "greet zh works",
    difficulty: "trivial",
    status: "qa",
  });
  await sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "qa", review: 1 } });
  await sched.drain();

  // Giving an agent S1 when the verb takes a database id is the same mistake as
  // the task-id one: an identifier it cannot use.
  expect(specs[0]!.prompt).toContain("slice_id 1");
  expect(specs[0]!.prompt).toContain("orch review 1 --verdict");
});

test("an unknown persisted payload key fails before the executor sees it", async () => {
  const { db, sched } = await harness(async () => ok());
  const id = await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await db
    .update(t.job)
    .set({ payload_json: { role: "engineer", cutBoundary: 7 } })
    .where(eq(t.job.id, id));
  await sched.drain();

  const [job] = await db.select({ state: t.job.state, error: t.job.error }).from(t.job).where(eq(t.job.id, id));
  expect(job?.state).toBe("failed");
  expect(job?.error).toContain("cutBoundary");
});

test("invalid persisted payload fields fail together instead of being dropped", async () => {
  const { db, sched } = await harness(async () => ok());
  const id = await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await db
    .update(t.job)
    .set({
      payload_json: {
        role: "engineer",
        idea: 1,
        mail: { from: 1 },
        boundary: [null],
        digest: { channel_id: "1" },
        skills: [null],
      },
    })
    .where(eq(t.job.id, id));
  await sched.drain();

  const [job] = await db.select({ state: t.job.state, error: t.job.error }).from(t.job).where(eq(t.job.id, id));
  expect(job?.state).toBe("failed");
  for (const key of ["idea", "mail", "boundary", "digest", "skills"]) {
    expect(job?.error).toContain(key);
  }
});

test("the keys that are rendered do not trigger the warning", async () => {
  const { db, sched } = await harness(async () => ok());
  await sched.enqueue("agent_turn", {
    grp_id: 1,
    payload: { role: "engineer", rejection: "fix this", rotate: true },
  });
  await sched.drain();
  expect((await db.select({ c: count() }).from(t.event).where(like(t.event.body, "%nothing renders%")))[0]?.c).toBe(0);
});

test("the Architect is told which requirement belongs to which group", async () => {
  const { sched, specs, f } = await harness(async () => ok());
  await f.grp.create({ project_id: 1, name: "g2", status: "PLANNING" });
  await sched.enqueue("agent_turn", {
    grp_id: 1,
    payload: {
      role: "architect",
      boundary: [
        { id: 1, name: "greet-zh", idea: "greet 加中文支持" },
        { id: 2, name: "farewell", idea: "bye(name) 返回 goodbye X" },
      ],
    },
  });
  await sched.drain();

  const p = specs[0]!.prompt;
  // Without each group's own requirement, the Architect cannot tell them apart —
  // live, it handed the farewell group greet's files.
  expect(p).toContain("greet 加中文支持");
  expect(p).toContain("bye(name) 返回 goodbye X");
  expect(p).toContain("orch owns 1 --path");
  expect(p).toContain("orch owns 2 --path");
  // And the failure mode a files-only boundary causes.
  expect(p).toContain("not a list of files that already exist");
});

test("a session whose transcript is gone is not resumed forever", () => {
  // Live: composer-file-picker failed eight turns in a row on
  // `thread/resume: no rollout found for thread id 02627e60-…` and looked
  // healthy the whole time — an agent on the roster, no error anywhere except
  // inside a rejection body nobody parses.
  // Not every failure is this one: clearing a live session costs an uncached
  // prefix, so the match has to be the actual message.
  const matched = Object.fromEntries(
    [
      "Error: thread/resume: thread/resume failed: no rollout found for thread id 02627e60",
      "No conversation found with session ID: abc",
      "turn failed (max_turns): ...",
      "rebase failed: conflict in src/api.ts",
    ].map((line) => [line, LOST_SESSION.test(line)]),
  );
  expect(matched).toEqual({
    "Error: thread/resume: thread/resume failed: no rollout found for thread id 02627e60": true,
    "No conversation found with session ID: abc": true,
    "turn failed (max_turns): ...": false,
    "rebase failed: conflict in src/api.ts": false,
  });
});

test("the session id stored is the one the runtime actually used", async () => {
  // claude honours `--session-id <uuid>`, so minting one is correct there. codex
  // does not: `codex exec` starts a thread of its own and `codex exec resume`
  // wants THAT id. We stored the minted one, so every codex agent's second turn
  // ran `resume <our-uuid>` and died with `no rollout found for thread id …` —
  // thirty agents in the live database, not one of them holding a codex id.
  const { db, sched, specs } = await harness(async () => ok({ sessionId: "019ffb87-a288-7263-a7df-4b214098ae24" }));
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect((await db.select({ session_id: t.agent.session_id }).from(t.agent))[0]?.session_id).toBe(
    "019ffb87-a288-7263-a7df-4b214098ae24",
  );

  // And the next turn resumes with it, rather than with whatever we minted.
  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs.at(-1)!.resumeSessionId).toBe("019ffb87-a288-7263-a7df-4b214098ae24");
});
