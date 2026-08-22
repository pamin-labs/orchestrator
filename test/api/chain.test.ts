import { describe, expect, test } from "bun:test";
import { and, asc, desc, eq } from "drizzle-orm";
import type { DB } from "../../src/platform/persistence/database.ts";
import { abstain, answer, revoke, route, triage, TRIAGE } from "../../src/mech/flow/chain.ts";
import { ASK_KINDS, TO_BOSS, type AskKind } from "../../src/contracts/states.ts";
import { SayBody } from "../../src/api/orch/messaging.ts";
import { TriageBody } from "../../src/api/orch/escalation.ts";
import { AgentTurnPayloadSchema } from "../../src/platform/scheduling/scheduler.ts";
import { makeApp } from "../../src/composition/api.ts";
import { agent, escalation, event, grp, job, note } from "../../src/platform/persistence/schema.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import type { Json } from "../../src/contracts/json.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

async function harness(
  opts: {
    withArchitect?: boolean;
    withCos?: boolean;
    withPm?: boolean;
    /** The second reader `answerError` consults before a stand-in may answer.
     *  Absent by default, which is the "no cheap model configured" deployment. */
    verdict?: (prompt: string) => Promise<string>;
  } = {},
) {
  const notified: number[] = [];
  const ctx = await testContext({
    sandbox: fakeSandbox(),
    notifyBoss: (id) => void notified.push(id),
    ...(opts.verdict ? { askIn: () => opts.verdict! } : {}),
  });
  const db = ctx.db;
  const sched = ctx.sched;
  await seedAuth(db);
  const f = fx.on(db);
  const p = await f.project.create({ name: "p" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  await f.agent.create({ project_id: p.id, grp_id: g.id, token: "tok-eng" });
  if (opts.withPm !== false) {
    await f.agent.create({ project_id: p.id, grp_id: g.id, role: "pm", token: "tok-pm" });
  }
  if (opts.withArchitect) {
    await f.agent.create({ project_id: p.id, role: "architect", token: "tok-arch" });
  }
  if (opts.withCos) {
    await f.agent.create({ project_id: p.id, role: "cos", token: "tok-cos" });
  }

  // `created_at` is now, not 0: the chain's timers are read against the clock.
  const ask = async (question: string, severity = "advisory", kind: AskKind | null = "design") =>
    (await f.escalation.create({ grp_id: 1, agent_id: 1, severity, question, kind, created_at: Date.now() })).id;

  const app = makeApp(ctx);
  const post = (path: string, body?: Json, token?: string) =>
    app(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...(token ? { "x-orch-token": token } : {}),
        },
      }),
    );

  const deps = { ctx, ...(ctx.notifyBoss ? { notifyBoss: ctx.notifyBoss } : {}) };
  return { db, ctx, sched, ask, notified, post, deps, f };
}

/** `payload_json` is `jsonb`: it comes back parsed, so nothing here re-parses it. */
const jobsFor = (db: DB) =>
  db
    .select({ payload_json: job.payload_json, agent_id: job.agent_id })
    .from(job)
    .where(eq(job.kind, "agent_turn"))
    .orderBy(asc(job.id));

const stateOf = async (db: DB, id: number) =>
  (await db.select({ s: escalation.chain_state }).from(escalation).where(eq(escalation.id, id)))[0]?.s;

const grpStatus = async (db: DB) => (await db.select({ s: grp.status }).from(grp).where(eq(grp.id, 1)))[0]?.s;

const jobsInState = async (db: DB, state: (typeof job.state.enumValues)[number]) =>
  (await db.select({ id: job.id }).from(job).where(eq(job.state, state))).length;

test("an ordinary question starts at the PM", async () => {
  const h = await harness();
  const id = await h.ask("should this live in middleware or in the handler?");
  expect(await route(h.deps, id)).toBe("pm");
  expect((await jobsFor(h.db)).length).toBe(1);
});

/**
 * The gate at the asking end: one word, and which half of the vocabulary it is
 * in.
 *
 * This was ten rows of per-language keyword regex against the question's prose —
 * about sixty lines, whose own comment recorded sixteen of eighteen probes
 * leaking before the other eight language rows existed. An agent writes in
 * `output.language` and a keyword list is a guess; the word is not.
 */
describe("the kind decides where a question starts", () => {
  test("the five reserved kinds go straight to the boss", () => {
    expect([...TO_BOSS].sort()).toEqual(["budget", "credential", "deploy", "merge", "scope"]);
  });

  test("and the rest start at the PM", () => {
    expect(ASK_KINDS.filter((k) => !TO_BOSS.has(k))).toEqual(["env", "spec", "boundary", "design"]);
  });

  /** There is no `other`, and no `none`: an escalation is about something, and
   *  the two enums this replaced were two axes for one fact. */
  test("the vocabulary has no way to say nothing", () => {
    expect(ASK_KINDS).not.toContain("other");
    expect(ASK_KINDS).not.toContain("none");
  });
});

/**
 * The gate at the answering end, which is where the damage would happen.
 *
 * The word above is the asker's, and the agent that saves itself a round trip by
 * filing a budget question as `env` is the same agent that files. So before a
 * stand-in may answer, the stored kind is checked and — if it is not one of the
 * five — a second reader is shown the question and asked whether it is anyway.
 */
describe("a stand-in may not answer a reserved question", () => {
  const stand = async (h: Awaited<ReturnType<typeof harness>>, id: number) => {
    await h.db.update(escalation).set({ chain_state: "cos" }).where(eq(escalation.id, id));
    const precedent = await h.f.note.create({ grp_id: 1, kind: "decision", body: "approved once before" });
    return answer(h.deps, { escId: id, by: "cos", answer: "yes, we did before", refNoteId: precedent.id });
  };

  /** The stored word, read as a key. The prose is not consulted at all — the same
   *  move `dedupe_key` made one column over. */
  test("the stored kind is enough, and the question's wording is never read", async () => {
    const h = await harness({ withCos: true });
    // Wording that no keyword list would have caught, and a kind that says it.
    const id = await h.ask("can we go ahead with the thing we discussed?", "advisory", "budget");
    const r = await stand(h, id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("reserved for the boss");
    expect((await answer(h.deps, { escId: id, by: "boss", answer: "no" })).ok).toBe(true);
  });

  /** The half a declaration cannot buy: the asker filed it low. */
  test("a misfiled question is caught by the second reader", async () => {
    const h = await harness({ withCos: true, verdict: async () => "yes" });
    const id = await h.ask("should we pay for more quota?", "advisory", "env");
    const r = await stand(h, id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("reserved for the boss");
  });

  test("and an ordinary question is not", async () => {
    const h = await harness({ withCos: true, verdict: async () => "no" });
    const id = await h.ask("which validation library should we use?", "advisory", "design");
    expect((await stand(h, id)).ok).toBe(true);
  });

  /**
   * A check that could not run is not a check that passed. This is what keeps
   * the property the declared-topic flag had: no path routes a question *away*
   * from the boss.
   */
  const broken: [string, () => Promise<string>][] = [
    ["the reader throws", () => Promise.reject(new Error("container gone"))],
    ["the reader says something that is not a verdict", async () => "I think probably not, because"],
    ["the reader says nothing", async () => ""],
  ];
  test.each(broken)("%s, so it raises", async (_name, verdict) => {
    const h = await harness({ withCos: true, verdict });
    const id = await h.ask("should we pay for more quota?", "advisory", "env");
    const r = await stand(h, id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("reserved for the boss");
  });

  /**
   * No second reader at all is a *configuration*, not a failed check:
   * `indexModel.model` empty turns the cheap tier off. Failing closed here would
   * leave a stand-in unable to answer anything on such a deployment.
   */
  test("with no cheap model wired at all, the declared kind is the whole gate", async () => {
    const h = await harness({ withCos: true });
    expect((await stand(h, await h.ask("which library?", "advisory", "design"))).ok).toBe(true);
    const money = await h.ask("should we pay for more quota?", "advisory", "budget");
    expect((await stand(h, money)).ok).toBe(false);
  });

  /** Rows filed before the column exists carry no kind, and reach the reader on
   *  their prose — which is why nothing had to be backfilled. */
  test("a row with no kind at all still reaches the second reader", async () => {
    const h = await harness({ withCos: true, verdict: async () => "yes" });
    const id = await h.ask("should we pay for more quota?", "advisory", null);
    expect((await stand(h, id)).ok).toBe(false);
  });
});

test("a missing level is skipped, not waited on", async () => {
  const h = await harness({ withPm: false, withCos: true });
  const id = await h.ask("technology choice");
  // No PM and no Architect in this setup: an absent level must not stall a
  // question, so it lands on the CoS.
  expect(await route(h.deps, id)).toBe("cos");
});

test("with nobody in the chain it reaches the boss and notifies", async () => {
  const h = await harness({ withPm: false });
  const id = await h.ask("anything");
  expect(await route(h.deps, id)).toBe("boss");
  expect(h.notified).toEqual([id]);
});

test("abstaining moves the question up one level, and says why", async () => {
  const h = await harness({ withArchitect: true });
  const id = await h.ask("where should the seam go?");
  await route(h.deps, id);
  await abstain(h.deps, id, "pm", "architecture, not scope");

  expect(await stateOf(h.db, id)).toBe("architect");
  const [said] = await h.db.select({ body: event.body }).from(event).where(eq(event.author, "pm"));
  expect(said?.body).toContain("architecture, not scope");
});

test("a level's answer unblocks the caller and un-pauses a blocked group", async () => {
  const h = await harness({ withArchitect: true });
  const id = await h.ask("which library?", "blocker");
  await h.db.update(escalation).set({ chain_state: "architect" }).where(eq(escalation.id, id));
  await h.db.update(grp).set({ status: "PAUSED" }).where(eq(grp.id, 1));
  let got = "";
  h.ctx.waiters.set(`escalation:${id}`, (v) => (got = v));

  expect((await answer(h.deps, { escId: id, by: "architect", answer: "use the stdlib one" })).ok).toBe(true);
  expect(got).toBe("use the stdlib one");
  expect(await grpStatus(h.db)).toBe("RUNNING");
  const [byWhom] = await h.db.select({ by: escalation.answered_by }).from(escalation).where(eq(escalation.id, id));
  expect(byWhom?.by).toBe("architect");
});

test("the CoS may only answer from a recorded decision", async () => {
  const h = await harness({ withCos: true });
  const id = await h.ask("do we keep the legacy header path?");
  await h.db.update(escalation).set({ chain_state: "cos" }).where(eq(escalation.id, id));

  // No citation: refused. Speaking for the boss without precedent is guessing.
  const bare = await answer(h.deps, { escId: id, by: "cos", answer: "keep it" });
  expect(bare.ok).toBe(false);
  if (!bare.ok) expect(bare.error).toContain("cite the decision");

  const journal = await h.f.note.create({ grp_id: 1, kind: "journal", body: "unrelated" });
  const wrongKind = await answer(h.deps, { escId: id, by: "cos", answer: "keep it", refNoteId: journal.id });
  expect(wrongKind.ok).toBe(false);

  const decision = await h.f.note.create({ grp_id: 1, kind: "decision", body: "老 client 必须继续可用" });
  const ok = await answer(h.deps, { escId: id, by: "cos", answer: "keep it", refNoteId: decision.id });
  expect(ok.ok).toBe(true);
  const [cited] = await h.db.select({ ref: escalation.ref_note_id }).from(escalation).where(eq(escalation.id, id));
  expect(cited?.ref).toBe(decision.id);
});

test("revoking a stand-in's answer reopens it and rolls the checkout back", async () => {
  const h = await harness({ withCos: true });
  const id = await h.ask("keep the legacy path?");
  await h.db.update(escalation).set({ checkpoint_sha: "deadbeef", chain_state: "cos" }).where(eq(escalation.id, id));
  const cited = await h.f.note.create({ grp_id: 1, kind: "decision", body: "x" });
  await answer(h.deps, { escId: id, by: "cos", answer: "keep it", refNoteId: cited.id });
  await h.sched.enqueue("agent_turn", { grp_id: 1 });

  const out = await revoke(h.deps, id);
  // Without a reversible undo, delegated answers are an irreversible bet and the
  // boss would rightly never turn them on.
  expect(out.rolledBackTo).toBe("deadbeef");
  expect(out.answeredBy).toBe("cos");
  const [esc] = await h.db
    .select({ chain_state: escalation.chain_state, answer: escalation.answer })
    .from(escalation)
    .where(eq(escalation.id, id));
  expect(esc?.chain_state).toBe("boss");
  expect(esc?.answer).toBeNull();
  expect(await jobsInState(h.db, "cancelled")).toBe(1);
});

test("answering twice is refused", async () => {
  const h = await harness();
  const id = await h.ask("q");
  expect((await answer(h.deps, { escId: id, by: "pm", answer: "a" })).ok).toBe(true);
  expect((await answer(h.deps, { escId: id, by: "pm", answer: "b" })).ok).toBe(false);
});

// -------------------------------------------------------------------- triage

test("patch keeps the work and asks the PM for a correction", async () => {
  const h = await harness();
  await triage(h.deps, 1, "patch", "tests are too shallow");
  expect(await grpStatus(h.db)).toBe("RUNNING");
  expect(AgentTurnPayloadSchema.parse((await jobsFor(h.db)).at(-1)!.payload_json).rejection).toContain("too shallow");
});

test("respec sends the whole thing back to be re-scoped", async () => {
  const h = await harness();
  await triage(h.deps, 1, "respec", "this is not what I asked for");
  // Without respec every complaint is heard as "change this line", and a wrong
  // decomposition can never be corrected.
  //
  // PLANNING, not DRAFT: DRAFT is the state that blocks dispatch, so it would have
  // stopped the Dispatcher turn respec exists to run. The group is back to being
  // re-scoped, and a new card is what returns it to DRAFT.
  expect(await grpStatus(h.db)).toBe("PLANNING");
  expect(AgentTurnPayloadSchema.parse((await jobsFor(h.db)).at(-1)!.payload_json).respec).toContain("not what I asked");
});

test("reject dissolves the group so it stops holding its paths", async () => {
  const h = await harness();
  await h.sched.enqueue("agent_turn", { grp_id: 1 });
  await triage(h.deps, 1, "reject", "dropping this");
  expect(await jobsInState(h.db, "cancelled")).toBe(1);
  // Cancelling the queue left it ACTIVE, so a requirement nobody wanted went on
  // blocking one they did. No retro turn: no status a dropped group has is
  // dispatchable, so the one that used to be enqueued here sat pending forever.
  expect(await grpStatus(h.db)).toBe("DISSOLVED");
  expect(await jobsInState(h.db, "pending")).toBe(0);
});

test("a patch on a card still waiting for approval rewrites the card", async () => {
  // There is no PM before approval and no work in flight to correct. Sending the
  // addition to one meant nobody read it, and the boss approved a card that did
  // not contain what they had just asked for.
  const h = await harness();
  await h.db.update(grp).set({ status: "DRAFT" }).where(eq(grp.id, 1));
  await triage(h.deps, 1, "patch", "还要支持中文");
  expect(await grpStatus(h.db)).toBe("PLANNING");
  const p = AgentTurnPayloadSchema.parse((await jobsFor(h.db)).at(-1)!.payload_json);
  expect(p.role).toBe("dispatcher");
  expect(p.rejection).toContain("还要支持中文");
});

test("triage records the boss's words verbatim on the blackboard, once", async () => {
  const h = await harness();
  // Wired the way the server wires it. `deps.bossFact?.(…) ?? fallback` always ran
  // the fallback too — bossFact returns undefined whether or not it fired — so
  // every sentence was written twice and the `Notes` tab showed each one doubled.
  // Without a bossFact here the test takes the fallback branch and proves nothing.
  const deps = {
    ...h.deps,
    bossFact: async (g: number | null, body: string) => void (await h.f.note.create({ grp_id: g, body })),
  };
  await triage(deps, 1, "patch", "错误提示太含糊");
  const notes = await h.db.select({ body: note.body }).from(note).where(eq(note.kind, "fact"));
  expect(notes).toHaveLength(1);
  expect(notes[0]!.body).toContain("错误提示太含糊");
});

test("both triage doors spell the verbs from TRIAGE, not each from its own copy", async () => {
  // They did not. `/api/v1/say` declared `as: z.string().max(40)` and re-listed the
  // three words inside the handler behind an unchecked `as Triage`, while
  // `/orch/v1/triage` had its own `z.enum`. A fourth verb added to `Triage` would
  // have compiled against both and been refused at runtime by one of them, and
  // the schema was meanwhile telling every caller it took any 40-character
  // string. This fails if one door is updated and the other is not.
  for (const as of TRIAGE) {
    expect({
      say: SayBody.safeParse({ body: "x", as }).success,
      triage: TriageBody.safeParse({ group_id: 1, as }).success,
    }).toEqual({
      say: true,
      triage: true,
    });
  }
  expect({
    say: SayBody.safeParse({ body: "x", as: "delete" }).success,
    triage: TriageBody.safeParse({ group_id: 1, as: "delete" }).success,
  }).toEqual({ say: false, triage: false });
});

test("only the CoS triages, and only reviewers answer their own level", async () => {
  const h = await harness({ withCos: true });
  expect((await h.post("/orch/v1/triage", { group_id: 1, as: "patch", note: "x" }, "tok-eng")).status).toBe(422);
  expect((await h.post("/orch/v1/triage", { group_id: 1, as: "nonsense", note: "x" }, "tok-cos")).status).toBe(400);
  expect((await h.post("/orch/v1/triage", { group_id: 1, as: "patch", note: "x" }, "tok-cos")).status).toBe(200);
});

test("an answer-chain token cannot answer another level or group's question", async () => {
  const h = await harness({ withArchitect: true });
  const id = await h.ask("where should the seam go?");

  expect((await h.post("/orch/v1/answer", { escalation_id: id, answer: "guess" }, "tok-eng")).status).toBe(422);
  expect((await h.post("/orch/v1/answer", { escalation_id: id, answer: "skip" }, "tok-arch")).status).toBe(422);

  await h.f.runningGrp.create({ project_id: 1, name: "g2" });
  await h.f.agent.create({ project_id: 1, grp_id: 2, role: "pm", token: "tok-pm-2" });
  expect((await h.post("/orch/v1/answer", { escalation_id: id, abstain: true }, "tok-pm-2")).status).toBe(422);
  expect(await stateOf(h.db, id)).toBe("pm");
});

test("the agent-side answer verb routes through the same chain the boss uses", async () => {
  const h = await harness({ withArchitect: true });
  const id = await h.ask("where should the seam go?");
  let got = "";
  h.ctx.waiters.set(`escalation:${id}`, (v) => (got = v));

  const r = await h.post("/orch/v1/answer", { escalation_id: id, answer: "at the middleware boundary" }, "tok-pm");
  expect(r.status).toBe(200);
  expect(got).toBe("at the middleware boundary");
});

test("abstaining over the wire passes the question up", async () => {
  const h = await harness({ withArchitect: true });
  const id = await h.ask("where should the seam go?");
  await h.post("/orch/v1/answer", { escalation_id: id, abstain: true, why: "design call" }, "tok-pm");
  expect(await stateOf(h.db, id)).toBe("architect");
});

test("mailing a role that has no agent yet hires one instead of doing nothing", async () => {
  const h = await harness();
  const hired: string[] = [];
  h.ctx.knownRoles = () => ["pm", "architect", "cos", "engineer"];
  h.ctx.hire = async (grpId, role) => {
    hired.push(role);
    return (await h.f.agent.create({ project_id: 1, role, token: crypto.randomUUID() })).id;
  };

  const r = await h.post(
    "/orch/v1/mail",
    { target: "architect", intent: "ask", body: "objection to this split?" },
    "tok-eng",
  );
  // A silent no-op is how an agent ends up asking a wall twice and then giving up
  // — which is exactly what the first live run did.
  expect(r.status).toBe(200);
  expect(hired).toEqual(["architect"]);
  expect(await jobsFor(h.db)).toHaveLength(1);
});

test("mailing a role that does not exist says so, and lists what does", async () => {
  const h = await harness();
  h.ctx.knownRoles = () => ["pm", "architect"];
  const r = await h.post("/orch/v1/mail", { target: "wizard", intent: "ask", body: "hi" }, "tok-eng");
  expect(r.status).toBe(422);
  const text = await r.text();
  expect(text).toContain("no such recipient");
  expect(text).toContain("architect");
});

test("an unhired standing level is a level, not a reason to bother the boss", async () => {
  const h = await harness({ withPm: false });
  h.ctx.knownRoles = () => ["architect", "cos"];
  h.ctx.hire = async (_g, role) => (await h.f.agent.create({ project_id: 1, role, token: crypto.randomUUID() })).id;
  const id = await h.ask("where should the seam go?");
  expect(await route(h.deps, id)).toBe("architect");
  expect(h.notified).toEqual([]);
});

test("a reply reaches the existing holder of a role instead of hiring a second one", async () => {
  const h = await harness();
  h.ctx.knownRoles = () => ["pm", "dispatcher", "architect"];
  let hires = 0;
  h.ctx.hire = async () => {
    hires++;
    return 99;
  };
  await h.f.agent.create({ project_id: 1, grp_id: 1, role: "dispatcher", token: "tok-disp" });
  await h.f.agent.create({ project_id: 1, role: "architect", token: "tok-arch" });

  // The Architect has no group, so a role lookup scoped to its own group would
  // find nothing and hire — which is how one project paid for two opus Dispatchers.
  const r = await h.post("/orch/v1/mail", { target: "dispatcher", intent: "inform", body: "objection: …" }, "tok-arch");
  expect(r.status).toBe(200);
  expect(hires).toBe(0);
  const [woken] = await jobsFor(h.db);
  const [dispatcher] = await h.db.select({ id: agent.id }).from(agent).where(eq(agent.role, "dispatcher"));
  expect(woken?.agent_id).toBe(dispatcher?.id);
});

test("a standing agent's mail is filed under the recipient's group, not nowhere", async () => {
  const h = await harness();
  h.ctx.knownRoles = () => ["pm", "dispatcher", "architect"];
  await h.f.agent.create({ project_id: 1, grp_id: 1, role: "dispatcher", token: "tok-disp" });
  await h.f.agent.create({ project_id: 1, role: "architect", token: "tok-arch" });

  await h.post(
    "/orch/v1/mail",
    { target: "dispatcher", intent: "inform", body: "反对：locale 推断与验收冲突" },
    "tok-arch",
  );

  // Stamped with the sender's group, this lands as NULL and vanishes from the
  // group's timeline — which is how a real objection went unseen while the card
  // it argued with said `Objection: none`.
  const [e] = await h.db
    .select({ grp_id: event.grp_id, body: event.body })
    .from(event)
    .where(and(eq(event.author, "architect"), eq(event.kind, "say")));
  expect(e?.grp_id).toBe(1);
});

test("an empty mail body is refused instead of waking someone with nothing to read", async () => {
  const h = await harness();
  h.ctx.knownRoles = () => ["architect"];
  await h.f.agent.create({ project_id: 1, grp_id: 1, token: "tok-e" });
  // What a real run produced: the Dispatcher invented `--wait`, the parser took
  // it as a flag, and the mail went out with no message at all.
  const r = await h.post("/orch/v1/mail", { target: "architect", intent: "ask", body: "" }, "tok-e");
  expect(r.status).toBe(422);
  const said = await r.text();
  expect(said).toContain("empty body");
  expect(said).toContain("--wait");
  expect(await jobsFor(h.db)).toHaveLength(0);
});

test("the boss can hand a question to the Architect instead of answering it", async () => {
  const h = await harness();
  h.ctx.knownRoles = () => ["pm", "architect", "cos"];
  await h.f.agent.create({ project_id: 1, role: "architect", token: "tok-arch" });
  const id = await h.ask("用哪个校验库？");
  const r = await h.post(`/api/v1/escalations/${id}/delegate`, { to: "architect" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ message: "architect" });
  // The Architect is actually woken, not just recorded as the new owner.
  const [woken] = await h.db
    .select({ agent_id: job.agent_id, payload_json: job.payload_json })
    .from(job)
    .where(eq(job.kind, "agent_turn"))
    .orderBy(desc(job.id));
  expect(AgentTurnPayloadSchema.parse(woken?.payload_json).escalation).toBe(id);
});

test("delegating to the boss is refused — that is where it already is", async () => {
  const h = await harness();
  const id = await h.ask("x");
  const r = await h.post(`/api/v1/escalations/${id}/delegate`, { to: "boss" });
  expect(r.status).toBe(400);
});

test("a stopped group's question goes straight to the boss", async () => {
  // Every level below the boss answers by taking a turn, and a turn on a paused
  // group is never dispatched. A blocker filed by sendBack sat at chain_state='pm'
  // for two hours — on a group sendBack had itself just paused — and the boss's
  // only symptom was a group that had stopped for no stated reason.
  const h = await harness();
  await h.db.update(grp).set({ status: "PAUSED" }).where(eq(grp.id, 1));
  const id = (
    await h.f.escalation.create({
      grp_id: 1,
      severity: "blocker",
      question: "S1 failed the gate 3 times",
      created_at: Date.now(),
    })
  ).id;
  expect(await route(h.deps, id)).toBe("boss");
  expect(await stateOf(h.db, id)).toBe("boss");
});

test("an advisory on a stopped group waits for the group, it does not ring the boss", async () => {
  // The other half of the rule above, and the reason it is written as a rule.
  // Lifting every escalation off a stopped group put five sandbox refusals — JSON
  // blobs about a tool call — on the boss's phone as "things need you", and buried
  // the one blocker that did. An advisory is "answer it if you can", so it stays in
  // the chain and is read when the group runs again.
  const h = await harness();
  await h.db.update(grp).set({ status: "PAUSED" }).where(eq(grp.id, 1));
  const id = await h.ask("the sandbox refused `curl`", "advisory");
  expect(await route(h.deps, id)).toBe("pm");
  expect(h.notified).toEqual([]);
});

test("an agent cannot answer as the boss by saying it is the boss", async () => {
  // `by` arrives in the request body. Reserved topics — spend, a merge to main, a
  // credential — are refused for every level except the boss, so a level that can
  // name itself boss has the whole reservation as a bypass.
  const h = await harness();
  const id = await h.ask("should we pay for more quota?");
  const impersonated = await answer(h.deps, { escId: id, by: "boss", answer: "yes", actorGrpId: 1 });
  expect(impersonated.ok).toBe(false);
  if (!impersonated.ok) expect(impersonated.error).toContain("through the panel");
  // The panel itself has no acting group, and is still allowed.
  expect((await answer(h.deps, { escId: id, by: "boss", answer: "yes" })).ok).toBe(true);
});

test("routing an answered question again leaves it answered", async () => {
  // `route` is called from `abstain` and from the scheduler, and an answer can land
  // between the two. Without the terminal check the level falls off the end of the
  // chain and restarts at the PM, so a resolved question re-enters the queue and the
  // group is asked something it has already been told.
  const h = await harness();
  const id = await h.ask("q");
  expect((await answer(h.deps, { escId: id, by: "pm", answer: "done" })).ok).toBe(true);
  expect(await route(h.deps, id)).toBe("closed");
  expect(await stateOf(h.db, id)).toBe("answered");
  expect(h.notified).toEqual([]);
});

test("a retired PM is not a responder, so the question moves on instead of stalling", async () => {
  // A turn enqueued for a retired agent is never taken, and the question sits at
  // chain_state='pm' with nothing running — the stall the chain exists to prevent,
  // wearing the shape of a level that was answered.
  const h = await harness();
  await h.db.update(agent).set({ state: "retired" }).where(eq(agent.role, "pm"));
  const id = await h.ask("who owns this file?");
  expect(await route(h.deps, id)).toBe("boss");
});

test("an answer that arrives before the question has finished filing still reaches the asker", async () => {
  // The waiter used to be registered after `route()`, and `route()` can hand a
  // question to a stand-in that answers inside the same tick. The answer then
  // found nothing to resolve, `w?.(…)` dropped it, and the agent that asked
  // waited for the rest of its life on a question already answered.
  //
  // Answering off the bus frame is the deterministic form of that race: the
  // frame is emitted while the request is still filing, so under the old order
  // this answer always lost.
  const h = await harness();
  const off = h.ctx.bus.subscribe((frame) => {
    if (frame.type !== "event" || frame.kind !== "escalation") return;
    off();
    void h.post("/api/v1/escalations/1/answer", { answer: "middleware" });
  });

  const asked = await h.post("/orch/v1/ask-boss", { question: "middleware or handler?", kind: "design" }, "tok-eng");
  expect(await asked.json()).toEqual({ message: "middleware" });
}, 3_000);
