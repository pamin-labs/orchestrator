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
    config: { language: "中文", difficultyModel: { trivial: "haiku", normal: "sonnet", hard: "opus" } },
  };
  const app = makeApp(ctx);

  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, worktree, created_at) VALUES (1, 'g1', 'RUNNING', ?, 0)", [
    opts.worktree ?? null,
  ]);
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, created_at) VALUES (1, 1, 'engineer', 'sonnet', 'L1', 0)",
  );
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, clearance, created_at) VALUES (1, 1, 'qa', 'sonnet', 'L1', 0)",
  );
  return { db, bus, sched, ctx, app, ran, engineer: 1, qa: 2 };
}

const post = (app: (r: Request) => Promise<Response>, path: string, body?: unknown) =>
  app(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }));
const get = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`));

test("an over-long journal is rejected with a reason the agent can act on", async () => {
  const { app } = harness();
  const r = await post(app, "/orch/journal", {
    agent_id: 1,
    kind: "journal",
    body: "a\nb\nc\nd\ne\nf\ng",
  });
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("max 6");
});

test("journal writes a note and exports journal/retro into the worktree", async () => {
  const wt = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const { app, db } = harness({ worktree: wt });

  const r = await post(app, "/orch/journal", {
    agent_id: 1,
    kind: "journal",
    body: "Moved token check into middleware.",
    files: ["auth/mw.ts"],
  });
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
  await post(app, "/orch/journal", { agent_id: 1, kind: "fact", body: "boss prefers iteration" });
  const note = db.query<{ export_path: string | null }, []>("SELECT export_path FROM note").get()!;
  expect(note.export_path).toBeNull();
});

test("mail rejects intents outside the five", async () => {
  const { app } = harness();
  const r = await post(app, "/orch/mail", { agent_id: 1, target: "qa", intent: "handoff", body: "x" });
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("ask, request, inform, note, decision");
});

test("a waking intent enqueues a turn for the named target; note does not", async () => {
  const { app, db } = harness();
  await post(app, "/orch/mail", { agent_id: 1, target: "qa", intent: "request", body: "please verify" });
  let jobs = db.query<{ agent_id: number }, []>("SELECT agent_id FROM job WHERE kind = 'agent_turn'").all();
  expect(jobs.map((j) => j.agent_id)).toEqual([2]);

  await post(app, "/orch/mail", { agent_id: 1, target: "qa", intent: "note", body: "fyi" });
  jobs = db.query<{ agent_id: number }, []>("SELECT agent_id FROM job WHERE kind = 'agent_turn'").all();
  expect(jobs.length).toBe(1);
});

test("ask-boss blocks the caller and a blocker pauses the whole group", async () => {
  const { app, db, ctx } = harness();
  const pending = post(app, "/orch/ask-boss", {
    agent_id: 1,
    severity: "blocker",
    question: "which validation library?",
  });

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
  const r = await post(app, "/orch/lease", { agent_id: 1, resource: "unity", args: {} });
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("Ask the boss");
});

test("a lease with bad args never reaches the queue", async () => {
  const { app, db } = harness();
  db.run(
    `INSERT INTO resource (name, template, arg_schema_json) VALUES
     ('build', 'make {target}', '{"target":{"type":"enum","values":["debug","release"]}}')`,
  );
  const r = await post(app, "/orch/lease", { agent_id: 1, resource: "build", args: { target: "prod; rm -rf ~" } });
  expect(r.status).toBe(422);
  expect(db.query<{ c: number }, []>("SELECT count(*) AS c FROM lease").get()!.c).toBe(0);
});

test("dropping an idea creates a DRAFT group, a channel, and a dispatcher turn", async () => {
  const { app, db } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "add rate limiting to the API" });
  const { grp_id } = (await r.json()) as { grp_id: number };

  expect(db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grp_id)!.status).toBe(
    "DRAFT",
  );
  // channel.grp_id is the only link; grp deliberately has no reverse pointer.
  const ch = db.query<{ id: number }, [number]>("SELECT id FROM channel WHERE grp_id = ?").get(grp_id);
  expect(ch?.id).toBeGreaterThan(0);

  // The idea is on the blackboard verbatim, so a respec can point back at it.
  const note = db.query<{ body: string }, [number]>("SELECT body FROM note WHERE grp_id = ?").get(grp_id)!;
  expect(note.body).toBe("add rate limiting to the API");

  const job = db.query<{ payload_json: string }, [number]>("SELECT payload_json FROM job WHERE grp_id = ?").get(grp_id)!;
  expect(JSON.parse(job.payload_json).role).toBe("dispatcher");
});

test("a DRAFT group does not dispatch until the boss approves", async () => {
  const { app, db, sched, ran } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  await sched.drain();
  expect(ran.length).toBe(0);

  const card = `目标 : x
不做 : y
验收 : bun test 绿
验收 : 无回归
切片 : a [normal] — test a
切片 : b [trivial] — test b
切片 : c [hard] — test c
风险 : none
反对 : 无`;
  const ok = await post(app, `/api/draft/${grp_id}/approve`, { card });
  expect(ok.status).toBe(200);
  expect(db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grp_id)!.status).toBe("RUNNING");

  const slices = db.query<{ title: string; difficulty: string }, [number]>(
    "SELECT title, difficulty FROM slice WHERE grp_id = ? ORDER BY seq",
  ).all(grp_id);
  expect(slices.map((s) => s.difficulty)).toEqual(["normal", "trivial", "hard"]);
  await sched.drain();
  expect(ran.length).toBe(1);
});

test("approving with a malformed card is refused, group stays DRAFT", async () => {
  const { app, db } = harness();
  const r = await post(app, "/api/ideas", { project_id: 1, text: "idea" });
  const { grp_id } = (await r.json()) as { grp_id: number };
  const bad = await post(app, `/api/draft/${grp_id}/approve`, { card: "目标 : only this" });
  expect(bad.status).toBe(422);
  expect(db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(grp_id)!.status).toBe("DRAFT");
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

test("pause reports PAUSING, not PAUSED — an in-flight turn cannot be stopped", async () => {
  const { app, db } = harness();
  await post(app, "/api/groups/1/pause");
  expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PAUSING");
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

  const r = await post(app, "/orch/ctx/query", { agent_id: 1, question: "middleware token check" });
  const out = await r.text();
  expect(out.length).toBeLessThanOrEqual(16_000);
  expect(out).toContain("middleware");
});

test("ctx query with no hits tells the agent what to do instead of returning junk", async () => {
  const { app } = harness();
  const r = await post(app, "/orch/ctx/query", { agent_id: 1, question: "quantum tunnelling" });
  expect(await r.text()).toContain("no matching notes");
});

test("state snapshot carries everything the three views need", async () => {
  const { app } = harness();
  const s = (await (await get(app, "/api/state")).json()) as Record<string, unknown[]>;
  for (const k of ["projects", "groups", "slices", "agents", "tasks", "escalations"]) {
    expect(Array.isArray(s[k])).toBe(true);
  }
  expect(s.agents!.length).toBe(2);
});

test("unknown agent id is refused everywhere", async () => {
  const { app } = harness();
  for (const p of ["/orch/status", "/orch/journal", "/orch/mail", "/orch/ask-boss", "/orch/lease"]) {
    const r = await post(app, p, { agent_id: 999, kind: "journal", body: "x", intent: "note", target: "qa" });
    expect(r.status).toBe(422);
  }
});
