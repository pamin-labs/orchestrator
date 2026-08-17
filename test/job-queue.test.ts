import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { openMemory, type DB } from "../src/db.ts";
import { requestContext } from "../src/platform/observability/request-context.ts";
import { AgentTurnPayloadSchema, reclaimOrphans, Scheduler, type Job } from "../src/scheduler.ts";
import { seedAuth } from "./seed-auth.ts";
import { z } from "zod";

const LeaseJobPayload = z.object({ lease_id: z.number() });

function seed(db: DB, groups: number, status = "RUNNING"): number[] {
  seedAuth(db);
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

test("HTTP correlation survives the durable queue and becomes the event's parent trace", async () => {
  const db = openMemory();
  try {
    const group = seed(db, 1)[0]!;
    const bus = new Bus(db);
    const scheduler = new Scheduler(db, async () => {
      bus.emit({ grpId: group, author: "worker", kind: "state_change", body: "done" });
    });
    const jobId = requestContext.run(
      {
        requestId: "request-correlation",
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        method: "POST",
        path: "/api/v1/ideas",
      },
      () => scheduler.enqueue("agent_turn", { grp_id: group }),
    );

    expect(
      db
        .query<{ correlation_id: string; trace_id: string; parent_span_id: string }, [number]>(
          "SELECT correlation_id, trace_id, parent_span_id FROM job WHERE id = ?",
        )
        .get(jobId),
    ).toEqual({ correlation_id: "request-correlation", trace_id: "a".repeat(32), parent_span_id: "b".repeat(16) });

    await scheduler.drain();
    const event = bus.latest(1)[0]!;
    expect(event.correlationId).toBe("request-correlation");
    expect(event.traceId).toBe("a".repeat(32));
    expect(event.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(event.spanId).not.toBe("b".repeat(16));
  } finally {
    db.close();
  }
});

test("a job enqueued off-request still carries a trace, and explicit ids win over the request", () => {
  const db = openMemory();
  try {
    const group = seed(db, 1)[0]!;
    const scheduler = new Scheduler(db, async () => {});

    // No request around the enqueue: the row still gets ids of its own, or a
    // queued turn is invisible to every trace that follows it.
    const off = scheduler.enqueue("agent_turn", { grp_id: group });
    const offRow = db
      .query<{ correlation_id: string; trace_id: string; parent_span_id: string | null }, [number]>(
        "SELECT correlation_id, trace_id, parent_span_id FROM job WHERE id = ?",
      )
      .get(off)!;
    expect(offRow.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(offRow.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(offRow.parent_span_id).toBeNull();

    // Explicit ids beat both the defaults and the ambient request: a resubmitted
    // job keeps the trace it was born with.
    const on = requestContext.run(
      { requestId: "request-correlation", traceId: "a".repeat(32), spanId: "b".repeat(16), method: "POST", path: "/x" },
      () =>
        scheduler.enqueue("agent_turn", {
          grp_id: group,
          correlationId: "kept",
          traceId: "c".repeat(32),
          parentSpanId: "d".repeat(16),
        }),
    );
    expect(
      db
        .query<{ correlation_id: string; trace_id: string; parent_span_id: string }, [number]>(
          "SELECT correlation_id, trace_id, parent_span_id FROM job WHERE id = ?",
        )
        .get(on),
    ).toEqual({ correlation_id: "kept", trace_id: "c".repeat(32), parent_span_id: "d".repeat(16) });
  } finally {
    db.close();
  }
});

test("an event with only author and kind stores empty, not invented, columns", () => {
  // Every `?? null` in insert: an emitter that says little must not get the row
  // padded with placeholders the panel then has to distinguish from real values.
  const db = openMemory();
  try {
    const bus = new Bus(db);
    bus.emit({ author: "worker", kind: "state_change" });
    expect(
      db
        .query<
          {
            channel_id: number | null;
            grp_id: number | null;
            intent: string | null;
            severity: string | null;
            body: string;
            target: string | null;
            correlation_id: string | null;
          },
          []
        >("SELECT channel_id, grp_id, intent, severity, body, target, correlation_id FROM event")
        .get(),
    ).toEqual({
      channel_id: null,
      grp_id: null,
      intent: null,
      severity: null,
      body: "",
      target: null,
      correlation_id: null,
    });
  } finally {
    db.close();
  }
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
  db.run("INSERT INTO resource (name, template) VALUES ('build', 'echo build')");
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 3, leaseSlots: 1 });
  for (const id of ids) s.enqueue("agent_turn", { grp_id: id });
  s.enqueue("lease", { grp_id: idAt(ids, 0) });
  s.enqueue("lease", { grp_id: idAt(ids, 1) });
  s.tick();

  // 3 turns + 1 lease; the second lease waits on the Runner pool, not on groups.
  expect(started.length).toBe(4);
  expect(started.filter((j) => j.kind === "lease").length).toBe(1);
  release();
  await s.drain();
  expect(started.filter((j) => j.kind === "lease").length).toBe(2);
});

test("a tagged resource draws from its own pool, so one browser cannot stall every gate", async () => {
  const db = openMemory();
  const ids = seed(db, 3);
  db.run("INSERT INTO resource (name, template, tags_json) VALUES ('browser', 'echo b', '[\"browser\"]')");
  db.run("INSERT INTO resource (name, template) VALUES ('typecheck', 'echo t')");
  const mk = (resource: string, grp: number) =>
    db
      .query<{ id: number }, [string, number]>(
        "INSERT INTO lease (resource, grp_id, enqueued_at) VALUES (?, ?, 0) RETURNING id",
      )
      .get(resource, grp)!.id;

  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 3, leaseSlots: { default: 2, browser: 1 } });
  for (const g of ids) s.enqueue("lease", { grp_id: g, payload: { lease_id: mk("browser", g) } });
  for (const g of ids) s.enqueue("lease", { grp_id: g, payload: { lease_id: mk("typecheck", g) } });
  s.tick();

  // One browser (its pool is 1) and two typechecks (the default pool is 2). The
  // point of splitting: sized for the browser, a global pool would have let one
  // screenshot hold up every gate in the fleet.
  expect(started.length).toBe(3);
  release();
  await s.drain();
  expect(started.length).toBe(6);
});

test("legacy resource tags with the wrong JSON shape fall back to the default pool", async () => {
  const db = openMemory();
  const grp = idAt(seed(db, 1), 0);
  db.run(`INSERT INTO resource (name, template, tags_json) VALUES ('build', 'echo build', '"repo"')`);
  const lease = db
    .query<{ id: number }, [number]>(
      "INSERT INTO lease (resource, grp_id, enqueued_at) VALUES ('build', ?, 0) RETURNING id",
    )
    .get(grp)!;
  const ran: Job[] = [];
  const scheduler = new Scheduler(db, async (job) => void ran.push(job));

  scheduler.enqueue("lease", { grp_id: grp, payload: { lease_id: lease.id } });
  scheduler.tick();
  await scheduler.drain();

  expect(ran).toHaveLength(1);
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
  expect(ran.map((j) => AgentTurnPayloadSchema.parse(JSON.parse(j.payload_json)).role)).toEqual(["architect"]);
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
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'running'").get()!.c).toBe(0);
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
  const cancelled = db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'cancelled'").get()!.c;
  expect(cancelled).toBe(2);
});

test("higher priority dispatches first", async () => {
  const db = openMemory();
  const ids = seed(db, 2);
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 1 });
  s.enqueue("agent_turn", { grp_id: idAt(ids, 0), priority: 0 });
  s.enqueue("agent_turn", { grp_id: idAt(ids, 1), priority: 10 });
  s.tick();
  expect(started[0]!.grp_id).toBe(idAt(ids, 1));
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

/** Two standing agents, no group between them. Returns their ids. */
function standing(db: DB, ...roles: string[]): number[] {
  return roles.map(
    (role) =>
      db
        .query<{ id: number }, [string]>(
          "INSERT INTO agent (project_id, role, model, state, created_at) VALUES (1, ?, 'm', 'idle', 0) RETURNING id",
        )
        .get(role)!.id,
  );
}

test("two standing agents run at once — they share nothing", async () => {
  const db = openMemory();
  seed(db, 1);
  const standingIds = standing(db, "librarian", "architect");
  const lib = idAt(standingIds, 0);
  const arch = idAt(standingIds, 1);
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 3 });
  s.enqueue("agent_turn", { grp_id: null, agent_id: lib, payload: { role: "librarian" } });
  s.enqueue("agent_turn", { grp_id: null, agent_id: arch, payload: { role: "architect" } });
  s.tick();

  // These four roles used to collapse onto one slot keyed 0, so Architect waited
  // for Librarian for no reason anyone could name: measured 4309s of queueing for
  // the Dispatcher, 1752s for the CoS, on turns that touch no common state. The
  // slot is per agent now; the cost ceiling is still `maxGroups`, below.
  expect(started.length).toBe(2);
  release();
  await s.drain();
});

test("one standing agent still writes one transcript at a time", async () => {
  const db = openMemory();
  seed(db, 1);
  const lib = idAt(standing(db, "librarian"), 0);
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 3 });
  s.enqueue("agent_turn", { grp_id: null, agent_id: lib });
  s.enqueue("agent_turn", { grp_id: null, agent_id: lib });
  s.tick();
  expect(started.length).toBe(1);
  release();
  await s.drain();
  expect(started.length).toBe(2);
});

test("standing turns still count against maxGroups", async () => {
  const db = openMemory();
  seed(db, 1);
  const standingIds = standing(db, "librarian", "architect");
  const lib = idAt(standingIds, 0);
  const arch = idAt(standingIds, 1);
  const { started, release, exec } = gate();
  const s = new Scheduler(db, exec, { maxGroups: 1 });
  s.enqueue("agent_turn", { grp_id: null, agent_id: lib });
  s.enqueue("agent_turn", { grp_id: null, agent_id: arch });
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
  // Started just now, so what identifies the orphan is that nothing is reading
  // the turn, rather than the age check.
  db.run("INSERT INTO job (kind, grp_id, state, started_at, enqueued_at) VALUES ('agent_turn', 1, 'running', ?, 0)", [
    Date.now(),
  ]);
  db.run("INSERT INTO job (kind, grp_id, state, enqueued_at) VALUES ('reconcile', 1, 'pending', 0)");

  const { reclaimOrphans } = await import("../src/scheduler.ts");
  // Nobody is holding this turn's stream: the previous server exited mid-turn.
  expect(reclaimOrphans(db, { alive: () => false })).toHaveLength(1);

  const j = db.query<{ error: string }, []>("SELECT error FROM job WHERE id = 1").get()!;
  expect(j.error).toContain("nothing is reading this turn");
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
  expect(AgentTurnPayloadSchema.parse(JSON.parse(back[0]!.payload_json)).role).toBe("engineer");

  // A second restart still resumes it: the server going away is not this turn's
  // doing, and spending its one chance on that left six groups stopped after a
  // restart with the fix for what broke them already in main.
  db.run("UPDATE job SET state = 'running', pid = 89992, started_at = 0 WHERE state = 'pending'");
  expect(resumeReclaimed(sched, reclaimOrphans(db, { alive: () => false }))).toBe(1);

  // But a turn that failed on its own is resumed once and no more — that is what
  // the guard is for.
  db.run("UPDATE job SET state = 'failed', error = 'turn failed (max_turns)' WHERE state = 'pending'");
  const own = db
    .query<Job & { error: string }, []>(
      "SELECT id, kind, grp_id, agent_id, slice_id, payload_json, priority, state, error FROM job WHERE error LIKE 'turn failed%'",
    )
    .all();
  expect(resumeReclaimed(sched, own)).toBe(0);
});

test("two gates of one repo do not run at once, but two repos still do", async () => {
  const db = openMemory();
  const { release, exec } = gate();
  const sched = new Scheduler(db, exec);
  db.run("INSERT INTO project (id, name, repo_path, created_at) VALUES (1,'a','/a',0), (2,'b','/b',0)");
  db.run(
    `INSERT INTO grp (id, project_id, name, status, created_at)
     VALUES (1,1,'g1','RUNNING',0), (2,1,'g1b','RUNNING',0), (3,2,'g2','RUNNING',0)`,
  );
  db.run(
    `INSERT INTO resource (name, template, concurrency, tags_json) VALUES
       ('build','x',1,'["repo"]'), ('typecheck','y',1,'["repo"]')`,
  );
  const lease = (id: number, resource: string, grp: number) => {
    db.run("INSERT INTO lease (id, resource, grp_id, state, enqueued_at) VALUES (?,?,?,'queued',0)", [
      id,
      resource,
      grp,
    ]);
    sched.enqueue("lease", { grp_id: grp, payload: { lease_id: id } });
  };
  // Concurrency is per resource, so build and typecheck ran side by side — and
  // both shell out to the project's own scripts, which install into a
  // node_modules every worktree of that repo shares. One came back `Failed to
  // link jiti: EEXIST` and the group read it as its own build being broken.
  lease(1, "build", 1);
  lease(2, "typecheck", 2);
  lease(3, "build", 3);
  sched.tick();

  const inflight = db
    .query<{ payload_json: string }, []>("SELECT payload_json FROM job WHERE state = 'running'")
    .all()
    .map((row) => LeaseJobPayload.parse(JSON.parse(row.payload_json)).lease_id);
  expect(inflight).toContain(1);
  // Same repo, different group, different gate: still waits.
  expect(inflight).not.toContain(2);
  // Another repo has nothing to race over.
  expect(inflight).toContain(3);
  release();
});

test("a finished job dispatches what it queued, without anyone remembering to", () => {
  // Sixteen `enqueue` sites had no `tick()` after them, and the omission looked
  // exactly like the deliberate ones — both waited for the watchdog timer, up to
  // watchdogIntervalMs, on work whose whole point was that something noticed it
  // was stuck. The watchdog is itself a job, so its own sweep queued into that
  // wait too.
  const db = openMemory();
  seed(db, 1);
  const started: number[] = [];
  const s = new Scheduler(db, async (j) => {
    started.push(j.id);
    // What a turn does at its end and then does not dispatch.
    if (started.length === 1) s.enqueue("reconcile", { grp_id: 1 });
  });
  s.enqueue("agent_turn", { grp_id: 1 });
  s.tick();

  // The follow-up ran without a second tick from anywhere.
  return Bun.sleep(0).then(() => {
    expect(started.length).toBe(2);
    expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'pending'").get()!.c).toBe(0);
  });
});

test("staging a batch still dispatches it in priority order", () => {
  // Why the tick is on completion and not inside `enqueue`: an enqueue that
  // dispatched on the spot would send the first job before the second exists,
  // and priority across a batch is what the sweep and startGroup rely on.
  const db = openMemory();
  const ids = seed(db, 2);
  const order: (number | null)[] = [];
  const s = new Scheduler(db, async (j) => void order.push(j.grp_id));
  s.enqueue("agent_turn", { grp_id: idAt(ids, 0), priority: 0 });
  s.enqueue("agent_turn", { grp_id: idAt(ids, 1), priority: 10 });
  s.tick();
  expect(order[0]).toBe(idAt(ids, 1));
});
