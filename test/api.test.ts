import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus.ts";
import { openMemory, type DB } from "../src/db.ts";
import { Scheduler, type Job } from "../src/scheduler.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { makeApp, type Ctx } from "../src/api.ts";

function harness(opts: { worktree?: string } = {}) {
  const db: DB = openMemory();
  const bus = new Bus(db);
  const ran: Job[] = [];
  const sched = new Scheduler(db, async (j) => void ran.push(j));
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gitLock: new RepoLock(),
    waiters: new Map(),
    config: { language: "中文", difficultyModel: { trivial: "haiku", normal: "sonnet", hard: "opus" }, workRoot: "/tmp/orch-test/wt" },
  };
  const app = makeApp(ctx);

  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, worktree, created_at) VALUES (1, 'g1', 'RUNNING', ?, 0)", [
    opts.worktree ?? null,
  ]);
  // Identity is the token, never a body field: the server listens on localhost
  // TCP, so anything else on 127.0.0.1 could otherwise claim to be any agent.
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'engineer', 'sonnet', 'L1', 'tok-eng', 0)",
  );
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'qa', 'sonnet', 'L1', 'tok-qa', 0)",
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
      headers: token ? { "x-orch-token": token } : undefined,
    }),
  );
const get = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`));

test("an over-long journal is rejected with a reason the agent can act on", async () => {
  const { app } = harness();
  const r = await post(app, "/orch/journal", { kind: "journal", body: "a\nb\nc\nd\ne\nf\ng" },
    "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("max 6");
});

test("journal writes a note and exports journal/retro into the worktree", async () => {
  const wt = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const { app, db } = harness({ worktree: wt });

  const r = await post(
    app,
    "/orch/journal",
    { kind: "journal", body: "Moved token check into middleware.", files: ["auth/mw.ts"] },
    "tok-eng",
  );
  expect(r.status).toBe(200);
  const out = await r.text();
  expect(out).toContain("docs/journal/g1/001-journal.md");

  const written = await Bun.file(join(wt, "docs/journal/g1/001-journal.md")).text();
  expect(written).toContain("kind: journal");
  expect(written).toContain("files: [auth/mw.ts]");
  expect(written).toContain("Moved token check into middleware.");

  const note = db.query<{ kind: string; export_path: string }, []>("SELECT kind, export_path FROM note").get()!;
  expect(note.kind).toBe("journal");
  expect(note.export_path).toBe("docs/journal/g1/001-journal.md");
});

test("a fact never gets exported to git — only journal/retro/decision do", async () => {
  const wt = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const { app, db } = harness({ worktree: wt });
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
反对 : 无`;
  // Filing the card is what moves the group to DRAFT, and DRAFT blocks.
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'L2', 'tok-disp', 0)",
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
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'L2', 'tok-disp', 0)",
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
  const paths = ["/orch/status", "/orch/journal", "/orch/mail", "/orch/ask-boss", "/orch/lease"];
  for (const p of paths) {
    const payload = { kind: "journal", body: "x", intent: "note", target: "qa" };
    // No token at all.
    expect((await post(app, p, payload)).status).toBe(422);
    // A token that belongs to nobody. An agent cannot promote itself by
    // sending someone else's id, because the id is never in the body.
    expect((await post(app, p, payload, "not-a-real-token")).status).toBe(422);
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
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'L2', 'tok-disp', 0)",
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
反对 : 无`;
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
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'L2', 'tok-disp', 0)",
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
反对 : 无`;
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
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'L2', 'tok-disp', 0)",
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
反对 : 无`;
  await post(app, "/orch/draft", { group_id: grp_id, card }, "tok-disp");

  const s = (await (await get(app, "/api/state")).json()) as any;
  const filed = s.draftCards.find((c: any) => c.grpId === grp_id);
  // Showing an empty box and asking for approval is asking the boss to approve
  // something they cannot see.
  expect(filed?.body).toContain("支持 zh");
});
