import { afterEach, expect, test } from "bun:test";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { asc, count, eq, like } from "drizzle-orm";
import type { GrpState } from "../../src/contracts/states.ts";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import * as tbl from "../../src/platform/persistence/schema.ts";
import { requestContext } from "../../src/platform/observability/request-context.ts";
import {
  AgentTurnPayloadSchema,
  reclaimOrphans,
  Scheduler,
  type Job,
} from "../../src/platform/scheduling/scheduler.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { z } from "zod";
import * as fx from "../support/factories.ts";

const LeaseJobPayload = z.object({ lease_id: z.number() });

async function seed(db: DB, groups: number, status: GrpState = "RUNNING"): Promise<number[]> {
  await seedAuth(db);
  const f = fx.on(db);
  const p = await f.project.create({ name: "p" });
  const ids: number[] = [];
  for (let i = 1; i <= groups; i++) {
    ids.push((await f.grp.create({ project_id: p.id, name: `g${i}`, status })).id);
  }
  return ids;
}

function idAt(ids: readonly number[], index: number): number {
  const id = ids[index];
  if (id === undefined) throw new Error(`fixture did not create group ${index + 1}`);
  return id;
}

/** Executor that blocks until released, so we can inspect mid-flight state. */
function gate() {
  let release!: () => void;
  const started: Job[] = [];
  const p = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    exec: async (job: Job) => {
      started.push(job);
      await p;
    },
  };
}

/**
 * Every scheduler a test makes, stopped when it ends.
 *
 * A finished job ticks from a detached `.finally`, so one nobody holds any more
 * keeps dispatching — and the tests in a file share one database, so what it
 * dispatches belongs to whichever test is running by then. That is an ordering
 * flake, and it is the reason `stop()` exists.
 */

const running: Scheduler[] = [];
const schedule = (...args: ConstructorParameters<typeof Scheduler>): Scheduler => {
  const made = new Scheduler(...args);
  running.push(made);
  return made;
};

afterEach(() => {
  for (const s of running.splice(0)) s.quiesce();
});

test("per-group concurrency is 1 — the group's single writer", async () => {
  const db = await openMemory();
  const [g] = await seed(db, 1);
  const g1 = g!;
  const { started, release, exec } = gate();
  const s = schedule(db, exec);
  await s.enqueue("agent_turn", { grp_id: g1 });
  await s.enqueue("agent_turn", { grp_id: g1 });
  await s.tick();

  expect(started.length).toBe(1);
  release();
  await s.drain();
  expect(started.length).toBe(2);
});

test("HTTP correlation survives the durable queue and becomes the event's parent trace", async () => {
  const db = await openMemory();
  {
    const group = (await seed(db, 1))[0]!;
    const bus = new Bus(db);
    const scheduler = schedule(db, async () => {
      await bus.emit({ grpId: group, author: "worker", kind: "state_change", body: "done" });
    });
    const jobId = await requestContext.run(
      {
        requestId: "request-correlation",
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        traceFlags: 1,
        method: "POST",
        path: "/api/v1/ideas",
      },
      async () => await scheduler.enqueue("agent_turn", { grp_id: group }),
    );

    expect(
      (
        await db
          .select({
            correlation_id: tbl.job.correlation_id,
            trace_id: tbl.job.trace_id,
            parent_span_id: tbl.job.parent_span_id,
          })
          .from(tbl.job)
          .where(eq(tbl.job.id, jobId))
      )[0],
    ).toEqual({ correlation_id: "request-correlation", trace_id: "a".repeat(32), parent_span_id: "b".repeat(16) });

    await scheduler.drain();
    const event = (await bus.latest(1))[0]!;
    expect(event.correlationId).toBe("request-correlation");
    expect(event.traceId).toBe("a".repeat(32));
    expect(event.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(event.spanId).not.toBe("b".repeat(16));
  }
});

test("a job enqueued off-request still carries a trace, and explicit ids win over the request", async () => {
  const db = await openMemory();
  {
    const group = (await seed(db, 1))[0]!;
    const scheduler = schedule(db, async () => {});

    // No request around the enqueue: the row still gets ids of its own, or a
    // queued turn is invisible to every trace that follows it.
    const off = await scheduler.enqueue("agent_turn", { grp_id: group });
    const offRow = (
      await db
        .select({
          correlation_id: tbl.job.correlation_id,
          trace_id: tbl.job.trace_id,
          parent_span_id: tbl.job.parent_span_id,
        })
        .from(tbl.job)
        .where(eq(tbl.job.id, off))
    )[0];
    expect(offRow?.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(offRow?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(offRow?.parent_span_id).toBeNull();

    // Explicit ids beat both the defaults and the ambient request: a resubmitted
    // job keeps the trace it was born with.
    const on = await requestContext.run(
      {
        requestId: "request-correlation",
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        traceFlags: 1,
        method: "POST",
        path: "/x",
      },
      async () =>
        await scheduler.enqueue("agent_turn", {
          grp_id: group,
          correlationId: "kept",
          traceId: "c".repeat(32),
          parentSpanId: "d".repeat(16),
        }),
    );
    expect(
      (
        await db
          .select({
            correlation_id: tbl.job.correlation_id,
            trace_id: tbl.job.trace_id,
            parent_span_id: tbl.job.parent_span_id,
          })
          .from(tbl.job)
          .where(eq(tbl.job.id, on))
      )[0],
    ).toEqual({ correlation_id: "kept", trace_id: "c".repeat(32), parent_span_id: "d".repeat(16) });
  }
});

test("an event with only author and kind stores empty, not invented, columns", async () => {
  // Every `?? null` in insert: an emitter that says little must not get the row
  // padded with placeholders the panel then has to distinguish from real values.
  const db = await openMemory();
  {
    const bus = new Bus(db);
    await bus.emit({ author: "worker", kind: "state_change" });
    expect(
      (
        await db
          .select({
            channel_id: tbl.event.channel_id,
            grp_id: tbl.event.grp_id,
            intent: tbl.event.intent,
            severity: tbl.event.severity,
            body: tbl.event.body,
            target: tbl.event.target,
            correlation_id: tbl.event.correlation_id,
          })
          .from(tbl.event)
      )[0],
    ).toEqual({
      channel_id: null,
      grp_id: null,
      intent: null,
      severity: null,
      body: "",
      target: null,
      correlation_id: null,
    });
  }
});

test("maxGroups caps how many groups run at once", async () => {
  const db = await openMemory();
  const ids = await seed(db, 5);
  const { started, release, exec } = gate();
  const s = schedule(db, exec, { maxGroups: 3 });
  for (const id of ids) await s.enqueue("agent_turn", { grp_id: id });
  await s.tick();

  expect(started.length).toBe(3);
  release();
  await s.drain();
  expect(started.length).toBe(5);
});

test("leases use their own pool and do not consume group slots", async () => {
  const db = await openMemory();
  const ids = await seed(db, 3);
  await fx.on(db).resource.create({ name: "build", template: "echo build" });
  const { started, release, exec } = gate();
  const s = schedule(db, exec, { maxGroups: 3, leaseSlots: 1 });
  for (const id of ids) await s.enqueue("agent_turn", { grp_id: id });
  await s.enqueue("lease", { grp_id: idAt(ids, 0) });
  await s.enqueue("lease", { grp_id: idAt(ids, 1) });
  await s.tick();

  // 3 turns + 1 lease; the second lease waits on the Runner pool, not on groups.
  expect(started.length).toBe(4);
  expect(started.filter((j) => j.kind === "lease").length).toBe(1);
  release();
  await s.drain();
  expect(started.filter((j) => j.kind === "lease").length).toBe(2);
});

test("a tagged resource draws from its own pool, so one browser cannot stall every gate", async () => {
  const db = await openMemory();
  const ids = await seed(db, 3);
  await fx.on(db).resource.create({ name: "browser", template: "echo b", tags_json: ["browser"] });
  await fx.on(db).resource.create({ name: "typecheck", template: "echo t" });
  const mk = async (resource: string, grp: number) => (await fx.on(db).lease.create({ resource, grp_id: grp })).id;

  const { started, release, exec } = gate();
  const s = schedule(db, exec, { maxGroups: 3, leaseSlots: { default: 2, browser: 1 } });
  for (const g of ids) await s.enqueue("lease", { grp_id: g, payload: { lease_id: await mk("browser", g) } });
  for (const g of ids) await s.enqueue("lease", { grp_id: g, payload: { lease_id: await mk("typecheck", g) } });
  await s.tick();

  // One browser (its pool is 1) and two typechecks (the default pool is 2). The
  // point of splitting: sized for the browser, a global pool would have let one
  // screenshot hold up every gate in the fleet.
  expect(started.length).toBe(3);
  release();
  await s.drain();
  expect(started.length).toBe(6);
});

test("legacy resource tags with the wrong JSON shape fall back to the default pool", async () => {
  const db = await openMemory();
  const grp = idAt(await seed(db, 1), 0);
  await fx.on(db).resource.create({ name: "build", template: "echo build", tags_json: "repo" });
  const lease = await fx.on(db).lease.create({ resource: "build", grp_id: grp });
  const ran: Job[] = [];
  const scheduler = schedule(db, async (job) => void ran.push(job));

  await scheduler.enqueue("lease", { grp_id: grp, payload: { lease_id: lease.id } });
  await scheduler.tick();
  await scheduler.drain();

  expect(ran).toHaveLength(1);
});

test("non-RUNNING group status is a barrier — this IS intercept L2", async () => {
  const db = await openMemory();
  const [g] = await seed(db, 1, "PAUSED");
  const g1 = g!;
  const ran: Job[] = [];
  const s = schedule(db, async (j) => void ran.push(j));
  await s.enqueue("agent_turn", { grp_id: g1 });
  await s.drain();
  expect(ran.length).toBe(0);

  await db.update(tbl.grp).set({ status: "RUNNING" }).where(eq(tbl.grp.id, g1));
  await s.drain();
  expect(ran.length).toBe(1);
});

test("DRAFT stops the writers, not the planners", async () => {
  // A refused approval enqueues an Architect turn to cut the boundary — and the
  // group it enqueues it on is the one sitting in DRAFT. Blocking every role there
  // meant the boundary was never cut, so the approval never landed and the boss was
  // told to click again. Three groups were holding a job like this at once.
  const db = await openMemory();
  const [g] = await seed(db, 1, "DRAFT");
  const g1 = g!;
  const ran: Job[] = [];
  const s = schedule(db, async (j) => void ran.push(j));
  await s.enqueue("agent_turn", { grp_id: g1, payload: { role: "engineer" } });
  await s.drain();
  expect(ran.length).toBe(0);

  await s.enqueue("agent_turn", { grp_id: g1, payload: { role: "architect" } });
  await s.drain();
  expect(ran.map((j) => AgentTurnPayloadSchema.parse(j.payload).role)).toEqual(["architect"]);
});

test("exhausted slice budget blocks dispatch before the group budget does", async () => {
  const db = await openMemory();
  const [g] = await seed(db, 1);
  const g1 = g!;
  const sl = await fx.on(db).slice.create({
    grp_id: 1,
    seq: 1,
    title: "S1",
    accept_spec: "tests pass",
    budget_tokens: 1000,
    spent_tokens: 1000,
  });
  const ran: Job[] = [];
  const s = schedule(db, async (j) => void ran.push(j));
  await s.enqueue("agent_turn", { grp_id: g1, slice_id: sl.id });
  await s.drain();
  expect(ran.length).toBe(0);

  await db.update(tbl.slice).set({ budget_tokens: 5000 }).where(eq(tbl.slice.id, sl.id));
  await s.drain();
  expect(ran.length).toBe(1);
});

test("watchdog and notify bypass the group slot pool", async () => {
  const db = await openMemory();
  const [g] = await seed(db, 1);
  const g1 = g!;
  const { started, release, exec } = gate();
  const s = schedule(db, exec, { maxGroups: 1 });
  await s.enqueue("agent_turn", { grp_id: g1 });
  await s.enqueue("watchdog", { grp_id: g1 });
  await s.enqueue("notify", { grp_id: g1 });
  await s.tick();

  // Housekeeping must never be starved by a busy group, or the watchdog can
  // never fire on the very group that is stuck.
  expect(started.length).toBe(3);
  release();
  await s.drain();
});

test("a job never stays in `running` — success and failure both settle", async () => {
  const db = await openMemory();
  const [g] = await seed(db, 1);
  const g1 = g!;
  let first = true;
  const s = schedule(db, async () => {
    if (first) {
      first = false;
      throw new Error("boom");
    }
  });
  await s.enqueue("agent_turn", { grp_id: g1 });
  await s.enqueue("agent_turn", { grp_id: g1 });
  await s.drain();

  const states = await db.select({ state: tbl.job.state, error: tbl.job.error }).from(tbl.job).orderBy(asc(tbl.job.id));
  expect(states.map((r) => r.state)).toEqual(["failed", "done"]);
  expect(states[0]!.error).toContain("boom");
  expect((await db.select({ c: count() }).from(tbl.job).where(eq(tbl.job.state, "running")))[0]?.c).toBe(0);
});

test("cancelPending drops queued work but leaves the in-flight job alone (park)", async () => {
  const db = await openMemory();
  const [g] = await seed(db, 1);
  const g1 = g!;
  const { started, release, exec } = gate();
  const s = schedule(db, exec);
  await s.enqueue("agent_turn", { grp_id: g1 });
  await s.enqueue("agent_turn", { grp_id: g1 });
  await s.enqueue("agent_turn", { grp_id: g1 });
  await s.tick();
  expect(started.length).toBe(1);

  expect(await s.cancelPending(g1, "parked")).toBe(2);
  release();
  await s.drain();

  expect(started.length).toBe(1);
  const cancelled = (await db.select({ c: count() }).from(tbl.job).where(eq(tbl.job.state, "cancelled")))[0]?.c;
  expect(cancelled).toBe(2);
});

test("higher priority dispatches first", async () => {
  const db = await openMemory();
  const ids = await seed(db, 2);
  const { started, release, exec } = gate();
  const s = schedule(db, exec, { maxGroups: 1 });
  await s.enqueue("agent_turn", { grp_id: idAt(ids, 0), priority: 0 });
  await s.enqueue("agent_turn", { grp_id: idAt(ids, 1), priority: 10 });
  await s.tick();
  expect(started[0]!.grp_id).toBe(idAt(ids, 1));
  release();
  await s.drain();
});

test("a standing agent's turn takes a slot like anyone else's", async () => {
  const db = await openMemory();
  await seed(db, 1);
  const { started, release, exec } = gate();
  const s = schedule(db, exec, { maxGroups: 1 });
  await s.enqueue("agent_turn", { grp_id: null, payload: { role: "librarian" } });
  await s.enqueue("agent_turn", { grp_id: 1 });
  await s.tick();

  // A standing turn costs the same money and CPU as a group's, so bypassing the
  // pool would make a concurrency limit meaningless.
  expect(started.length).toBe(1);
  release();
  await s.drain();
  expect(started.length).toBe(2);
});

/** Two standing agents, no group between them. Returns their ids. */
async function standing(db: DB, ...roles: string[]): Promise<number[]> {
  const f = fx.on(db);
  const ids: number[] = [];
  for (const role of roles) ids.push((await f.agent.create({ project_id: 1, role, state: "idle" })).id);
  return ids;
}

test("two standing agents run at once — they share nothing", async () => {
  const db = await openMemory();
  await seed(db, 1);
  const standingIds = await standing(db, "librarian", "architect");
  const lib = idAt(standingIds, 0);
  const arch = idAt(standingIds, 1);
  const { started, release, exec } = gate();
  const s = schedule(db, exec, { maxGroups: 3 });
  await s.enqueue("agent_turn", { grp_id: null, agent_id: lib, payload: { role: "librarian" } });
  await s.enqueue("agent_turn", { grp_id: null, agent_id: arch, payload: { role: "architect" } });
  await s.tick();

  // These four roles used to collapse onto one slot keyed 0, so Architect waited
  // for Librarian for no reason anyone could name: measured 4309s of queueing for
  // the Dispatcher, 1752s for the CoS, on turns that touch no common state. The
  // slot is per agent now; the cost ceiling is still `maxGroups`, below.
  expect(started.length).toBe(2);
  release();
  await s.drain();
});

test("one standing agent still writes one transcript at a time", async () => {
  const db = await openMemory();
  await seed(db, 1);
  const lib = idAt(await standing(db, "librarian"), 0);
  const { started, release, exec } = gate();
  const s = schedule(db, exec, { maxGroups: 3 });
  await s.enqueue("agent_turn", { grp_id: null, agent_id: lib });
  await s.enqueue("agent_turn", { grp_id: null, agent_id: lib });
  await s.tick();
  expect(started.length).toBe(1);
  release();
  await s.drain();
  expect(started.length).toBe(2);
});

test("standing turns still count against maxGroups", async () => {
  const db = await openMemory();
  await seed(db, 1);
  const standingIds = await standing(db, "librarian", "architect");
  const lib = idAt(standingIds, 0);
  const arch = idAt(standingIds, 1);
  const { started, release, exec } = gate();
  const s = schedule(db, exec, { maxGroups: 1 });
  await s.enqueue("agent_turn", { grp_id: null, agent_id: lib });
  await s.enqueue("agent_turn", { grp_id: null, agent_id: arch });
  await s.tick();
  expect(started.length).toBe(1);
  release();
  await s.drain();
  expect(started.length).toBe(2);
});

test("maxGroups 0 means nothing runs at all", async () => {
  const db = await openMemory();
  await seed(db, 1);
  const ran: Job[] = [];
  const s = schedule(db, async (j) => void ran.push(j), { maxGroups: 0 });
  await s.enqueue("agent_turn", { grp_id: 1 });
  await s.enqueue("agent_turn", { grp_id: null });
  await s.drain();
  expect(ran.length).toBe(0);
});

test("a turn left running by a dead server is reclaimed, not left holding the slot", async () => {
  const db = await openMemory();
  await seed(db, 1);
  await fx.on(db).agent.create({ project_id: 1, grp_id: 1, role: "qa", state: "running" });
  // Started just now, so what identifies the orphan is that nothing is reading
  // the turn, rather than the age check.
  await fx.on(db).job.create({ grp_id: 1, state: "running", started_at: Date.now() });
  await fx.on(db).job.create({ kind: "reconcile", grp_id: 1, state: "pending" });

  const { reclaimOrphans } = await import("../../src/platform/scheduling/scheduler.ts");
  // Nobody is holding this turn's stream: the previous server exited mid-turn.
  expect(await reclaimOrphans(db, { alive: () => false })).toHaveLength(1);

  const [j] = await db.select({ error: tbl.job.error }).from(tbl.job).where(eq(tbl.job.id, 1));
  expect(j?.error).toContain("nothing is reading this turn");
  // The agent believed it was mid-turn too, and a running agent is skipped forever.
  expect((await db.select({ state: tbl.agent.state }).from(tbl.agent))[0]?.state).toBe("idle");

  // And the queue moves again — which it never would have while the slot was held.
  const ran: Job[] = [];
  await schedule(db, async (job) => void ran.push(job)).drain();
  expect(ran.map((r) => r.kind)).toEqual(["reconcile"]);
});

test("a live process is left alone", async () => {
  const db = await openMemory();
  await seed(db, 1);
  await fx.on(db).job.create({ grp_id: 1, state: "running", pid: 4242, started_at: Date.now() });
  expect(await reclaimOrphans(db, { alive: () => true })).toHaveLength(0);
  expect((await db.select({ state: tbl.job.state }).from(tbl.job))[0]?.state).toBe("running");
});

test("a job with no pid, or one running impossibly long, is also an orphan", async () => {
  const db = await openMemory();
  await seed(db, 1);
  await fx.on(db).job.create({ grp_id: 1, state: "running", started_at: 0 });
  await fx.on(db).job.create({ grp_id: 1, state: "running", pid: 1, started_at: 0 });
  // Never recorded a pid, and still "running" long past any turn's limit.
  expect(await reclaimOrphans(db, { alive: () => true, maxAgeMs: 1000, now: () => 10_000_000 })).toHaveLength(2);
});

test("a restart resumes the turn it interrupted, but only once", async () => {
  const db = await openMemory();
  await seed(db, 1);
  await fx.on(db).slice.create({ grp_id: 1, seq: 1, title: "t", accept_spec: "a", status: "running" });
  await fx.on(db).job.create({
    grp_id: 1,
    slice_id: 1,
    payload_json: { role: "engineer" },
    state: "running",
    pid: 89992,
    started_at: 0,
  });
  // The timer re-adds these itself; resuming them would just double them up.
  await fx.on(db).job.create({ kind: "watchdog", state: "running", pid: 89992, started_at: 0 });

  const { reclaimOrphans, resumeReclaimed } = await import("../../src/platform/scheduling/scheduler.ts");
  const sched = schedule(db, async () => {});
  expect(await resumeReclaimed(sched, await reclaimOrphans(db, { alive: () => false }))).toBe(1);

  const back = await db
    .select({ kind: tbl.job.kind, slice_id: tbl.job.slice_id, payload_json: tbl.job.payload_json })
    .from(tbl.job)
    .where(eq(tbl.job.state, "pending"));
  expect(back).toHaveLength(1);
  expect(back[0]!.slice_id).toBe(1);
  // `payload_json` is jsonb, so it arrives parsed; the schema still decides.
  expect(AgentTurnPayloadSchema.parse(back[0]!.payload_json).role).toBe("engineer");

  // A second restart still resumes it: the server going away is not this turn's
  // doing, and spending its one chance on that left six groups stopped after a
  // restart with the fix for what broke them already in main.
  await db.update(tbl.job).set({ state: "running", pid: 89992, started_at: 0 }).where(eq(tbl.job.state, "pending"));
  expect(await resumeReclaimed(sched, await reclaimOrphans(db, { alive: () => false }))).toBe(1);

  // But a turn that failed on its own is resumed once and no more — that is what
  // the guard is for.
  await db
    .update(tbl.job)
    .set({ state: "failed", error: "turn failed (max_turns)" })
    .where(eq(tbl.job.state, "pending"));
  const own = await db
    .select({
      id: tbl.job.id,
      kind: tbl.job.kind,
      grp_id: tbl.job.grp_id,
      agent_id: tbl.job.agent_id,
      slice_id: tbl.job.slice_id,
      payload_json: tbl.job.payload_json,
      priority: tbl.job.priority,
      state: tbl.job.state,
      error: tbl.job.error,
    })
    .from(tbl.job)
    .where(like(tbl.job.error, "turn failed%"));
  expect(await resumeReclaimed(sched, own)).toBe(0);
});

test("two gates of one repo do not run at once, but two repos still do", async () => {
  const db = await openMemory();
  const { release, exec } = gate();
  const sched = schedule(db, exec);
  for (const [id, name] of [
    [1, "a"],
    [2, "b"],
  ] as const) {
    await fx.on(db).project.create({ id, name, repo_path: `/${name}` });
  }
  for (const [id, project_id, name] of [
    [1, 1, "g1"],
    [2, 1, "g1b"],
    [3, 2, "g2"],
  ] as const) {
    await fx.on(db).runningGrp.create({ id, project_id, name });
  }
  for (const [name, template] of [
    ["build", "x"],
    ["typecheck", "y"],
  ] as const) {
    await fx.on(db).resource.create({ name, template, concurrency: 1, tags_json: ["repo"] });
  }
  const lease = async (id: number, resource: string, grp: number) => {
    await fx.on(db).lease.create({ id, resource, grp_id: grp, state: "queued" });
    await sched.enqueue("lease", { grp_id: grp, payload: { lease_id: id } });
  };
  // Concurrency is per resource, so build and typecheck ran side by side — and
  // both shell out to the project's own scripts, which install into a
  // node_modules every worktree of that repo shares. One came back `Failed to
  // link jiti: EEXIST` and the group read it as its own build being broken.
  await lease(1, "build", 1);
  await lease(2, "typecheck", 2);
  await lease(3, "build", 3);
  await sched.tick();

  const inflight = (
    await db.select({ payload_json: tbl.job.payload_json }).from(tbl.job).where(eq(tbl.job.state, "running"))
  ).map((row) => LeaseJobPayload.parse(row.payload_json).lease_id);
  expect(inflight).toContain(1);
  // Same repo, different group, different gate: still waits.
  expect(inflight).not.toContain(2);
  // Another repo has nothing to race over.
  expect(inflight).toContain(3);
  release();
});

test("the per-repo gate pool is one, whatever the default lease slots are", async () => {
  // The test above passes `schedule(db, exec)`, so `poolSizes(undefined)` is
  // `{default: 1}` and a `repo:<id>` pool resolves to 1 by accident. The shipped
  // config is `{default: 2, browser: 1}` (load.ts:107), nothing sets a `repo` key,
  // and `claimLeaseCapacity` falls back to `default` — so in production two gates
  // of one repo ran side by side, which is exactly what start.ts:222 says the tag
  // exists to make structurally impossible.
  const db = await openMemory();
  const { release, exec } = gate();
  const sched = schedule(db, exec, { leaseSlots: { default: 2, browser: 1 } });
  await fx.on(db).project.create({ id: 1, name: "a", repo_path: "/a" });
  await fx.on(db).runningGrp.create({ id: 1, project_id: 1, name: "g1" });
  await fx.on(db).runningGrp.create({ id: 2, project_id: 1, name: "g1b" });
  for (const [name, template] of [
    ["build", "x"],
    ["typecheck", "y"],
  ] as const) {
    await fx.on(db).resource.create({ name, template, concurrency: 1, tags_json: ["repo"] });
  }
  for (const [id, resource, grp] of [
    [1, "build", 1],
    [2, "typecheck", 2],
  ] as const) {
    await fx.on(db).lease.create({ id, resource, grp_id: grp, state: "queued" });
    await sched.enqueue("lease", { grp_id: grp, payload: { lease_id: id } });
  }
  await sched.tick();

  const inflight = (
    await db.select({ payload_json: tbl.job.payload_json }).from(tbl.job).where(eq(tbl.job.state, "running"))
  ).map((row) => LeaseJobPayload.parse(row.payload_json).lease_id);
  expect(inflight).toEqual([1]);
  release();
});

test("a finished job dispatches what it queued, without anyone remembering to", async () => {
  // Sixteen `enqueue` sites had no `tick()` after them, and the omission looked
  // exactly like the deliberate ones — both waited for the watchdog timer, up to
  // watchdogIntervalMs, on work whose whole point was that something noticed it
  // was stuck. The watchdog is itself a job, so its own sweep queued into that
  // wait too.
  const db = await openMemory();
  await seed(db, 1);
  const started: number[] = [];
  const s = schedule(db, async (j) => {
    started.push(j.id);
    // What a turn does at its end and then does not dispatch.
    if (started.length === 1) await s.enqueue("reconcile", { grp_id: 1 });
  });
  await s.enqueue("agent_turn", { grp_id: 1 });
  await s.tick();

  // The follow-up ran without a second tick from anywhere. Waited for, not slept
  // on: dispatch does real I/O now, so "one macrotask" stopped being long enough
  // and the sleep became a measurement of the day's scheduling. `drain()` would
  // defeat the test — the claim is that nobody had to ask.
  const deadline = Date.now() + 5_000;
  while (started.length < 2 && Date.now() < deadline) await Bun.sleep(1);
  expect(started.length).toBe(2);
  expect((await db.select({ c: count() }).from(tbl.job).where(eq(tbl.job.state, "pending")))[0]?.c).toBe(0);
});

test("staging a batch still dispatches it in priority order", async () => {
  // Why the tick is on completion and not inside `enqueue`: an enqueue that
  // dispatched on the spot would send the first job before the second exists,
  // and priority across a batch is what the sweep and startGroup rely on.
  const db = await openMemory();
  const ids = await seed(db, 2);
  const order: (number | null)[] = [];
  const s = schedule(db, async (j) => void order.push(j.grp_id));
  await s.enqueue("agent_turn", { grp_id: idAt(ids, 0), priority: 0 });
  await s.enqueue("agent_turn", { grp_id: idAt(ids, 1), priority: 10 });
  await s.tick();
  expect(order[0]).toBe(idAt(ids, 1));
});

/**
 * The sampling decision travels with the job.
 *
 * `startChildTrace` rebuilt a job's parent context with `TraceFlags.SAMPLED` written
 * out, because the row carried the trace id and the span id and nothing else — so a
 * job enqueued by a request the sampler had dropped came back sampled, and every span
 * under it with it. The same defect the outgoing header had, one layer in.
 *
 * A job with no ambient request records nothing and reads as sampled.
 */
test("a job records the sampling decision of the request that enqueued it", async () => {
  const db = await openMemory();
  const group = (await seed(db, 1))[0]!;
  const scheduler = schedule(db, async () => {});

  const dropped = await requestContext.run(
    {
      requestId: "r",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 0,
      method: "POST",
      path: "/x",
    },
    async () => await scheduler.enqueue("agent_turn", { grp_id: group }),
  );
  const own = await scheduler.enqueue("agent_turn", { grp_id: group });

  const flags = async (id: number) =>
    (await db.select({ trace_flags: tbl.job.trace_flags }).from(tbl.job).where(eq(tbl.job.id, id)))[0]?.trace_flags;
  expect({ dropped: await flags(dropped), noRequest: await flags(own) }).toEqual({ dropped: 0, noRequest: null });
});

/**
 * A group that has spent its budget stops being dispatched.
 *
 * This is the only place the ceiling is enforced — the panel shows the number, and
 * `hasBudget` is what stops the work. Removing it entirely left the suite green:
 * every test naming `budget_tokens` was a rendering test.
 *
 * Overspending is not visible from the outside. The group keeps its status, keeps
 * its agent, and keeps costing money, which is the failure this guards.
 */
test("a group over its budget is not dispatched", async () => {
  const db = await openMemory();
  const [group] = await seed(db, 1);
  const ran: number[] = [];
  const scheduler = schedule(db, async (job) => void ran.push(job.id));

  await db.update(tbl.grp).set({ budget_tokens: 1000, spent_tokens: 1000 }).where(eq(tbl.grp.id, group!));
  await scheduler.enqueue("agent_turn", { grp_id: group! });
  await scheduler.tick();
  expect(ran).toEqual([]);

  // Raising the ceiling releases it: the gate is the comparison, not a latch.
  await db.update(tbl.grp).set({ budget_tokens: 2000 }).where(eq(tbl.grp.id, group!));
  await scheduler.tick();
  expect(ran).toHaveLength(1);
});

/**
 * No budget set means no ceiling, which is what a fresh group has.
 *
 * `budget_tokens` is nullable and null is the default. Reading null as zero would
 * stop every group that had never been given one — that is, all of them.
 */
test("a group with no budget set is not treated as having spent it", async () => {
  const db = await openMemory();
  const [group] = await seed(db, 1);
  const ran: number[] = [];
  const scheduler = schedule(db, async (job) => void ran.push(job.id));

  await db.update(tbl.grp).set({ budget_tokens: null, spent_tokens: 999999 }).where(eq(tbl.grp.id, group!));
  await scheduler.enqueue("agent_turn", { grp_id: group! });
  await scheduler.tick();
  expect(ran).toHaveLength(1);
});

/**
 * A slice has its own ceiling, so overspend is caught at the slice rather than the
 * group.
 *
 * A group's budget is the sum of what its slices may spend, so waiting for the group
 * to exceed means one runaway slice spends the others' allowance first — and the
 * slices that had not started are the ones that pay.
 */
test("a slice over its own budget stops even while its group has room", async () => {
  const db = await openMemory();
  const [group] = await seed(db, 1);
  const slice = await fx.on(db).slice.create({ grp_id: group!, budget_tokens: 100, spent_tokens: 100 });
  const ran: number[] = [];
  const scheduler = schedule(db, async (job) => void ran.push(job.id));

  await db.update(tbl.grp).set({ budget_tokens: 1000000, spent_tokens: 0 }).where(eq(tbl.grp.id, group!));
  await scheduler.enqueue("agent_turn", { grp_id: group!, slice_id: slice.id });
  await scheduler.tick();
  expect(ran).toEqual([]);
});

/**
 * `drain()` returns when the queue is drained, not when one sweep is.
 *
 * Dispatch became asynchronous while the "a tick is already running, return"
 * guard kept its shape, so a finished job ticking from its own detached chain
 * made `drain`'s next tick a no-op — and `drain` returned with a dispatchable
 * job still `pending`. The boss sees a card that never starts and the log says
 * nothing: a skipped job and a queued one are the same row.
 */
test("drain returns only once nothing is dispatchable, however the ticks interleave", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  await f.runtimeAuth.create({});
  const group = await f.runningGrp.create({});

  const ran: number[] = [];
  const scheduler = schedule(db, async (job) => {
    ran.push(job.id);
  });
  // Same group, so the second waits for the first's slot: it can only be
  // dispatched by a tick that runs after the first job has settled.
  const first = await scheduler.enqueue("agent_turn", { grp_id: group.id });
  const second = await scheduler.enqueue("agent_turn", { grp_id: group.id });

  await scheduler.drain();

  expect(ran).toEqual([first, second]);
});
