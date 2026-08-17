import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "../src/api.ts";
import type { Ctx } from "../src/ctx.ts";
import { Bus } from "../src/bus.ts";
import { loadConfig, loadRoles } from "../src/config.ts";
import { openMemory, type DB } from "../src/db.ts";
import type { TurnResult, TurnSpec } from "../src/runtime/claude.ts";
import { cacheRatio, type ExecDeps, hire, LOST_SESSION, makeExecutor } from "../src/runtime/executor.ts";
import { AgentTurnPayloadSchema, Scheduler, type Executor } from "../src/scheduler.ts";
import { abortJob } from "../src/runtime/running.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";

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

function harness(turn: (spec: TurnSpec) => Promise<TurnResult>) {
  const db = openMemory();
  seedAuth(db);
  const bus = new Bus(db);
  const cfg = { ...loadConfig(), dataDir: mkdtempSync(join(tmpdir(), "orch-data-")) };
  const specs: TurnSpec[] = [];
  let exec: Executor;
  const sched = new Scheduler(db, (j) => exec(j));
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

  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  return { db, ctx, sched, deps, specs, sandbox, app: makeApp(ctx) };
}

function expectDurableLeaseWake(db: DB, agentId: number, body: string): void {
  expect(db.query<{ state: string }, [number]>("SELECT state FROM agent WHERE id = ?").get(agentId)!.state).toBe(
    "idle",
  );
  const wake = db
    .query<{ agent_id: number | null; payload_json: string }, [number]>(
      "SELECT agent_id, payload_json FROM job WHERE kind = 'agent_turn' AND agent_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(agentId)!;
  expect(wake.agent_id).toBe(agentId);
  const mail = AgentTurnPayloadSchema.parse(JSON.parse(wake.payload_json)).mail;
  expect(mail).toMatchObject({ from: "runner", from_group: 1, intent: "inform" });
  expect(mail?.body).toContain(body);
}

test("a turn hires the role's agent on first use, with a token", async () => {
  const { db, sched } = harness(async () => ok());
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  const a = db
    .query<{ role: string; token: string | null; model: string }, []>("SELECT role, token, model FROM agent")
    .get()!;
  expect(a.role).toBe("engineer");
  expect(a.token).toBeTruthy();
});

test("the slice's difficulty picks the model — the boss's cost knob", async () => {
  const { db, sched, specs } = harness(async () => ok());
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, created_at) VALUES (1, 1, 'S1', 'x', 'trivial', 0)",
  );
  sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  // The tier, not the family: the Engineer runs on codex, so the knob moves it
  // along that provider's ladder. Reading the id out of config rather than naming
  // one keeps this a test of the mechanism instead of of today's roster.
  const cfg = loadConfig("config/default.yaml");
  const eng = loadRoles("roles").get("engineer")!;
  const table = cfg.difficultyModel[eng.runtime ?? "claude"]!;
  expect(specs[0]!.stable.model).toBe(table.trivial!);

  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, created_at) VALUES (1, 2, 'S2', 'x', 'hard', 0)",
  );
  db.run("DELETE FROM agent");
  sched.enqueue("agent_turn", { grp_id: 1, slice_id: 2, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs[1]!.stable.model).toBe(table.hard!);
  expect(specs[1]!.stable.model).not.toBe(specs[0]!.stable.model);
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
  // The id the runtime reported, not the one we minted — codex starts a thread of
  // its own and only that id is resumable.
  expect(specs[1]!.resumeSessionId).toBe("s1");
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
  const { db, sched } = harness(async () => ok());
  db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (1, 1, 'S1', 'x', 0)");
  sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "engineer" } });
  await sched.drain();

  const total = 10 + 20 + 5000 + 100;
  expect(db.query<{ t: number }, []>("SELECT total_tokens AS t FROM agent").get()!.t).toBe(total);
  // Tokens are the unit of account now: two subscriptions pay for this, so the
  // dollar figure was API-rate fiction on one half and absent on the other.
  // Tokens are the unit of account now: two subscriptions pay for this, so the
  // dollar figure was API-rate fiction on one half and absent on the other.
  expect(db.query<{ t: number }, []>("SELECT spent_tokens AS t FROM slice").get()!.t).toBe(total);
  expect(db.query<{ t: number }, []>("SELECT spent_tokens AS t FROM grp").get()!.t).toBe(total);
});

test("a rate limit holds the whole provider, not just the group that hit it", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const { db, sched, specs } = harness(async () =>
    ok({ rateLimit: { status: "rejected", rateLimitType: "five_hour", resetsAt } }),
  );
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("PAUSED");

  // The window belongs to the account. Before this, every other group spent a turn
  // discovering the same wall, and a standing agent — no group to pause — retried
  // into it. The held job is never started, so waiting costs nothing.
  const hold = db
    .query<{ runtime: string; hold_until: number }, []>("SELECT runtime, hold_until FROM usage_snapshot")
    .get()!;
  expect(hold.runtime).toBe(db.query<{ runtime: string }, []>("SELECT runtime FROM agent").get()!.runtime);
  expect(hold.hold_until).toBe(resetsAt * 1000);

  // With the group running again, the hold is the only thing left holding it —
  // which is the point: the two are independent, and the account-level one is not
  // a property of any group.
  db.run("UPDATE grp SET status = 'RUNNING', paused_at = NULL, rl_resets_at = NULL");
  const before = specs.length;
  sched.enqueue("agent_turn", { grp_id: 1, agent_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs.length).toBe(before);
  expect(db.query<{ state: string }, []>("SELECT state FROM job ORDER BY id DESC").get()!.state).toBe("pending");

  // And it lifts by clock — nobody has to be awake for the reset.
  db.run("UPDATE usage_snapshot SET hold_until = 1");
  await sched.drain();
  expect(specs.length).toBe(before + 1);
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
  ctx.bus.emit({
    channelId: 1,
    grpId: 1,
    author: "boss",
    kind: "boss_say",
    intent: "request",
    body: "prefer iteration",
  });

  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs[0]!.prompt).toContain("prefer iteration");

  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  // Re-sending it every turn is how ambient chat quietly becomes the whole bill.
  expect(specs[1]!.prompt).not.toContain("prefer iteration");
});

test("a lease runs its template and durably wakes the waiting agent", async () => {
  const { db, ctx, sched, sandbox } = harness(async () => ok());
  const agent = hire(harnessDeps(ctx), 1, "engineer");
  db.run("UPDATE agent SET state = 'waiting_lease' WHERE id = ?", [agent.id]);
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

  sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  // The template reached the sandbox as argv, quoted, with nothing shell-parsed
  // on the way — that is the whole of hard constraint 2 now that `orch` is the
  // only interface an agent has.
  expect(sandbox.commands).toContain("'echo' 'hello-lease'");
  const row = db.query<{ state: string; exit_code: number }, []>("SELECT state, exit_code FROM lease").get()!;
  expect(row.state).toBe("done");
  expect(row.exit_code).toBe(0);
  expectDurableLeaseWake(db, agent.id, "exit 0");
});

test("finishLease rollback never fans a result whose wake job was not committed", async () => {
  const { db, ctx, sched } = harness(async () => ok());
  const agent = hire(harnessDeps(ctx), 1, "engineer");
  db.run("UPDATE agent SET state = 'waiting_lease' WHERE id = ?", [agent.id]);
  db.run("INSERT INTO resource (name, template, arg_schema_json) VALUES ('echo', 'echo ok', '{}')");
  const lease = db
    .query<{ id: number }, []>(
      `INSERT INTO lease (resource, grp_id, agent_id, args_json, enqueued_at)
       VALUES ('echo', 1, ${agent.id}, '{}', 0) RETURNING id`,
    )
    .get()!;
  sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  db.run(
    `CREATE TRIGGER fail_lease_wake BEFORE INSERT ON job WHEN NEW.kind = 'agent_turn'
     BEGIN SELECT RAISE(ABORT, 'wake failure'); END`,
  );
  const results: string[] = [];
  ctx.bus.subscribe((frame) => {
    if (frame.type === "event" && frame.kind === "lease_result") results.push(frame.body ?? "");
  });

  await sched.drain();
  await Promise.resolve();

  expect(results).toEqual([]);
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM event WHERE kind = 'lease_result'").get()!.n).toBe(0);
  expect(db.query<{ state: string }, [number]>("SELECT state FROM agent WHERE id = ?").get(agent.id)!.state).toBe(
    "waiting_lease",
  );
});

test("a lease whose args stopped validating fails instead of running", async () => {
  const { db, ctx, sched } = harness(async () => ok());
  const agent = hire(harnessDeps(ctx), 1, "engineer");
  db.run("UPDATE agent SET state = 'waiting_lease' WHERE id = ?", [agent.id]);
  db.run(
    `INSERT INTO resource (name, template, arg_schema_json)
     VALUES ('build', 'make {target}', '{"target":{"type":"enum","values":["debug"]}}')`,
  );
  // Queued when the enum still allowed it; the template changed underneath.
  const lease = db
    .query<{ id: number }, []>(
      `INSERT INTO lease (resource, grp_id, agent_id, args_json, enqueued_at)
       VALUES ('build', 1, ${agent.id}, '{"target":"release"}', 0) RETURNING id`,
    )
    .get()!;
  sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  expect(db.query<{ state: string }, []>("SELECT state FROM lease").get()!.state).toBe("failed");
  expectDurableLeaseWake(db, agent.id, "one of");
});

test("persisted lease arguments must be a flat object of supported scalars", async () => {
  const { db, ctx, sched } = harness(async () => ok());
  const agent = hire(harnessDeps(ctx), 1, "engineer");
  db.run("UPDATE agent SET state = 'waiting_lease' WHERE id = ?", [agent.id]);
  db.run(
    `INSERT INTO resource (name, template, arg_schema_json)
     VALUES ('build', 'make {target}', '{"target":{"type":"enum","values":["release"]}}')`,
  );
  const lease = db
    .query<{ id: number }, []>(
      `INSERT INTO lease (resource, grp_id, agent_id, args_json, enqueued_at)
       VALUES ('build', 1, ${agent.id}, '{"target":{"nested":"release"}}', 0) RETURNING id`,
    )
    .get()!;
  sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  await sched.drain();

  expect(db.query<{ state: string }, [number]>("SELECT state FROM lease WHERE id = ?").get(lease.id)!.state).toBe(
    "failed",
  );
  expectDurableLeaseWake(db, agent.id, "flat JSON object of string, number, or boolean values");
});

test("cancelling a running lease aborts its sandbox command", async () => {
  const { db, ctx, sched, sandbox } = harness(async () => ok());
  db.run("INSERT INTO resource (name, template, arg_schema_json) VALUES ('slow', 'sleep 30', '{}')");
  const lease = db
    .query<{ id: number }, []>(
      "INSERT INTO lease (resource, grp_id, args_json, enqueued_at) VALUES ('slow', 1, '{}', 0) RETURNING id",
    )
    .get()!;
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

  const jobId = sched.enqueue("lease", { grp_id: 1, payload: { lease_id: lease.id } });
  sched.tick();
  await started.promise;
  expect(abortJob(jobId)).toBe(true);
  await sched.drain();

  expect(resourceSignal?.aborted).toBe(true);
  expect(db.query<{ state: string }, [number]>("SELECT state FROM job WHERE id = ?").get(jobId)!.state).toBe("failed");
});

test("a lease job without an integer id fails instead of disappearing", async () => {
  const { db, sched } = harness(async () => ok());
  const job = sched.enqueue("lease", { grp_id: 1 });
  db.run("UPDATE job SET payload_json = ? WHERE id = ?", [JSON.stringify({ lease_id: "1" }), job]);
  await sched.drain();
  const row = db
    .query<{ state: string; error: string | null }, [number]>("SELECT state, error FROM job WHERE id = ?")
    .get(job)!;
  expect(row.state).toBe("failed");
  expect(row.error).toContain("invalid lease payload");
});

test("cacheRatio reports the only visible signal that caching still works", () => {
  expect(cacheRatio(ok())).toBeCloseTo(5000 / 5110, 3);
  expect(cacheRatio(ok({ usage: { input: 100, output: 5, cacheRead: 0, cacheCreate: 0, thinking: 0 } }))).toBe(0);
});

test("a turn records whether it opened a cold session, and what caused it", async () => {
  const { db, sched } = harness(async () => ok());
  const reasons = () =>
    db
      .query<{ why: string | null }, []>(
        "SELECT json_extract(meta_json, '$.rotate') AS why FROM event WHERE kind = 'tool_summary' ORDER BY seq",
      )
      .all()
      .map((r) => r.why);

  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer", rotate: true } });
  await sched.drain();

  // Null is the healthy case and has to stay distinguishable from the others: a
  // cache ratio alone cannot tell "the prefix moved" from "a send-back asked for
  // a clean head", and those have opposite fixes.
  expect(reasons()).toEqual(["new", null, "explicit"]);
});

test("malformed persisted payloads fail before a turn starts", async () => {
  const { db, sched, specs } = harness(async () => ok());
  const first = sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  db.run("UPDATE job SET payload_json = 'null' WHERE id = ?", [first]);
  await sched.drain();
  expect(specs).toHaveLength(0);
  const failed = db
    .query<{ state: string; error: string }, [number]>("SELECT state, error FROM job WHERE id = ?")
    .get(first)!;
  expect(failed.state).toBe("failed");
  expect(failed.error).toContain("invalid agent_turn payload");

  const second = sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  db.run("UPDATE job SET payload_json = ? WHERE id = ?", [
    JSON.stringify({ role: "engineer", rotate: "false", boundary: [null], mail: { from: 1 } }),
    second,
  ]);
  await sched.drain();
  expect(specs).toHaveLength(0);
  expect(db.query<{ state: string }, [number]>("SELECT state FROM job WHERE id = ?").get(second)!.state).toBe("failed");
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
  const { sched, specs } = harness(async () => ok());
  // No payload, no slice, no unread: `claude -p` rejects an empty prompt outright,
  // so the turn would crash on something that is really a bug upstream.
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs[0]!.prompt.trim().length).toBeGreaterThan(0);
  expect(specs[0]!.prompt).toContain("orch task list");
});

test("a mailed message travels with the job, not via the channel cursor", async () => {
  const { sched, specs } = harness(async () => ok());
  sched.enqueue("agent_turn", {
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
  const { db, sched, specs } = harness(async () => ok());
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, status, created_at) VALUES (1, 1, 'S1', 'greet zh works', 'trivial', 'qa', 0)",
  );
  sched.enqueue("agent_turn", { grp_id: 1, slice_id: 1, payload: { role: "qa", review: 1 } });
  await sched.drain();

  // Giving an agent S1 when the verb takes a database id is the same mistake as
  // the task-id one: an identifier it cannot use.
  expect(specs[0]!.prompt).toContain("slice_id 1");
  expect(specs[0]!.prompt).toContain("orch review 1 --verdict");
});

test("an unknown persisted payload key fails before the executor sees it", async () => {
  const { db, sched } = harness(async () => ok());
  const id = sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  db.run("UPDATE job SET payload_json = ? WHERE id = ?", [JSON.stringify({ role: "engineer", cutBoundary: 7 }), id]);
  await sched.drain();

  const job = db
    .query<{ state: string; error: string }, [number]>("SELECT state, error FROM job WHERE id = ?")
    .get(id)!;
  expect(job.state).toBe("failed");
  expect(job.error).toContain("cutBoundary");
});

test("invalid persisted payload fields fail together instead of being dropped", async () => {
  const { db, sched } = harness(async () => ok());
  const id = sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  db.run("UPDATE job SET payload_json = ? WHERE id = ?", [
    JSON.stringify({
      role: "engineer",
      idea: 1,
      mail: { from: 1 },
      boundary: [null],
      digest: { channel_id: "1" },
      skills: [null],
    }),
    id,
  ]);
  await sched.drain();

  const job = db
    .query<{ state: string; error: string }, [number]>("SELECT state, error FROM job WHERE id = ?")
    .get(id)!;
  expect(job.state).toBe("failed");
  for (const key of ["idea", "mail", "boundary", "digest", "skills"]) {
    expect(job.error).toContain(key);
  }
});

test("the keys that are rendered do not trigger the warning", async () => {
  const { db, sched } = harness(async () => ok());
  sched.enqueue("agent_turn", {
    grp_id: 1,
    payload: { role: "engineer", rejection: "fix this", rotate: true },
  });
  await sched.drain();
  expect(
    db.query<{ c: number }, []>("SELECT count(*) AS c FROM event WHERE body LIKE '%nothing renders%'").get()!.c,
  ).toBe(0);
});

test("the Architect is told which requirement belongs to which group", async () => {
  const { db, sched, specs } = harness(async () => ok());
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g2', 'PLANNING', 0)");
  sched.enqueue("agent_turn", {
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
  expect(LOST_SESSION.test("Error: thread/resume: thread/resume failed: no rollout found for thread id 02627e60")).toBe(
    true,
  );
  expect(LOST_SESSION.test("No conversation found with session ID: abc")).toBe(true);
  // Not every failure is this one: clearing a live session costs an uncached
  // prefix, so the match has to be the actual message.
  expect(LOST_SESSION.test("turn failed (max_turns): ...")).toBe(false);
  expect(LOST_SESSION.test("rebase failed: conflict in src/api.ts")).toBe(false);
});

test("the session id stored is the one the runtime actually used", async () => {
  // claude honours `--session-id <uuid>`, so minting one is correct there. codex
  // does not: `codex exec` starts a thread of its own and `codex exec resume`
  // wants THAT id. We stored the minted one, so every codex agent's second turn
  // ran `resume <our-uuid>` and died with `no rollout found for thread id …` —
  // thirty agents in the live database, not one of them holding a codex id.
  const { db, sched, specs } = harness(async () => ok({ sessionId: "019ffb87-a288-7263-a7df-4b214098ae24" }));
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(db.query<{ session_id: string }, []>("SELECT session_id FROM agent").get()!.session_id).toBe(
    "019ffb87-a288-7263-a7df-4b214098ae24",
  );

  // And the next turn resumes with it, rather than with whatever we minted.
  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  expect(specs.at(-1)!.resumeSessionId).toBe("019ffb87-a288-7263-a7df-4b214098ae24");
});
