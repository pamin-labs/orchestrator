import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bus } from "../src/bus.ts";
import { openMemory, type DB } from "../src/db.ts";
import { Scheduler, type Job } from "../src/scheduler.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { landGroup, makeApp, type Ctx } from "../src/api.ts";
import { listSkills } from "../src/mech/skills.ts";
import { landed } from "../src/mech/mergequeue.ts";
import { sweepApproved } from "../src/mech/start.ts";

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

  // An objection that lands after the card must reach the boss too. The card says
  // 反对 : 无 because the Dispatcher does not wait for the Architect — measured,
  // the objection arrived a minute later and said the plan contradicted its own
  // acceptance criterion.
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, NULL, 'architect', 'm', 'L2', 'tok-arch', 0)",
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
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, ?, 'dispatcher', 'm', 'L2', 'tok-d', 0)",
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
    [grp_id, card + "\n风险 : 无\n反对 : 无", JSON.stringify({ draft_card: true })],
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
反对 : 无`,
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
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'architect', 'm', 'L2', 'tok-a', 0)",
  );
  // The re-cut moves group 1 off the contested path. Nothing touches group 2 —
  // sweeping only the group `owns` names would leave it waiting.
  await post(h.app, "/orch/owns", { group_id: 1, paths: ["src/c/**"] }, "tok-a");
  expect(
    h.db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grpId)!.status,
  ).toBe("RUNNING");
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
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'dispatcher', 'm', 'L2', 'tok-d', 0)",
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

test("a mistyped repo path is refused at registration, not at the first worktree", async () => {
  const { app } = harness();
  // The web form is a typed path (a browser cannot hand over a real one), so a
  // typo is the expected mistake. Creating the project and failing later leaves
  // a project that looks registered and breaks the moment a group starts.
  for (const [path, want] of [
    ["relative/path", "absolute"],
    ["/nope/definitely/not/here", "does not exist"],
    ["/etc/hosts", "not a directory"],
    ["/tmp", "not a git repo"],
  ]) {
    const r = await post(app, "/api/projects", { name: `p-${path}`, repo_path: path });
    expect(r.status).toBe(422);
    expect(await r.text()).toContain(want!);
  }
});

test("the same repo cannot be registered twice", async () => {
  const { app } = harness();
  const dir = mkdtempSync(join(tmpdir(), "orch-dup-"));
  mkdirSync(join(dir, ".git"), { recursive: true });

  expect((await post(app, "/api/projects", { name: "first", repo_path: dir })).status).toBe(200);
  // Two projects on one repo would each cut file ownership as if they owned it all.
  const again = await post(app, "/api/projects", { name: "second", repo_path: dir });
  expect(again.status).toBe(422);
  expect(await again.text()).toContain('already registered as "first"');
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

test("nobody confirms a merge by hand: GitHub is the only source, and it winds the group up", async () => {
  const { app, db, ctx } = harness();
  db.run("UPDATE grp SET status = 'PR_OPEN', pr_number = 7, worktree = '/tmp/wt', merge_seq = 1 WHERE id = 1");

  // The button that asked the boss to confirm is gone. It dissolved a group on
  // trust, and one mis-click archived a branch whose PR was still open.
  expect((await post(app, "/api/groups/1/landed")).status).toBe(404);
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
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'pm', 'sonnet', 'L2', 'tok-pm', 0)",
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
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'dispatcher', 'opus', 'L2', 'tok-disp', 0)",
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

  // After a card is approved there is a branch, and re-cutting is the boss's respec.
  db.run("UPDATE grp SET status = 'RUNNING' WHERE id = 2");
  const late = await post(
    app,
    "/orch/split",
    { group_id: 2, requirements: [{ idea: "a" }, { idea: "b" }] },
    "tok-disp",
  );
  expect(late.status).toBe(422);
  expect(await late.text()).toContain("respec");
});

test("a group blocked outside its boundary hands the work on and waits for it", async () => {
  // The gap seen whole: pm-ai-agent's gate failed on a missing line in
  // tsconfig.json, which is not in its owns, so the sandbox refused the write. No
  // verb opened a requirement for it and `orch mail` creates no work, so it rewrote
  // its own code three times, escalated, and stopped.
  const h = harness();
  // The path check is against the real repo: an invented path must not be able to
  // stop a group, so there has to be a repo for it to be absent from.
  const repo = mkdtempSync(join(tmpdir(), "orch-blocked-"));
  writeFileSync(join(repo, "package.json"), "{}");
  mkdirSync(join(repo, "src", "a"), { recursive: true });
  writeFileSync(join(repo, "src", "a", "x.ts"), "");
  h.db.run("UPDATE project SET repo_path = ? WHERE id = 1", [repo]);
  h.db.run("UPDATE grp SET owns_json = ? WHERE id = 1", [JSON.stringify(["src/a/**"])]);
  const blocked = (b: unknown, tok = "tok-eng") => post(h.app, "/orch/blocked", b, tok);

  expect((await blocked({ group_id: 1, path: "tsconfig.json" })).status).toBe(422);
  expect((await blocked({ group_id: 1, path: "nope.json", why: "缺一行配置" })).status).toBe(422);
  // Inside its own boundary it is expected to fix it — saying otherwise is the
  // cheap way out of difficult work.
  expect((await blocked({ group_id: 1, path: "src/a/x.ts", why: "缺一行配置" })).status).toBe(422);

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
  const h = harness();
  h.ctx.git = async () => ({ code: 1, out: "fatal: disk full" });
  h.db.run("UPDATE grp SET status = 'DRAFT', approved_at = 1 WHERE id = 1");
  h.db.run("UPDATE project SET repo_path = '/tmp/nope' WHERE id = 1");

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
