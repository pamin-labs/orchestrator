import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { openMemory, type DB } from "../src/db.ts";
import { RepoLock } from "../src/mech/gitlock.ts";
import { abstain, answer, entryPoint, isReserved, revoke, route, triage } from "../src/mech/chain.ts";
import { Scheduler } from "../src/scheduler.ts";
import { makeApp, type Ctx } from "../src/api.ts";

function harness(opts: { withArchitect?: boolean; withCos?: boolean; withPm?: boolean } = {}) {
  const db: DB = openMemory();
  const bus = new Bus(db);
  const sched = new Scheduler(db, async () => {});
  const cfg = loadConfig();
  const notified: number[] = [];
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gitLock: new RepoLock(),
    git: async () => ({ code: 0, out: "abc123" }),
    waiters: new Map(),
    config: { language: "中文", difficultyModel: cfg.difficultyModel, workRoot: "/tmp/x" },
    notifyBoss: (id) => void notified.push(id),
  };
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'engineer', 'm', 'tok-eng', 0)",
  );
  if (opts.withPm !== false) {
    db.run(
      "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, 1, 'pm', 'm', 'L2', 'tok-pm', 0)",
    );
  }
  if (opts.withArchitect) {
    db.run(
      "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, NULL, 'architect', 'm', 'L2', 'tok-arch', 0)",
    );
  }
  if (opts.withCos) {
    db.run(
      "INSERT INTO agent (project_id, grp_id, role, model, clearance, token, created_at) VALUES (1, NULL, 'cos', 'm', 'L2', 'tok-cos', 0)",
    );
  }

  const ask = (question: string, severity = "advisory") =>
    db
      .query<{ id: number }, [string, string]>(
        `INSERT INTO escalation (grp_id, agent_id, severity, question, chain_state, created_at)
         VALUES (1, 1, ?, ?, 'pm', unixepoch() * 1000) RETURNING id`,
      )
      .get(severity, question)!.id;

  const app = makeApp(ctx);
  const post = (path: string, body?: unknown, token?: string) =>
    app(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: token ? { "x-orch-token": token } : undefined,
      }),
    );

  return { db, ctx, sched, ask, notified, post, deps: { ctx, git: ctx.git, notifyBoss: ctx.notifyBoss } };
}

const jobsFor = (db: DB) =>
  db.query<{ payload_json: string; agent_id: number | null }, []>(
    "SELECT payload_json, agent_id FROM job WHERE kind = 'agent_turn'",
  ).all();

test("an ordinary question starts at the PM", () => {
  const h = harness();
  const id = h.ask("should this live in middleware or in the handler?");
  expect(route(h.deps, id)).toBe("pm");
  expect(jobsFor(h.db).length).toBe(1);
});

test("reserved topics skip the whole chain and go straight to the boss", () => {
  for (const q of [
    "should we pay for the higher API tier?",
    "can I merge this into main?",
    "what is the value of the API_KEY?",
    "should we deploy to production now?",
    "the boss wanted rate limiting — should we drop the audit log instead?",
    "这个要花钱吗？",
    "要不要改需求范围？",
  ]) {
    expect(isReserved(q)).toBe(true);
    expect(entryPoint(q)).toBe("boss");
  }
  expect(isReserved("which validation library should we use?")).toBe(false);
});

test("a missing level is skipped, not waited on", () => {
  const h = harness({ withPm: false, withCos: true });
  const id = h.ask("technology choice");
  // No PM and no Architect in this setup: an absent level must not stall a
  // question, so it lands on the CoS.
  expect(route(h.deps, id)).toBe("cos");
});

test("with nobody in the chain it reaches the boss and notifies", () => {
  const h = harness({ withPm: false });
  const id = h.ask("anything");
  expect(route(h.deps, id)).toBe("boss");
  expect(h.notified).toEqual([id]);
});

test("abstaining moves the question up one level, and says why", () => {
  const h = harness({ withArchitect: true });
  const id = h.ask("where should the seam go?");
  route(h.deps, id);
  abstain(h.deps, id, "pm", "architecture, not scope");

  expect(h.db.query<{ chain_state: string }, [number]>("SELECT chain_state FROM escalation WHERE id = ?").get(id)!.chain_state).toBe("architect");
  const said = h.db.query<{ body: string }, []>("SELECT body FROM event WHERE author = 'pm'").get()!;
  expect(said.body).toContain("architecture, not scope");
});

test("a level's answer unblocks the caller and un-pauses a blocked group", () => {
  const h = harness({ withArchitect: true });
  const id = h.ask("which library?", "blocker");
  h.db.run("UPDATE grp SET status = 'PAUSED' WHERE id = 1");
  let got = "";
  h.ctx.waiters.set(`escalation:${id}`, (v) => (got = v));

  expect(answer(h.deps, { escId: id, by: "architect", answer: "use the stdlib one" }).ok).toBe(true);
  expect(got).toBe("use the stdlib one");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("RUNNING");
  expect(h.db.query<{ answered_by: string }, [number]>("SELECT answered_by FROM escalation WHERE id = ?").get(id)!.answered_by).toBe("architect");
});

test("the CoS may only answer from a recorded decision", () => {
  const h = harness({ withCos: true });
  const id = h.ask("do we keep the legacy header path?");

  // No citation: refused. Speaking for the boss without precedent is guessing.
  const bare = answer(h.deps, { escId: id, by: "cos", answer: "keep it" });
  expect(bare.ok).toBe(false);
  if (!bare.ok) expect(bare.error).toContain("cite the decision");

  h.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (1, 'journal', 'zh', 'unrelated', 0)");
  const wrongKind = answer(h.deps, { escId: id, by: "cos", answer: "keep it", refNoteId: 1 });
  expect(wrongKind.ok).toBe(false);

  h.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (1, 'decision', 'zh', '老 client 必须继续可用', 0)");
  const ok = answer(h.deps, { escId: id, by: "cos", answer: "keep it", refNoteId: 2 });
  expect(ok.ok).toBe(true);
  expect(h.db.query<{ ref_note_id: number }, [number]>("SELECT ref_note_id FROM escalation WHERE id = ?").get(id)!.ref_note_id).toBe(2);
});

test("no stand-in may answer a reserved question, precedent or not", () => {
  const h = harness({ withCos: true });
  const id = h.ask("should we pay for more quota?");
  h.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (1, 'decision', 'zh', '以前批过一次', 0)");
  const r = answer(h.deps, { escId: id, by: "cos", answer: "yes, we did before", refNoteId: 1 });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("reserved for the boss");
  // The boss still can.
  expect(answer(h.deps, { escId: id, by: "boss", answer: "no" }).ok).toBe(true);
});

test("revoking a stand-in's answer reopens it and rolls the worktree back", async () => {
  const h = harness({ withCos: true });
  const id = h.ask("keep the legacy path?");
  h.db.run("UPDATE grp SET worktree = '/tmp/wt/g1' WHERE id = 1");
  h.db.run("UPDATE escalation SET checkpoint_sha = 'deadbeef' WHERE id = ?", [id]);
  h.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (1, 'decision', 'zh', 'x', 0)");
  answer(h.deps, { escId: id, by: "cos", answer: "keep it", refNoteId: 1 });
  h.sched.enqueue("agent_turn", { grp_id: 1 });

  const out = await revoke(h.deps, id);
  // Without a reversible undo, delegated answers are an irreversible bet and the
  // boss would rightly never turn them on.
  expect(out.rolledBackTo).toBe("deadbeef");
  expect(out.answeredBy).toBe("cos");
  const esc = h.db.query<{ chain_state: string; answer: string | null }, [number]>(
    "SELECT chain_state, answer FROM escalation WHERE id = ?",
  ).get(id)!;
  expect(esc.chain_state).toBe("boss");
  expect(esc.answer).toBeNull();
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'cancelled'").get()!.c).toBe(1);
});

test("answering twice is refused", () => {
  const h = harness();
  const id = h.ask("q");
  expect(answer(h.deps, { escId: id, by: "pm", answer: "a" }).ok).toBe(true);
  expect(answer(h.deps, { escId: id, by: "pm", answer: "b" }).ok).toBe(false);
});

// -------------------------------------------------------------------- triage

test("patch keeps the work and asks the PM for a correction", () => {
  const h = harness();
  triage(h.deps, 1, "patch", "tests are too shallow");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("RUNNING");
  expect(JSON.parse(jobsFor(h.db).at(-1)!.payload_json).rejection).toContain("too shallow");
});

test("respec sends the whole thing back to be re-scoped", () => {
  const h = harness();
  triage(h.deps, 1, "respec", "this is not what I asked for");
  // Without respec every complaint is heard as "change this line", and a wrong
  // decomposition can never be corrected.
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("DRAFT");
  expect(JSON.parse(jobsFor(h.db).at(-1)!.payload_json).respec).toContain("not what I asked");
});

test("reject stops the work but still demands the retro", () => {
  const h = harness();
  h.sched.enqueue("agent_turn", { grp_id: 1 });
  triage(h.deps, 1, "reject", "dropping this");
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'cancelled'").get()!.c).toBe(1);
  // An abandoned group is exactly the kind whose lesson is worth keeping.
  expect(JSON.parse(jobsFor(h.db).at(-1)!.payload_json).rejection).toContain("retro");
});

test("triage records the boss's words verbatim on the blackboard", () => {
  const h = harness();
  triage(h.deps, 1, "patch", "错误提示太含糊");
  const note = h.db.query<{ body: string }, []>("SELECT body FROM note WHERE kind = 'fact'").get()!;
  expect(note.body).toContain("错误提示太含糊");
});

test("only the CoS triages, and only reviewers answer their own level", async () => {
  const h = harness({ withCos: true });
  expect((await h.post("/orch/triage", { group_id: 1, as: "patch", note: "x" }, "tok-eng")).status).toBe(422);
  expect((await h.post("/orch/triage", { group_id: 1, as: "nonsense", note: "x" }, "tok-cos")).status).toBe(422);
  expect((await h.post("/orch/triage", { group_id: 1, as: "patch", note: "x" }, "tok-cos")).status).toBe(200);
});

test("the agent-side answer verb routes through the same chain the boss uses", async () => {
  const h = harness({ withArchitect: true });
  const id = h.ask("where should the seam go?");
  let got = "";
  h.ctx.waiters.set(`escalation:${id}`, (v) => (got = v));

  const r = await h.post("/orch/answer", { escalation_id: id, answer: "at the middleware boundary" }, "tok-pm");
  expect(r.status).toBe(200);
  expect(got).toBe("at the middleware boundary");
});

test("abstaining over the wire passes the question up", async () => {
  const h = harness({ withArchitect: true });
  const id = h.ask("where should the seam go?");
  await h.post("/orch/answer", { escalation_id: id, abstain: true, why: "design call" }, "tok-pm");
  expect(
    h.db.query<{ chain_state: string }, [number]>("SELECT chain_state FROM escalation WHERE id = ?").get(id)!
      .chain_state,
  ).toBe("architect");
});
