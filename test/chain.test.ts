import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { openMemory, type DB } from "../src/db.ts";
import { abstain, answer, entryPoint, isReserved, revoke, route, triage, TRIAGE } from "../src/mech/flow/chain.ts";
import { SayBody } from "../src/api/orch/messaging.ts";
import { TriageBody } from "../src/api/orch/escalation.ts";
import { Scheduler } from "../src/scheduler.ts";
import { makeApp, type Ctx } from "../src/api.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";
import type { Json } from "../src/http/respond.ts";

function harness(opts: { withArchitect?: boolean; withCos?: boolean; withPm?: boolean } = {}) {
  const db: DB = openMemory();
  seedAuth(db);
  const bus = new Bus(db);
  const sched = new Scheduler(db, async () => {});
  const _cfg = loadConfig();
  const notified: number[] = [];
  const ctx: Ctx = {
    db,
    bus,
    sched,
    sandbox: fakeSandbox(),
    waiters: new Map(),
    config: _cfg,
    notifyBoss: (id) => void notified.push(id),
  };
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'engineer', 'm', 'tok-eng', 0)",
  );
  if (opts.withPm !== false) {
    db.run(
      "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'pm', 'm', 'tok-pm', 0)",
    );
  }
  if (opts.withArchitect) {
    db.run(
      "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, NULL, 'architect', 'm', 'tok-arch', 0)",
    );
  }
  if (opts.withCos) {
    db.run(
      "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, NULL, 'cos', 'm', 'tok-cos', 0)",
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
  const post = (path: string, body?: Json, token?: string) =>
    app(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: { "content-type": "application/json", ...(token ? { "x-orch-token": token } : {}) },
      }),
    );

  return { db, ctx, sched, ask, notified, post, deps: { ctx, notifyBoss: ctx.notifyBoss } };
}

const jobsFor = (db: DB) =>
  db
    .query<{ payload_json: string; agent_id: number | null }, []>(
      "SELECT payload_json, agent_id FROM job WHERE kind = 'agent_turn'",
    )
    .all();

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

  expect(
    h.db.query<{ chain_state: string }, [number]>("SELECT chain_state FROM escalation WHERE id = ?").get(id)!
      .chain_state,
  ).toBe("architect");
  const said = h.db.query<{ body: string }, []>("SELECT body FROM event WHERE author = 'pm'").get()!;
  expect(said.body).toContain("architecture, not scope");
});

test("a level's answer unblocks the caller and un-pauses a blocked group", () => {
  const h = harness({ withArchitect: true });
  const id = h.ask("which library?", "blocker");
  h.db.run("UPDATE escalation SET chain_state = 'architect' WHERE id = ?", [id]);
  h.db.run("UPDATE grp SET status = 'PAUSED' WHERE id = 1");
  let got = "";
  h.ctx.waiters.set(`escalation:${id}`, (v) => (got = v));

  expect(answer(h.deps, { escId: id, by: "architect", answer: "use the stdlib one" }).ok).toBe(true);
  expect(got).toBe("use the stdlib one");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("RUNNING");
  expect(
    h.db.query<{ answered_by: string }, [number]>("SELECT answered_by FROM escalation WHERE id = ?").get(id)!
      .answered_by,
  ).toBe("architect");
});

test("the CoS may only answer from a recorded decision", () => {
  const h = harness({ withCos: true });
  const id = h.ask("do we keep the legacy header path?");
  h.db.run("UPDATE escalation SET chain_state = 'cos' WHERE id = ?", [id]);

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
  expect(
    h.db.query<{ ref_note_id: number }, [number]>("SELECT ref_note_id FROM escalation WHERE id = ?").get(id)!
      .ref_note_id,
  ).toBe(2);
});

test("no stand-in may answer a reserved question, precedent or not", () => {
  const h = harness({ withCos: true });
  const id = h.ask("should we pay for more quota?");
  h.db.run("UPDATE escalation SET chain_state = 'cos' WHERE id = ?", [id]);
  h.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (1, 'decision', 'zh', '以前批过一次', 0)");
  const r = answer(h.deps, { escId: id, by: "cos", answer: "yes, we did before", refNoteId: 1 });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("reserved for the boss");
  // The boss still can.
  expect(answer(h.deps, { escId: id, by: "boss", answer: "no" }).ok).toBe(true);
});

test("revoking a stand-in's answer reopens it and rolls the checkout back", async () => {
  const h = harness({ withCos: true });
  const id = h.ask("keep the legacy path?");
  h.db.run("UPDATE escalation SET checkpoint_sha = 'deadbeef', chain_state = 'cos' WHERE id = ?", [id]);
  h.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (1, 'decision', 'zh', 'x', 0)");
  answer(h.deps, { escId: id, by: "cos", answer: "keep it", refNoteId: 1 });
  h.sched.enqueue("agent_turn", { grp_id: 1 });

  const out = await revoke(h.deps, id);
  // Without a reversible undo, delegated answers are an irreversible bet and the
  // boss would rightly never turn them on.
  expect(out.rolledBackTo).toBe("deadbeef");
  expect(out.answeredBy).toBe("cos");
  const esc = h.db
    .query<{ chain_state: string; answer: string | null }, [number]>(
      "SELECT chain_state, answer FROM escalation WHERE id = ?",
    )
    .get(id)!;
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
  //
  // PLANNING, not DRAFT: DRAFT is the state that blocks dispatch, so it would have
  // stopped the Dispatcher turn respec exists to run. The group is back to being
  // re-scoped, and a new card is what returns it to DRAFT.
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PLANNING");
  expect(JSON.parse(jobsFor(h.db).at(-1)!.payload_json).respec).toContain("not what I asked");
});

test("reject dissolves the group so it stops holding its paths", () => {
  const h = harness();
  h.sched.enqueue("agent_turn", { grp_id: 1 });
  triage(h.deps, 1, "reject", "dropping this");
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'cancelled'").get()!.c).toBe(1);
  // Cancelling the queue left it ACTIVE, so a requirement nobody wanted went on
  // blocking one they did. No retro turn: no status a dropped group has is
  // dispatchable, so the one that used to be enqueued here sat pending forever.
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("DISSOLVED");
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE state = 'pending'").get()!.c).toBe(0);
});

test("a patch on a card still waiting for approval rewrites the card", () => {
  // There is no PM before approval and no work in flight to correct. Sending the
  // addition to one meant nobody read it, and the boss approved a card that did
  // not contain what they had just asked for.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'DRAFT' WHERE id = 1");
  triage(h.deps, 1, "patch", "还要支持中文");
  expect(h.db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()!.status).toBe("PLANNING");
  const p = JSON.parse(jobsFor(h.db).at(-1)!.payload_json);
  expect(p.role).toBe("dispatcher");
  expect(p.rejection).toContain("还要支持中文");
});

test("triage records the boss's words verbatim on the blackboard, once", () => {
  const h = harness();
  // Wired the way the server wires it. `deps.bossFact?.(…) ?? fallback` always ran
  // the fallback too — bossFact returns undefined whether or not it fired — so
  // every sentence was written twice and the 记录 tab showed each one doubled.
  // Without a bossFact here the test takes the fallback branch and proves nothing.
  const deps = {
    ...h.deps,
    bossFact: (g: number | null, body: string) =>
      void h.db.run("INSERT INTO note (grp_id, kind, lang, body, at) VALUES (?, 'fact', 'zh', ?, 0)", [g, body]),
  };
  triage(deps, 1, "patch", "错误提示太含糊");
  const notes = h.db.query<{ body: string }, []>("SELECT body FROM note WHERE kind = 'fact'").all();
  expect(notes).toHaveLength(1);
  expect(notes[0]!.body).toContain("错误提示太含糊");
});

test("both triage doors spell the verbs from TRIAGE, not each from its own copy", () => {
  // They did not. `/api/say` declared `as: z.string().max(40)` and re-listed the
  // three words inside the handler behind an unchecked `as Triage`, while
  // `/orch/triage` had its own `z.enum`. A fourth verb added to `Triage` would
  // have compiled against both and been refused at runtime by one of them, and
  // the schema was meanwhile telling every caller it took any 40-character
  // string. This fails if one door is updated and the other is not.
  for (const as of TRIAGE) {
    expect(SayBody.safeParse({ body: "x", as }).success).toBe(true);
    expect(TriageBody.safeParse({ group_id: 1, as }).success).toBe(true);
  }
  expect(SayBody.safeParse({ body: "x", as: "delete" }).success).toBe(false);
  expect(TriageBody.safeParse({ group_id: 1, as: "delete" }).success).toBe(false);
});

test("only the CoS triages, and only reviewers answer their own level", async () => {
  const h = harness({ withCos: true });
  expect((await h.post("/orch/triage", { group_id: 1, as: "patch", note: "x" }, "tok-eng")).status).toBe(422);
  expect((await h.post("/orch/triage", { group_id: 1, as: "nonsense", note: "x" }, "tok-cos")).status).toBe(400);
  expect((await h.post("/orch/triage", { group_id: 1, as: "patch", note: "x" }, "tok-cos")).status).toBe(200);
});

test("an answer-chain token cannot answer another level or group's question", async () => {
  const h = harness({ withArchitect: true });
  const id = h.ask("where should the seam go?");

  expect((await h.post("/orch/answer", { escalation_id: id, answer: "guess" }, "tok-eng")).status).toBe(422);
  expect((await h.post("/orch/answer", { escalation_id: id, answer: "skip" }, "tok-arch")).status).toBe(422);

  h.db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g2', 'RUNNING', 0)");
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 2, 'pm', 'm', 'tok-pm-2', 0)",
  );
  expect((await h.post("/orch/answer", { escalation_id: id, abstain: true }, "tok-pm-2")).status).toBe(422);
  expect(
    h.db.query<{ chain_state: string }, [number]>("SELECT chain_state FROM escalation WHERE id = ?").get(id)!
      .chain_state,
  ).toBe("pm");
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

test("mailing a role that has no agent yet hires one instead of doing nothing", async () => {
  const h = harness();
  const hired: string[] = [];
  h.ctx.knownRoles = () => ["pm", "architect", "cos", "engineer"];
  h.ctx.hire = (grpId, role) => {
    hired.push(role);
    return h.db
      .query<{ id: number }, [string]>(
        "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, NULL, ?, 'm', hex(randomblob(8)), 0) RETURNING id",
      )
      .get(role)!.id;
  };

  const r = await h.post(
    "/orch/mail",
    { target: "architect", intent: "ask", body: "objection to this split?" },
    "tok-eng",
  );
  // A silent no-op is how an agent ends up asking a wall twice and then giving up
  // — which is exactly what the first live run did.
  expect(r.status).toBe(200);
  expect(hired).toEqual(["architect"]);
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'agent_turn'").get()!.c).toBe(1);
});

test("mailing a role that does not exist says so, and lists what does", async () => {
  const h = harness();
  h.ctx.knownRoles = () => ["pm", "architect"];
  const r = await h.post("/orch/mail", { target: "wizard", intent: "ask", body: "hi" }, "tok-eng");
  expect(r.status).toBe(422);
  const text = await r.text();
  expect(text).toContain("no such recipient");
  expect(text).toContain("architect");
});

test("an unhired standing level is a level, not a reason to bother the boss", () => {
  const h = harness({ withPm: false });
  h.ctx.knownRoles = () => ["architect", "cos"];
  h.ctx.hire = (_g, role) =>
    h.db
      .query<{ id: number }, [string]>(
        "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, NULL, ?, 'm', hex(randomblob(8)), 0) RETURNING id",
      )
      .get(role)!.id;
  const id = h.ask("where should the seam go?");
  expect(route(h.deps, id)).toBe("architect");
  expect(h.notified).toEqual([]);
});

test("a reply reaches the existing holder of a role instead of hiring a second one", async () => {
  const h = harness();
  h.ctx.knownRoles = () => ["pm", "dispatcher", "architect"];
  let hires = 0;
  h.ctx.hire = () => {
    hires++;
    return 99;
  };
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'dispatcher', 'm', 'tok-disp', 0)",
  );
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, NULL, 'architect', 'm', 'tok-arch', 0)",
  );

  // The Architect has no group, so a role lookup scoped to its own group would
  // find nothing and hire — which is how one project paid for two opus Dispatchers.
  const r = await h.post("/orch/mail", { target: "dispatcher", intent: "inform", body: "objection: …" }, "tok-arch");
  expect(r.status).toBe(200);
  expect(hires).toBe(0);
  const woken = h.db.query<{ agent_id: number }, []>("SELECT agent_id FROM job WHERE kind = 'agent_turn'").get()!;
  expect(woken.agent_id).toBe(
    h.db.query<{ id: number }, []>("SELECT id FROM agent WHERE role = 'dispatcher'").get()!.id,
  );
});

test("a standing agent's mail is filed under the recipient's group, not nowhere", async () => {
  const h = harness();
  h.ctx.knownRoles = () => ["pm", "dispatcher", "architect"];
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'dispatcher', 'm', 'tok-disp', 0)",
  );
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, NULL, 'architect', 'm', 'tok-arch', 0)",
  );

  await h.post(
    "/orch/mail",
    { target: "dispatcher", intent: "inform", body: "反对：locale 推断与验收冲突" },
    "tok-arch",
  );

  // Stamped with the sender's group, this lands as NULL and vanishes from the
  // group's timeline — which is how a real objection went unseen while the card
  // it argued with said 反对 : 无.
  const e = h.db
    .query<{ grp_id: number | null; body: string }, []>(
      "SELECT grp_id, body FROM event WHERE author = 'architect' AND kind = 'say'",
    )
    .get()!;
  expect(e.grp_id).toBe(1);
});

test("an empty mail body is refused instead of waking someone with nothing to read", async () => {
  const h = harness();
  h.ctx.knownRoles = () => ["architect"];
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'engineer', 'm', 'tok-e', 0)",
  );
  // What a real run produced: the Dispatcher invented `--wait`, the parser took
  // it as a flag, and the mail went out with no message at all.
  const r = await h.post("/orch/mail", { target: "architect", intent: "ask", body: "" }, "tok-e");
  expect(r.status).toBe(422);
  const said = await r.text();
  expect(said).toContain("empty body");
  expect(said).toContain("--wait");
  expect(h.db.query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'agent_turn'").get()!.c).toBe(0);
});

test("the boss can hand a question to the Architect instead of answering it", async () => {
  const h = harness();
  h.ctx.knownRoles = () => ["pm", "architect", "cos"];
  h.db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, NULL, 'architect', 'm', 'tok-arch', 0)",
  );
  const id = h.ask("用哪个校验库？");
  const r = await h.post(`/api/escalations/${id}/delegate`, { to: "architect" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ message: "architect" });
  // The Architect is actually woken, not just recorded as the new owner.
  const job = h.db
    .query<{ agent_id: number; payload_json: string }, []>(
      "SELECT agent_id, payload_json FROM job WHERE kind = 'agent_turn' ORDER BY id DESC",
    )
    .get()!;
  expect(JSON.parse(job.payload_json).escalation).toBe(id);
});

test("delegating to the boss is refused — that is where it already is", async () => {
  const h = harness();
  const id = h.ask("x");
  const r = await h.post(`/api/escalations/${id}/delegate`, { to: "boss" });
  expect(r.status).toBe(400);
});

test("a stopped group's question goes straight to the boss", () => {
  // Every level below the boss answers by taking a turn, and a turn on a paused
  // group is never dispatched. A blocker filed by sendBack sat at chain_state='pm'
  // for two hours — on a group sendBack had itself just paused — and the boss's
  // only symptom was a group that had stopped for no stated reason.
  const h = harness();
  h.db.run("UPDATE grp SET status = 'PAUSED' WHERE id = 1");
  const id = h.db
    .query<{ id: number }, []>(
      `INSERT INTO escalation (grp_id, severity, question, created_at)
       VALUES (1, 'blocker', 'S1 failed the gate 3 times', unixepoch() * 1000) RETURNING id`,
    )
    .get()!.id;
  expect(route(h.deps, id)).toBe("boss");
  expect(
    h.db.query<{ chain_state: string }, [number]>("SELECT chain_state FROM escalation WHERE id = ?").get(id)!
      .chain_state,
  ).toBe("boss");
});
