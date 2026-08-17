import { expect, test } from "bun:test";
import type { Caller } from "../../src/http/agent-auth.ts";
import { postLease } from "../../src/api/orch/lease.ts";
import { postDraft } from "../../src/api/orch/planning.ts";
import { postTaskDone } from "../../src/api/orch/tasks.ts";
import { postEscalationRequirement } from "../../src/api/orch/escalation.ts";
import { postDraftDecision } from "../../src/api/panel/group.ts";
import { newGroup } from "../../src/mech/flow/newgroup.ts";
import { dropGroup } from "../../src/mech/flow/start.ts";
import { acceptSlice, handToQa } from "../../src/mech/flow/review.ts";
import { testContext } from "../support/test-context.ts";

const request = new Request("http://x/orch/v1/test", { method: "POST" });

function seedGroup(status = "RUNNING") {
  const ctx = testContext();
  ctx.db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  ctx.db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', ?, 0)", [status]);
  ctx.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'engineer', 'm', 'tok', 0)",
  );
  const caller: Caller = { id: 1, grp_id: 1, project_id: 1, role: "engineer" };
  return { ctx, caller };
}

function failInsert(ctx: ReturnType<typeof testContext>, table: "event" | "job"): void {
  ctx.db.run(
    `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table}
     BEGIN SELECT RAISE(ABORT, '${table} failure'); END`,
  );
}

async function failureOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to fail");
}

test("new group creation rolls back the group, channel, and note when its event fails", () => {
  const ctx = testContext();
  ctx.db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  failInsert(ctx, "event");

  expect(() => newGroup(ctx, { projectId: 1, name: "g1", idea: "build it" })).toThrow("event failure");
  for (const table of ["grp", "channel", "note", "event"] as const) {
    expect(ctx.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
  }
});

test("a rolled-back event never reaches subscribers, even when its seq is reused", async () => {
  const ctx = testContext();
  const bodies: string[] = [];
  ctx.bus.subscribe((frame) => {
    if (frame.type === "event") bodies.push(frame.body ?? "");
  });

  expect(() =>
    ctx.db.transaction(() => {
      ctx.bus.emit({ author: "boss", kind: "state_change", body: "rolled back" });
      throw new Error("rollback");
    })(),
  ).toThrow("rollback");
  ctx.bus.emit({ author: "boss", kind: "state_change", body: "committed" });
  await Promise.resolve();

  expect(bodies).toEqual(["committed"]);
  expect(ctx.db.query<{ body: string }, []>("SELECT body FROM event").all()).toEqual([{ body: "committed" }]);
});

test("dropping a group is one transaction", () => {
  const { ctx } = seedGroup("RUNNING");
  ctx.db.run("INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (1, 1, 'group', 0)");
  ctx.db.run(
    "INSERT INTO escalation (grp_id, severity, question, brief, kind, chain_state, created_at) VALUES (1, 'blocker', 'q', 'q', 'decision', 'boss', 0)",
  );
  ctx.sched.enqueue("agent_turn", { grp_id: 1 });
  ctx.db.run("CREATE TRIGGER fail_channel BEFORE UPDATE ON channel BEGIN SELECT RAISE(ABORT, 'channel failure'); END");

  expect(() => dropGroup(ctx, 1, "duplicate")).toThrow("channel failure");
  expect(ctx.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("RUNNING");
  expect(ctx.db.query<{ state: string }, []>("SELECT state FROM agent").get()!.state).toBe("idle");
  expect(ctx.db.query<{ status: string }, []>("SELECT status FROM channel").get()!.status).toBe("open");
  expect(ctx.db.query<{ state: string }, []>("SELECT state FROM job").get()!.state).toBe("pending");
  expect(ctx.db.query<{ chain_state: string }, []>("SELECT chain_state FROM escalation").get()!.chain_state).toBe(
    "boss",
  );
});

test("escalation-to-requirement rolls back the new group, driver, answer, and fanout", async () => {
  const { ctx } = seedGroup("PAUSED");
  ctx.db.run(
    "INSERT INTO escalation (grp_id, severity, question, brief, kind, chain_state, created_at) VALUES (1, 'blocker', 'fix config', 'fix', 'env', 'boss', 0)",
  );
  const frames: Array<{ type: string }> = [];
  ctx.bus.subscribe((frame) => frames.push(frame));
  failInsert(ctx, "job");

  expect(
    await failureOf(postEscalationRequirement(ctx, request, { id: 1 }, { text: "do the work", name: "repair" })),
  ).toContain("job failure");
  await Promise.resolve();

  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM grp").get()!.n).toBe(1);
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM channel").get()!.n).toBe(0);
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM note").get()!.n).toBe(0);
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM event").get()!.n).toBe(0);
  expect(ctx.db.query<{ answer: string | null }, []>("SELECT answer FROM escalation").get()!.answer).toBeNull();
  expect(ctx.db.query<{ blocked_on: number | null }, []>("SELECT blocked_on FROM grp").get()!.blocked_on).toBeNull();
  expect(frames).toEqual([]);
});

test("draft rejection rolls back its fact, state, driver, and fanout", async () => {
  const { ctx } = seedGroup("DRAFT");
  const frames: Array<{ type: string }> = [];
  ctx.bus.subscribe((frame) => frames.push(frame));
  failInsert(ctx, "job");

  expect(
    await failureOf(postDraftDecision(ctx, request, { id: 1, decision: "reject" }, { reason: "wrong scope" })),
  ).toContain("job failure");
  await Promise.resolve();

  expect(ctx.db.query<{ status: string }, []>("SELECT status FROM grp").get()!.status).toBe("DRAFT");
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM note").get()!.n).toBe(0);
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM event").get()!.n).toBe(0);
  expect(frames).toEqual([]);
});

test("filing a draft rolls back its note, state, and queue cancellation when its event fails", async () => {
  const { ctx, caller } = seedGroup("PLANNING");
  caller.role = "dispatcher";
  ctx.sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "dispatcher" } });
  failInsert(ctx, "event");
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
  expect(ctx.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PLANNING");
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM note").get()!.n).toBe(0);
  expect(ctx.db.query<{ state: string }, []>("SELECT state FROM job").get()!.state).toBe("pending");
});

test("requesting a lease rolls back the lease and waiting state when its job fails", async () => {
  const { ctx, caller } = seedGroup();
  ctx.db.run("INSERT INTO resource (name, template, arg_schema_json) VALUES ('build', 'true', '{}')");
  failInsert(ctx, "job");

  expect(await failureOf(postLease(ctx, request, caller, {}, { resource: "build", args: {} }))).toContain(
    "job failure",
  );
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM lease").get()!.n).toBe(0);
  expect(ctx.db.query<{ state: string }, []>("SELECT state FROM agent WHERE id = 1").get()!.state).toBe("idle");
});

test("finishing a task rolls back the task, events, self gate, and slice when its driver job fails", async () => {
  const { ctx, caller } = seedGroup();
  ctx.db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at) VALUES (1, 1, 'S1', 'tests pass', 'running', 0)",
  );
  ctx.db.run("INSERT INTO task (grp_id, slice_id, title, created_at) VALUES (1, 1, 'task', 0)");
  failInsert(ctx, "job");

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
  expect(ctx.db.query<{ status: string }, []>("SELECT status FROM task WHERE id = 1").get()!.status).toBe("pending");
  const slice = ctx.db
    .query<{ status: string; gates_json: string }, []>("SELECT status, gates_json FROM slice WHERE id = 1")
    .get()!;
  expect(slice.status).toBe("running");
  expect(slice.gates_json).toBe("{}");
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM event").get()!.n).toBe(0);
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM job").get()!.n).toBe(0);
});

test("review transitions do not expose a new state without its driver job", () => {
  const { ctx } = seedGroup();
  ctx.db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at) VALUES (1, 1, 'S1', 'tests pass', 'gate', 0)",
  );
  failInsert(ctx, "job");

  expect(() => handToQa({ ctx, cfg: ctx.config }, 1)).toThrow("job failure");
  expect(ctx.db.query<{ status: string }, []>("SELECT status FROM slice WHERE id = 1").get()!.status).toBe("gate");
});

test("accepting a slice rolls back acceptance and handoff when the next job fails", () => {
  const { ctx } = seedGroup();
  ctx.db.run(
    `INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at) VALUES
     (1, 1, 'S1', 'one', 'awaiting_boss', 0),
     (1, 2, 'S2', 'two', 'pending', 0)`,
  );
  failInsert(ctx, "job");

  expect(() => acceptSlice(ctx, 1, "boss")).toThrow("job failure");
  const slices = ctx.db.query<{ status: string }, []>("SELECT status FROM slice ORDER BY seq").all();
  expect(slices.map((slice) => slice.status)).toEqual(["awaiting_boss", "pending"]);
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM event").get()!.n).toBe(0);
  expect(ctx.db.query<{ n: number }, []>("SELECT count(*) AS n FROM note").get()!.n).toBe(0);
});
