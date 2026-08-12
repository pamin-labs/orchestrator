import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp, type Ctx } from "../src/api.ts";
import { Bus } from "../src/bus.ts";
import { loadConfig, loadRoles } from "../src/config.ts";
import { openMemory } from "../src/db.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { Scheduler } from "../src/scheduler.ts";
import { makeExecutor, cacheRatio, hire, type ExecDeps } from "../src/runtime/executor.ts";
import type { TurnResult } from "../src/runtime/claude.ts";
import type { TurnSpec } from "../src/runtime/claude.ts";

function ok(over: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionId: "s1",
    ok: true,
    terminalReason: "completed",
    text: "done",
    usage: { input: 10, output: 20, cacheRead: 5000, cacheCreate: 100, thinking: 0 },
    costUsd: 0.01,
    numTurns: 1,
    permissionDenials: [],
    toolSummaries: [],
    filesTouched: [],
    ...over,
  };
}

function harness(turn: (spec: TurnSpec) => Promise<TurnResult>) {
  const db = openMemory();
  const bus = new Bus(db);
  const cfg = { ...loadConfig(), dataDir: mkdtempSync(join(tmpdir(), "orch-data-")) };
  const specs: TurnSpec[] = [];
  let exec: any = null;
  const sched = new Scheduler(db, (j) => exec(j));
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gitLock: new RepoLock(),
    waiters: new Map(),
    config: { language: cfg.language, difficultyModel: cfg.difficultyModel, workRoot: cfg.workRoot },
  };
  const deps: ExecDeps = {
    ctx,
    cfg,
    roles: loadRoles("roles"),
    git: async () => ({ code: 1, out: "" }), // no repo in these tests
    runTurn: async (spec) => {
      specs.push(spec);
      return turn(spec);
    },
  };
  exec = makeExecutor(deps);

  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  return { db, ctx, sched, deps, specs, app: makeApp(ctx) };
}

test("a turn hires the role's agent on first use, with a token", async () => {
  const { db, sched } = harness(async () => ok());
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  const a = db
    .query<{ role: string; token: string | null; model: string; clearance: string }, []>(
      "SELECT role, token, model, clearance FROM agent",
    )
    .get()!;
  expect(a.role).toBe("engineer");
  expect(a.token).toBeTruthy();
  expect(a.clearance).toBe("L1");
});

test("the slice's difficulty picks the model — the boss's cost knob", async () => {
  const { db, sched, specs } = harness(async () => ok());
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, created_at) VALUES (1, 1, 'S1', 'x', 'trivial', 0)",
  );
  sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs[0]!.stable.model).toContain("haiku");

  db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, created_at) VALUES (1, 2, 'S2', 'x', 'hard', 0)");
  db.run("DELETE FROM agent");
  sched.enqueue("agent_turn", { grp_id: 1, slice_id: 2, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs[1]!.stable.model).toContain("opus");
});

test("the dispatcher ignores difficulty and always takes the strong tier", async () => {
  const { db, sched, specs } = harness(async () => ok());
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, created_at) VALUES (1, 1, 'S1', 'x', 'trivial', 0)",
  );
  sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "dispatcher" } });
  await sched.drain();
  expect(specs[0]!.stable.model).toContain("opus");
});

test("the second turn resumes the session instead of starting one", async () => {
  const { sched, specs } = harness(async () => ok());
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  expect(specs[0]!.newSessionId).toBeTruthy();
  expect(specs[0]!.resumeSessionId).toBeUndefined();
  expect(specs[1]!.resumeSessionId).toBe(specs[0]!.newSessionId);
  // Same stable half both times, or the cache would have died between turns.
  expect(specs[1]!.stable.hash).toBe(specs[0]!.stable.hash);
});

test("a changed stable half rotates the session rather than paying full price", async () => {
  const { db, sched, specs } = harness(async () => ok());
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  // A new lesson changes the stable half. Mutating it in place would invalidate
  // the cached prefix on every remaining turn of the session.
  db.run("INSERT INTO note (project_id, kind, lang, body, at) VALUES (1, 'lesson', 'zh', 'always run gate first', 0)");
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  expect(specs[1]!.stable.hash).not.toBe(specs[0]!.stable.hash);
  expect(specs[1]!.resumeSessionId).toBeUndefined();
  expect(specs[1]!.newSessionId).toBeTruthy();
  expect(specs[1]!.newSessionId).not.toBe(specs[0]!.newSessionId);
  // A rotated session is told it is fresh, so it re-queries instead of assuming.
  expect(specs[1]!.prompt).toContain("orch ctx query");
});

test("the delta is the prompt and never leaks into the stable half", async () => {
  const { db, sched, specs } = harness(async () => ok());
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, created_at) VALUES (1, 1, 'move token check', 'mw tests pass', 'normal', 0)",
  );
  sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  expect(specs[0]!.prompt).toContain("move token check");
  expect(specs[0]!.stable.systemAppend).not.toContain("move token check");
});

test("cost lands on the agent, the slice and the group", async () => {
  const { db, sched } = harness(async () => ok({ costUsd: 0.25 }));
  db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (1, 1, 'S1', 'x', 0)");
  sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  const total = 10 + 20 + 5000 + 100;
  expect(db.query<{ t: number }, []>("SELECT total_tokens AS t FROM agent").get()!.t).toBe(total);
  expect(db.query<{ u: number }, []>("SELECT spent_usd AS u FROM slice").get()!.u).toBeCloseTo(0.25);
  expect(db.query<{ u: number }, []>("SELECT spent_usd AS u FROM grp").get()!.u).toBeCloseTo(0.25);
});

test("a permission denial becomes an escalation instead of vanishing", async () => {
  const { db, sched } = harness(async () =>
    ok({ permissionDenials: [{ tool: "Bash", command: "git push" }] }),
  );
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  const esc = db.query<{ question: string; severity: string }, []>("SELECT question, severity FROM escalation").get()!;
  expect(esc.question).toContain("git push");
  // The agent stops, the group keeps going: one denial should not halt everyone.
  expect(db.query<{ state: string }, []>("SELECT state FROM agent").get()!.state).toBe("blocked");
  expect(db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("RUNNING");
});

test("a rate limit pauses the group instead of burning through the quota", async () => {
  const { db, sched } = harness(async () =>
    ok({ rateLimit: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1786554000 } }),
  );
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSED");
});

test("a failed turn is recorded as failed, not silently swallowed", async () => {
  const { db, sched } = harness(async () => ok({ ok: false, terminalReason: "api_error", text: "boom" }));
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  const job = db.query<{ state: string; error: string }, []>("SELECT state, error FROM job").get()!;
  expect(job.state).toBe("failed");
  expect(job.error).toContain("api_error");
  expect(db.query<{ state: string }, []>("SELECT state FROM agent").get()!.state).toBe("idle");
});

test("unread channel messages are injected once, then the cursor advances", async () => {
  const { db, ctx, sched, specs } = harness(async () => ok());
  db.run("INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (1, 1, 'group', 0)");
  ctx.bus.emit({ channelId: 1, grpId: 1, author: "boss", kind: "boss_say", intent: "request", body: "prefer iteration" });

  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs[0]!.prompt).toContain("prefer iteration");

  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  // Re-sending it every turn is how ambient chat quietly becomes the whole bill.
  expect(specs[1]!.prompt).not.toContain("prefer iteration");
});

test("a lease runs its template and unblocks the waiting agent", async () => {
  const { db, ctx, sched } = harness(async () => ok());
  const agent = hire({ ...({} as any), ...harnessDeps(ctx, sched) }, 1, "engineer");
  db.run(
    `INSERT INTO resource (name, template, arg_schema_json, error_regex)
     VALUES ('echo', 'echo hello-lease', '{}', '^error')`,
  );
  const lease = db
    .query<{ id: number }, []>(
      `INSERT INTO lease (resource, grp_id, agent_id, args_json, enqueued_at)
       VALUES ('echo', 1, ${agent.id}, '{}', 0) RETURNING id`,
    )
    .get()!;

  let digest = "";
  ctx.waiters.set(`lease:${lease.id}`, (v) => (digest = v));
  sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  expect(digest).toContain("exit 0");
  expect(digest).toContain("hello-lease");
  const row = db.query<{ state: string; exit_code: number }, []>("SELECT state, exit_code FROM lease").get()!;
  expect(row.state).toBe("done");
  expect(row.exit_code).toBe(0);
});

test("a lease whose args stopped validating fails instead of running", async () => {
  const { db, ctx, sched } = harness(async () => ok());
  db.run(
    `INSERT INTO resource (name, template, arg_schema_json)
     VALUES ('build', 'make {target}', '{"target":{"type":"enum","values":["debug"]}}')`,
  );
  // Queued when the enum still allowed it; the template changed underneath.
  const lease = db
    .query<{ id: number }, []>(
      `INSERT INTO lease (resource, grp_id, args_json, enqueued_at)
       VALUES ('build', 1, '{"target":"release"}', 0) RETURNING id`,
    )
    .get()!;
  let digest = "";
  ctx.waiters.set(`lease:${lease.id}`, (v) => (digest = v));
  sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  expect(digest).toContain("one of");
  expect(db.query<{ state: string }, []>("SELECT state FROM lease").get()!.state).toBe("failed");
});

test("cacheRatio reports the only visible signal that caching still works", () => {
  expect(cacheRatio(ok())).toBeCloseTo(5000 / 5110, 3);
  expect(cacheRatio(ok({ usage: { input: 100, output: 5, cacheRead: 0, cacheCreate: 0, thinking: 0 } }))).toBe(0);
});

/** Minimal deps for calling `hire` directly. */
function harnessDeps(ctx: Ctx, sched: Scheduler) {
  return {
    ctx,
    cfg: { ...loadConfig(), dataDir: "data" },
    roles: loadRoles("roles"),
    git: async () => ({ code: 1, out: "" }),
    sched,
  } as unknown as ExecDeps;
}
