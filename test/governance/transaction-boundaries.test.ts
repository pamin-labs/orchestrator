import { afterEach, expect, test } from "bun:test";
import { asc, count, eq, sql } from "drizzle-orm";
import { errText } from "../../src/platform/process/text.ts";
import type { Caller } from "../../src/http/agent-auth.ts";
import type { GrpState } from "../../src/contracts/states.ts";
import { postLease } from "../../src/api/orch/lease.ts";
import { postDraft } from "../../src/api/orch/planning.ts";
import { postTaskDone } from "../../src/api/orch/tasks.ts";
import { postEscalationRequirement } from "../../src/api/orch/escalation.ts";
import { postDraftDecision } from "../../src/api/panel/group.ts";
import { newGroup } from "../../src/mech/flow/newgroup.ts";
import { dropGroup } from "../../src/mech/flow/start.ts";
import { acceptSlice, handToQa } from "../../src/mech/flow/review.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import {
  agent,
  channel,
  escalation,
  event,
  grp,
  lease,
  job,
  note,
  slice,
  task,
} from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

const request = new Request("http://x/orch/v1/test", { method: "POST" });

async function seedGroup(status: GrpState = "RUNNING") {
  const ctx = await testContext();
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  const g = await f.grp.create({ project_id: p.id, name: "g1", status });
  await f.agent.create({ project_id: p.id, grp_id: g.id, token: "tok" });
  const caller: Caller = { id: 1, grp_id: 1, project_id: 1, role: "engineer" };
  return { ctx, caller };
}

/**
 * A write that fails at the database, as a trigger.
 *
 * SQLite spelled this `RAISE(ABORT, …)` inside the trigger body; Postgres has no
 * statement-level RAISE outside plpgsql, so the abort lives in a function the
 * trigger calls. `execute` carries one statement, hence the loop.
 */
const FAILING = ["event", "job", "channel"] as const;

async function failWrite(ctx: Ctx, table: (typeof FAILING)[number], on: "INSERT" | "UPDATE" = "INSERT"): Promise<void> {
  for (const statement of [
    `CREATE OR REPLACE FUNCTION fail_${table}() RETURNS trigger AS $fn$
       BEGIN RAISE EXCEPTION '${table} failure'; END $fn$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS fail_${table} ON ${table}`,
    `CREATE TRIGGER fail_${table} BEFORE ${on} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_${table}()`,
  ]) {
    await ctx.db.execute(sql.raw(statement));
  }
}

// One the test database serves the process and `TRUNCATE` does not drop a trigger, so a
// failure armed by one test would arm every test after it.
afterEach(async () => {
  const db = await openMemory();
  for (const table of FAILING) await db.execute(sql.raw(`DROP TRIGGER IF EXISTS fail_${table} ON ${table}`));
});

/**
 * The reason, however the driver nested it.
 *
 * `errText` and not `.message`: rc.4 wraps a driver error in a
 * `DrizzleQueryError` whose own message names the statement rather than the
 * reason, and puts the reason on `cause`. The bound is raised because that
 * wrapper's message is the whole INSERT — past `errText`'s 300 characters before
 * the cause it is joined to begins.
 */
async function failureOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return errText(error, 4_000);
  }
  throw new Error("expected operation to fail");
}

test("new group creation rolls back the group, channel, and note when its event fails", async () => {
  const ctx = await testContext();
  await fx.on(ctx.db).project.create({ name: "p" });
  await failWrite(ctx, "event");

  expect(await failureOf(newGroup(ctx, { projectId: 1, name: "g1", idea: "build it" }))).toContain("event failure");
  for (const table of [grp, channel, note, event]) {
    expect((await ctx.db.select({ n: count() }).from(table))[0]?.n).toBe(0);
  }
});

test("a rolled-back event never reaches subscribers, even when its seq is reused", async () => {
  const ctx = await testContext();
  const bodies: string[] = [];
  ctx.bus.subscribe((frame) => {
    if (frame.type === "event") bodies.push(frame.body ?? "");
  });

  // `bus.transaction`, not `db.transaction`: an emit through the outer handle
  // writes on another connection and outlives the rollback.
  expect(
    await failureOf(
      ctx.bus.transaction(async () => {
        await ctx.bus.emit({ author: "boss", kind: "state_change", body: "rolled back" });
        throw new Error("rollback");
      }),
    ),
  ).toContain("rollback");
  await ctx.bus.emit({ author: "boss", kind: "state_change", body: "committed" });
  await Promise.resolve();

  expect(bodies).toEqual(["committed"]);
  expect(await ctx.db.select({ body: event.body }).from(event)).toEqual([{ body: "committed" }]);
});

test("dropping a group is one transaction", async () => {
  const { ctx } = await seedGroup("RUNNING");
  const f = fx.on(ctx.db);
  await f.channel.create({ project_id: 1, grp_id: 1 });
  await f.escalation.create({
    grp_id: 1,
    severity: "blocker",
    brief: "q",
    kind: "decision",
    chain_state: "boss",
  });
  await ctx.sched.enqueue("agent_turn", { grp_id: 1 });
  await failWrite(ctx, "channel", "UPDATE");

  // What has to hold is that the reason reaches whoever is told, however the
  // library chooses to nest it — hence `errText` inside `failureOf`.
  expect(await failureOf(dropGroup(ctx, 1, "duplicate"))).toContain("channel failure");
  expect((await ctx.db.select({ status: grp.status }).from(grp))[0]?.status).toBe("RUNNING");
  expect((await ctx.db.select({ state: agent.state }).from(agent))[0]?.state).toBe("idle");
  expect((await ctx.db.select({ status: channel.status }).from(channel))[0]?.status).toBe("open");
  expect((await ctx.db.select({ state: job.state }).from(job))[0]?.state).toBe("pending");
  expect((await ctx.db.select({ chain_state: escalation.chain_state }).from(escalation))[0]?.chain_state).toBe("boss");
});

test("escalation-to-requirement rolls back the new group, driver, answer, and fanout", async () => {
  const { ctx } = await seedGroup("PAUSED");
  await fx.on(ctx.db).escalation.create({
    grp_id: 1,
    severity: "blocker",
    question: "fix config",
    brief: "fix",
    kind: "env",
    chain_state: "boss",
  });
  const frames: Array<{ type: string }> = [];
  ctx.bus.subscribe((frame) => frames.push(frame));
  await failWrite(ctx, "job");

  expect(
    await failureOf(postEscalationRequirement(ctx, request, { id: 1 }, { text: "do the work", name: "repair" })),
  ).toContain("job failure");
  await Promise.resolve();

  expect((await ctx.db.select({ n: count() }).from(grp))[0]?.n).toBe(1);
  expect((await ctx.db.select({ n: count() }).from(channel))[0]?.n).toBe(0);
  expect((await ctx.db.select({ n: count() }).from(note))[0]?.n).toBe(0);
  expect((await ctx.db.select({ n: count() }).from(event))[0]?.n).toBe(0);
  expect((await ctx.db.select({ answer: escalation.answer }).from(escalation))[0]?.answer).toBeNull();
  expect((await ctx.db.select({ blocked_on: grp.blocked_on }).from(grp))[0]?.blocked_on).toBeNull();
  expect(frames).toEqual([]);
});

test("draft rejection rolls back its fact, state, driver, and fanout", async () => {
  const { ctx } = await seedGroup("DRAFT");
  const frames: Array<{ type: string }> = [];
  ctx.bus.subscribe((frame) => frames.push(frame));
  await failWrite(ctx, "job");

  expect(
    await failureOf(postDraftDecision(ctx, request, { id: 1, decision: "reject" }, { reason: "wrong scope" })),
  ).toContain("job failure");
  await Promise.resolve();

  expect((await ctx.db.select({ status: grp.status }).from(grp))[0]?.status).toBe("DRAFT");
  expect((await ctx.db.select({ n: count() }).from(note))[0]?.n).toBe(0);
  expect((await ctx.db.select({ n: count() }).from(event))[0]?.n).toBe(0);
  expect(frames).toEqual([]);
});

test("filing a draft rolls back its note, state, and queue cancellation when its event fails", async () => {
  const { ctx, caller } = await seedGroup("PLANNING");
  caller.role = "dispatcher";
  await ctx.sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "dispatcher" } });
  await failWrite(ctx, "event");
  const card = `目标 : x
不做 : y
验收 : bun test 绿
验收 : 无回归
切片 : a [normal] — a.test.ts 绿
切片 : b [trivial] — b 的回归用例绿
切片 : c [hard] — 端到端场景通过
风险 : none
反对 : 无
名字 : atomic-draft`;

  expect(await failureOf(postDraft(ctx, request, caller, {}, { group_id: 1, card }))).toContain("event failure");
  expect((await ctx.db.select({ status: grp.status }).from(grp).where(eq(grp.id, 1)))[0]?.status).toBe("PLANNING");
  expect((await ctx.db.select({ n: count() }).from(note))[0]?.n).toBe(0);
  expect((await ctx.db.select({ state: job.state }).from(job))[0]?.state).toBe("pending");
});

test("requesting a lease rolls back the lease and waiting state when its job fails", async () => {
  const { ctx, caller } = await seedGroup();
  await fx.on(ctx.db).resource.create({ name: "build" });
  await failWrite(ctx, "job");

  expect(await failureOf(postLease(ctx, request, caller, {}, { resource: "build", args: {} }))).toContain(
    "job failure",
  );
  expect((await ctx.db.select({ n: count() }).from(lease))[0]?.n).toBe(0);
  expect((await ctx.db.select({ state: agent.state }).from(agent).where(eq(agent.id, 1)))[0]?.state).toBe("idle");
});

test("finishing a task rolls back the task, events, self gate, and slice when its driver job fails", async () => {
  const { ctx, caller } = await seedGroup();
  await fx.on(ctx.db).slice.create({ grp_id: 1, seq: 1, title: "S1", accept_spec: "tests pass", status: "running" });
  await fx.on(ctx.db).task.create({ grp_id: 1, slice_id: 1, title: "task" });
  await failWrite(ctx, "job");

  expect(
    await failureOf(
      postTaskDone(
        ctx,
        request,
        caller,
        {},
        {
          task_id: 1,
          claim: { files: ["src/a.ts"], summary: "implemented a" },
          review: "pass: tests pass — src/a.ts implements it",
        },
      ),
    ),
  ).toContain("job failure");
  expect((await ctx.db.select({ status: task.status }).from(task).where(eq(task.id, 1)))[0]?.status).toBe("pending");
  const [row] = await ctx.db
    .select({ status: slice.status, gates_json: slice.gates_json })
    .from(slice)
    .where(eq(slice.id, 1));
  expect(row?.status).toBe("running");
  // jsonb: the parsed value, not its text.
  expect(row?.gates_json).toEqual({});
  expect((await ctx.db.select({ n: count() }).from(event))[0]?.n).toBe(0);
  expect((await ctx.db.select({ n: count() }).from(job))[0]?.n).toBe(0);
});

test("review transitions do not expose a new state without its driver job", async () => {
  const { ctx } = await seedGroup();
  await fx.on(ctx.db).slice.create({ grp_id: 1, seq: 1, title: "S1", accept_spec: "tests pass", status: "gate" });
  await failWrite(ctx, "job");

  expect(await failureOf(handToQa({ ctx, cfg: ctx.config }, 1))).toContain("job failure");
  expect((await ctx.db.select({ status: slice.status }).from(slice).where(eq(slice.id, 1)))[0]?.status).toBe("gate");
});

test("accepting a slice rolls back acceptance and handoff when the next job fails", async () => {
  const { ctx } = await seedGroup();
  await fx.on(ctx.db).slice.create({ grp_id: 1, seq: 1, title: "S1", accept_spec: "one", status: "awaiting_boss" });
  await fx.on(ctx.db).slice.create({ grp_id: 1, seq: 2, title: "S2", accept_spec: "two", status: "pending" });
  await failWrite(ctx, "job");

  expect(await failureOf(acceptSlice(ctx, 1, "boss"))).toContain("job failure");
  const slices = await ctx.db.select({ status: slice.status }).from(slice).orderBy(asc(slice.seq));
  expect(slices.map((row) => row.status)).toEqual(["awaiting_boss", "pending"]);
  expect((await ctx.db.select({ n: count() }).from(event))[0]?.n).toBe(0);
  expect((await ctx.db.select({ n: count() }).from(note))[0]?.n).toBe(0);
});
