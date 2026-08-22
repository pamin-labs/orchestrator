import { describe, expect, test } from "bun:test";
import { and, asc, desc, eq } from "drizzle-orm";
import type { DB } from "../../src/platform/persistence/database.ts";
import { abstain, answer, entryPoint, isReserved, revoke, route, triage, TRIAGE } from "../../src/mech/flow/chain.ts";
import { RESERVED_TOPICS } from "../../src/contracts/states.ts";
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

async function harness(opts: { withArchitect?: boolean; withCos?: boolean; withPm?: boolean } = {}) {
  const notified: number[] = [];
  const ctx = await testContext({
    sandbox: fakeSandbox(),
    notifyBoss: (id) => void notified.push(id),
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
  const ask = async (question: string, severity = "advisory") =>
    (await f.escalation.create({ grp_id: 1, agent_id: 1, severity, question, created_at: Date.now() })).id;

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

describe("reserved topics skip the whole chain and go straight to the boss", () => {
  test.each([
    "should we pay for the higher API tier?",
    "can I merge this into main?",
    "what is the value of the API_KEY?",
    "should we deploy to production now?",
    "the boss wanted rate limiting — should we drop the audit log instead?",
    "这个要花钱吗？",
    "要不要改需求范围？",
  ])("%s", (q) => {
    expect(isReserved(q)).toBe(true);
    expect(entryPoint(q)).toBe("boss");
  });

  test("a question about implementation is not reserved", () => {
    expect(isReserved("which validation library should we use?")).toBe(false);
  });
});

/**
 * The asker naming the topic, which is the exact form of the question the
 * patterns can only guess at.
 *
 * An agent writes in `output.language` and the gate does not get to know which,
 * so `RESERVED` is ten rows of keyword and admits it — sixteen of eighteen
 * probes leaked before the other eight rows existed. A word is not a guess.
 */
describe("a declared topic decides the entry point, and only upward", () => {
  test("a topic sends an otherwise ordinary question to the boss", () => {
    const ordinary = "which validation library should we use?";
    expect(isReserved(ordinary)).toBe(false);
    expect(entryPoint(ordinary)).toBe("pm");
    for (const topic of RESERVED_TOPICS) expect(entryPoint(ordinary, topic)).toBe("boss");
  });

  /**
   * The half that matters. The PM is a model, and a gate a model can talk its
   * way out of is not one — so there is no value that routes *away* from the
   * boss. Saying nothing is the only other option, and the patterns still fire.
   */
  test("saying nothing does not lower a question the patterns catch", () => {
    const money = "should we pay for the higher API tier?";
    expect(entryPoint(money)).toBe("boss");
    expect(entryPoint(money, undefined)).toBe("boss");
  });

  test("the vocabulary is the five topics the patterns encode", () => {
    expect([...RESERVED_TOPICS]).toEqual(["budget", "merge", "credential", "deploy", "scope"]);
  });
});

/**
 * The panel speaks ten languages and an agent writes its question in
 * `output.language`, so the gate has to read all ten. Against the version that
 * covered English and Simplified Chinese, sixteen of the eighteen budget/merge
 * probes here leaked — English "increase the budget" among them, since the
 * pattern spelled it `budget increase`.
 */
/**
 * One question per topic per language, and the same five topics in the same
 * order everywhere, so a language added without a pattern shows up as a column
 * of failures rather than as a question the boss is never asked.
 */
describe.each([
  [
    "en",
    "should we increase the budget for this?",
    "can I merge this into main?",
    "what is the value of the API_KEY?",
    "should we deploy to production now?",
    "should we drop the audit log instead?",
    "which validation library should we use?",
  ],
  [
    "zh",
    "这个要不要加预算？",
    "能不能把这个合并到 main？",
    "密钥放在哪里？",
    "现在要上线吗？",
    "要不要改需求范围？",
    "这个函数应该放在哪个模块？",
  ],
  [
    "zh-Hant",
    "這個要不要加預算？",
    "能不能把這個合併到 main？",
    "金鑰放在哪裡？",
    "現在要上線嗎？",
    "要不要改需求範圍？",
    "這個函式應該放在哪個模組？",
  ],
  [
    "ja",
    "この件、予算を増やしますか？",
    "これを main にマージしてもいいですか？",
    "APIキーの値は何ですか？",
    "今すぐ本番にデプロイしますか？",
    "要件の範囲を変更しますか？",
    "このZodスキーマはどのモジュールに置くべきですか？",
  ],
  [
    "ko",
    "이 건 예산을 늘릴까요?",
    "이걸 main 에 머지해도 될까요?",
    "API 키 값이 뭔가요?",
    "지금 프로덕션에 배포할까요?",
    "요구 사항 범위를 변경할까요?",
    "이 함수는 어느 모듈에 두는 게 좋을까요?",
  ],
  [
    "es",
    "¿aumentamos el presupuesto para esto?",
    "¿puedo fusionar esto en main?",
    "¿cuál es el valor de la clave de API?",
    "¿desplegamos a producción ahora?",
    "¿cambiamos el alcance del requisito?",
    "¿qué biblioteca de validación deberíamos usar?",
  ],
  [
    "fr",
    "faut-il augmenter le budget pour cela ?",
    "puis-je fusionner ceci dans main ?",
    "quelle est la valeur de la clé API ?",
    "on déploie en production maintenant ?",
    "doit-on changer le périmètre des exigences ?",
    "quelle bibliothèque de validation devrions-nous utiliser ?",
  ],
  [
    "de",
    "sollen wir dafür das Budget erhöhen?",
    "kann ich das nach main mergen?",
    "wie lautet der Wert des API-Schlüssels?",
    "sollen wir jetzt in die Produktion ausliefern?",
    "sollen wir den Umfang der Anforderung ändern?",
    "welche Validierungsbibliothek sollen wir verwenden?",
  ],
  [
    "pt",
    "devemos aumentar o orçamento para isto?",
    "posso mesclar isto para main?",
    "qual é o valor da chave de API?",
    "vamos publicar em produção agora?",
    "mudamos o escopo do requisito?",
    "qual biblioteca de validação devemos usar?",
  ],
  [
    "ru",
    "нужно ли увеличить бюджет на это?",
    "можно влить это в main?",
    "какое значение у API-ключа?",
    "выкатываем в прод сейчас?",
    "меняем объём требований?",
    "какую библиотеку валидации использовать?",
  ],
])("%s", (_locale, money, merge, credentials, production, requirement, ordinary) => {
  test.each([
    ["money", money],
    ["merge to main", merge],
    ["credentials", credentials],
    ["production", production],
    ["requirement", requirement],
  ])("%s goes to the boss", (_topic, question) => {
    expect(isReserved(question)).toBe(true);
    expect(entryPoint(question)).toBe("boss");
  });

  // Over-triggering is the deliberate bias, but a gate that reserves every
  // question reserves none: the boss stops reading it and the next real one is
  // lost in the noise. One ordinary question per language holds the other edge.
  test("an ordinary technical question is not reserved", () => {
    expect(isReserved(ordinary)).toBe(false);
  });
});

/**
 * The trap each of these was written against, kept because the pattern that
 * fails them still matches every question in the table above.
 */
describe("patterns that read one language must not fire on another", () => {
  test.each([
    // A bare `\babo` for German Abo is every English "about" and "abort".
    "should we abort the run and ask about the retry policy?",
    // A bare `pag` for Spanish/Portuguese pagar is inside "propagate".
    "should we propagate the error to the caller?",
    // A bare `production` for French is every English sentence about prod data.
    "is the production schema versioned in the repo?",
  ])("%s", (question) => {
    expect(isReserved(question)).toBe(false);
  });

  // `ключ` without its lookbehind is inside включить, "to enable" — the most
  // ordinary verb in the language.
  test("включить is not a question about a key", () => {
    expect(isReserved("нужно ли включить строгий режим в tsconfig?")).toBe(false);
  });

  // A bare `прод` is продукт and продолжать.
  test("продолжаем is not a question about production", () => {
    expect(isReserved("продолжаем рефакторинг парсера?")).toBe(false);
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

test("no stand-in may answer a reserved question, precedent or not", async () => {
  const h = await harness({ withCos: true });
  const id = await h.ask("should we pay for more quota?");
  await h.db.update(escalation).set({ chain_state: "cos" }).where(eq(escalation.id, id));
  const precedent = await h.f.note.create({ grp_id: 1, kind: "decision", body: "以前批过一次" });
  const r = await answer(h.deps, { escId: id, by: "cos", answer: "yes, we did before", refNoteId: precedent.id });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("reserved for the boss");
  // The boss still can.
  expect((await answer(h.deps, { escId: id, by: "boss", answer: "no" })).ok).toBe(true);
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

  const asked = await h.post("/orch/v1/ask-boss", { question: "middleware or handler?" }, "tok-eng");
  expect(await asked.json()).toEqual({ message: "middleware" });
}, 3_000);
