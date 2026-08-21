import { and, eq, isNull, ne } from "drizzle-orm";
import type { Locale } from "../../contracts/config.ts";
import { answered, roleFor, type Ctx } from "../../mech/ctx.ts";
import { addNote } from "../util/rows.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { agent as agentTable, escalation, grp, note as noteTable } from "../../platform/persistence/schema.ts";
import { rollbackTo } from "../git/gitops.ts";
import { sandboxGit } from "../git/checkout.ts";
import { WORK } from "../sandbox/sandbox.ts";
import { dropGroup } from "./start.ts";
import { release } from "./intercept.ts";
import {
  ESCALATION_OPEN_STATES,
  isDispatchableGrpState,
  isTerminalEscalationState,
  type EscalationOpenState,
  type EscalationState,
} from "../../contracts/states.ts";

/**
 * The answer chain: PM -> Architect -> CoS -> the boss.
 *
 * The point is not to keep questions away from the boss; it is to keep the
 * *answerable* ones away. Each level may answer or abstain, and abstaining is the
 * expected move when a level is unsure — guessing on the boss's behalf is worse
 * than waiting, because a wrong answer becomes a premise the whole group reasons
 * from.
 */

export const CHAIN = ESCALATION_OPEN_STATES;

/**
 * Topics that never route through the chain, however clear the precedent.
 *
 * ponytail: keyword matching, so it over-triggers rather than under-triggers.
 * A question wrongly sent to the boss costs one interruption; one wrongly
 * answered by an agent can cost money or a merge.
 */
/**
 * Keyed by locale, and typed `Record<Locale, ...>` so an eleventh language is
 * caught by the compiler rather than by a boss who was never asked. Five topics,
 * in the same order on every row: money, merging to `main`, credentials, going
 * to production, changing the requirement.
 */
/**
 * This gate was written when the panel spoke two languages. It speaks ten now
 * and an agent writes its question in `output.language`, so the other eight
 * walked straight through it — and so did two topics in the two it knew.
 * Two probes per language, "raise the budget?" and "merge into main?": sixteen
 * of eighteen leaked, English `budget increase` (never the word order anyone
 * uses) and Chinese (no word for merge at all) among them.
 */
/**
 * No `\b` on the CJK rows — word boundaries are defined on ASCII word
 * characters, so `\b予算\b` never matches inside a Japanese sentence; the same
 * trap `FILLER` in `mech/util/validate.ts` documents. Nor on Cyrillic, which
 * inflects on top of it, so those are stems: `трат` covers трата/потратить/затраты.
 */
/**
 * Nothing looks a row up. `PATTERNS` flattens all ten and every question is
 * tested against all of them, because an agent writes in whatever
 * `output.language` says and the gate does not get to know which. The keys buy
 * one thing and it is worth the shape: `Record<Locale, …>` makes an eleventh
 * language a compile error.
 */
const RESERVED: Record<Locale, readonly RegExp[]> = {
  // `subscri` sat inside the `\b(…)\b` group, so it could never match: every real
  // word continues past it into another word character and the closing `\b` fails.
  // Dead since it was written, for the one topic with a recurring bill attached.
  en: [
    /\b(spend|pay(ment|ing|s)?|purchase|buy|subscri\w*|billing|invoice|budget)\b/i,
    /\b(merge|merging)\b.*\b(main|master)\b/i,
    /\b(secret|credential|api[_ -]?key|token|password|\.env)\b/i,
    /\b(deploy|publish|release)\b.*\b(prod|production|live)\b/i,
    /\b(scope|out of scope|drop the|add a feature|instead of what)\b/i,
  ],
  zh: [/(花钱|付费|采购|订阅|预算|合并|密钥|凭据|上线|发布到生产|需求范围|范围变更)/],
  // Its own row rather than characters bolted onto `zh`'s: 金鑰 is not 密钥 and
  // 憑證 is not 凭据 — Traditional Chinese differs from Simplified by vocabulary
  // here, not only by glyph, the same reason `zh-Hant.po` is generated through a
  // phrase dictionary and not a character table.
  "zh-Hant": [/(花錢|付費|採購|訂閱|預算|合併|金鑰|憑證|上線|發布到生產|需求範圍|範圍變更)/],
  // 予算 is not 预算 and 範囲 is not 范围: sharing the Han script is not sharing
  // the characters. Kana as well as kanji where the kana spelling is ordinary.
  ja: [
    /(支払|しはら|課金|購入|サブスク|有料|予算|マージ|取り込|秘密鍵|パスワード|認証情報|クレデンシャル|api\s*キー|本番|ほんばん|デプロイ|リリース|スコープ|要件|範囲)/i,
  ],
  ko: [
    /(결제|지불|구매|구독|유료|예산|머지|병합|비밀번호|비밀\s*키|자격\s*증명|인증\s*정보|api\s*키|배포|프로덕션|운영\s*환경|스코프|요구\s*사항|범위)/i,
  ],
  // `\bpag[ao]` anchored at the front, or it fires on English "propagate".
  es: [
    /(\bpag[ao]|compra|suscri|factura|presupuesto|fusion|clave|contraseña|credencial|producci|despleg|desplieg|alcance|requisito)/i,
  ],
  // `en production`, not bare `production`: the French preposition keeps this off
  // every English sentence about a production database, which `en` pairs with a verb.
  fr: [
    /(payer|paiement|payant|achat|acheter|abonnement|facture|budget|fusionner|clé|mot de passe|identifiants|déploi|en production|périmètre|exigence)/i,
  ],
  // `\babos?\b`, because a bare `\babo` is every English "about" and "abort".
  de: [
    /(bezahl|zahlung|kauf|\babos?\b|rechnung|budget|mergen|zusammenführ|schlüssel|passwort|zugangsdaten|geheimnis|produktion|produktiv|ausliefer|veröffentlich|umfang|anforderung)/i,
  ],
  pt: [
    /(\bpaga|compra|assinatura|fatura|orçamento|mesclar|fundir|chave|senha|credenci|segredo|produç|implantar|publicar|escopo|âmbito|requisito)/i,
  ],
  // `ключ` needs the lookbehind: without it every включить — "shall we enable" —
  // is a question about a key. `в прод`/`на прод` for the same reason, since a
  // bare `прод` is продукт and продолжать.
  ru: [
    /(оплат|плати|платеж|платёж|трат|купить|покуп|подписк|бюджет|мерж|влить|слить|(?<![а-яё])ключ|пароль|секрет|уч[её]тные|токен|в прод|на прод|продакш|деплой|выкат|релиз|требован|скоуп|рамк)/i,
  ],
};

const PATTERNS = Object.values(RESERVED).flat();

export function isReserved(question: string): boolean {
  return PATTERNS.some((re) => re.test(question));
}

/** Where a new question should start. */
export function entryPoint(question: string): (typeof CHAIN)[number] {
  return isReserved(question) ? "boss" : "pm";
}

export interface ChainDeps {
  /** Wired by api.ts: records a boss fact and checks whether it is the third of its kind. */
  bossFact?: (grpId: number | null, body: string) => Promise<void>;
  ctx: Ctx;
  /** Tell the boss. Wired to the notifier by the server. */
  notifyBoss?: (escId: number, question: string, severity: string) => void;
}

interface EscRow {
  id: number;
  grp_id: number | null;
  agent_id: number | null;
  severity: string;
  question: string;
  chain_state: EscalationState;
}

async function load(db: DB, id: number): Promise<EscRow | null> {
  const [row] = await db
    .select({
      id: escalation.id,
      grp_id: escalation.grp_id,
      agent_id: escalation.agent_id,
      severity: escalation.severity,
      question: escalation.question,
      chain_state: escalation.chain_state,
    })
    .from(escalation)
    .where(eq(escalation.id, id));
  return row ?? null;
}

/**
 * Route a question to whoever should look at it next.
 *
 * A level that has no agent in this group is skipped rather than waited on: an
 * absent Architect must not turn into a stalled question.
 */
export async function route(deps: ChainDeps, escId: number): Promise<string> {
  const { ctx } = deps;
  const esc = await load(ctx.db, escId);
  if (!esc || isTerminalEscalationState(esc.chain_state)) return "closed";

  // A stopped group can answer nothing: every level below the boss replies by
  // taking a turn, and a turn on a paused, parked or draft group is never
  // dispatched. The question then sits at chain_state='pm' forever while the only
  // visible symptom is a group that stopped — which is exactly what a blocker is
  // supposed to prevent.
  //
  // Blockers only. An advisory is "answer it if you can" — the sandbox refusing a
  // command an agent tried is the common one, and it is a JSON blob about a tool
  // call, not a decision. Lifting those to the boss put five of them on the phone
  // as "things need you" and buried the one blocker that did.
  const status = esc.grp_id
    ? (await ctx.db.select({ status: grp.status }).from(grp).where(eq(grp.id, esc.grp_id)))[0]?.status
    : null;
  let level: EscalationOpenState =
    esc.severity === "blocker" && status && !isDispatchableGrpState(status) ? "boss" : esc.chain_state;
  for (;;) {
    if (level === "boss") {
      await ctx.db.update(escalation).set({ chain_state: "boss" }).where(eq(escalation.id, escId));
      deps.notifyBoss?.(escId, esc.question, esc.severity);
      await ctx.bus.emit({
        grpId: esc.grp_id,
        author: "orchestrator",
        kind: "escalation",
        intent: "ask",
        severity: esc.severity,
        body: `for you: ${esc.question}`,
        meta: { escalation_id: escId, chain_state: "boss" },
      });
      return "boss";
    }

    const agent = await findResponder(ctx, esc.grp_id, level);
    if (agent) {
      await ctx.db.update(escalation).set({ chain_state: level }).where(eq(escalation.id, escId));
      await ctx.sched.enqueue("agent_turn", {
        grp_id: esc.grp_id,
        agent_id: agent,
        payload: { escalation: escId, role: level },
        priority: esc.severity === "blocker" ? 8 : 2,
      });
      await ctx.sched.tick();
      return level;
    }
    level = CHAIN[CHAIN.indexOf(level) + 1]!;
  }
}

/** A responder for this level: in-group for PM, standing for the rest. */
async function groupResponder(db: DB, grpId: number | null): Promise<number | null> {
  const [row] = await db
    .select({ id: agentTable.id })
    .from(agentTable)
    .where(
      and(
        // `grp_id IS ?`, not `= ?`: called with a null `grpId` this has to find
        // the standing PM, whose `grp_id` is NULL. `eq()` would find nobody and
        // the question would skip a level it should have been routed to.
        grpId === null ? isNull(agentTable.grp_id) : eq(agentTable.grp_id, grpId),
        eq(agentTable.role, "pm"),
        ne(agentTable.state, "retired"),
      ),
    );
  return row?.id ?? null;
}

async function standingResponder(db: DB, role: string): Promise<number | null> {
  const [row] = await db
    .select({ id: agentTable.id })
    .from(agentTable)
    .where(and(isNull(agentTable.grp_id), eq(agentTable.role, role), ne(agentTable.state, "retired")));
  return row?.id ?? null;
}

async function findResponder(ctx: Ctx, grpId: number | null, role: string): Promise<number | null> {
  if (role === roleFor(ctx, "lead_group")) return groupResponder(ctx.db, grpId);
  const assigned = await standingResponder(ctx.db, role);
  if (assigned) return assigned;
  // A configured-but-not-yet-hired standing role is a level that exists; skipping
  // it would send the question to the boss for no reason.
  if (!(ctx.knownRoles?.() ?? []).includes(role)) return null;
  return (await ctx.hire?.(null, role)) ?? null;
}

export interface AnswerInput {
  escId: number;
  by: EscalationOpenState;
  answer: string;
  /** Present for an authenticated agent; omitted for the boss's panel. */
  actorGrpId?: number | null;
  /** A note id the answer rests on. Required for the CoS. */
  refNoteId?: number;
}

function responderError(esc: EscRow, by: EscalationOpenState, actorGrpId?: number | null): string | null {
  if (actorGrpId !== undefined) {
    if (by === "boss") return "the boss answers through the panel";
    if (by === "pm" ? actorGrpId !== esc.grp_id : actorGrpId !== null) return "not your question";
  }
  return by !== "boss" && esc.chain_state !== by ? `this question is waiting on ${esc.chain_state}, not ${by}` : null;
}

async function citationError(db: DB, input: AnswerInput): Promise<string | null> {
  if (input.by !== "cos") return null;
  if (!input.refNoteId) return "a stand-in answer must cite the decision it rests on (--ref <note_id>)";
  const [note] = await db.select({ kind: noteTable.kind }).from(noteTable).where(eq(noteTable.id, input.refNoteId));
  if (!note) return `no note ${input.refNoteId}`;
  if (note.kind === "decision" || note.kind === "fact") return null;
  return `note ${input.refNoteId} is a ${note.kind}, not a decision`;
}

async function answerError(db: DB, esc: EscRow, input: AnswerInput): Promise<string | null> {
  if (esc.chain_state === "answered") return "already answered";
  const responder = responderError(esc, input.by, input.actorGrpId);
  if (responder) return responder;
  const citation = await citationError(db, input);
  if (citation) return citation;
  return input.by !== "boss" && isReserved(esc.question)
    ? "this one is reserved for the boss whatever the precedent"
    : null;
}

/** A level answers. Resolves whoever is blocked on `orch ask-boss`. */
export async function answer(
  deps: ChainDeps,
  input: AnswerInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ctx } = deps;
  const esc = await load(ctx.db, input.escId);
  if (!esc) return { ok: false, error: `no escalation ${input.escId}` };
  const refused = await answerError(ctx.db, esc, input);
  if (refused) return { ok: false, error: refused };

  await ctx.db
    .update(escalation)
    .set({
      answer: input.answer,
      answered_by: input.by,
      ref_note_id: input.refNoteId ?? null,
      chain_state: "answered",
      answered_at: Date.now(),
    })
    .where(eq(escalation.id, input.escId));
  await ctx.bus.emit({
    grpId: esc.grp_id,
    author: input.by,
    kind: "say",
    intent: "inform",
    body: input.answer,
    meta: { in_reply_to_escalation: input.escId, answered_by: input.by, ref: input.refNoteId ?? null },
  });
  if (esc.severity === "blocker" && esc.grp_id) {
    await release(ctx, esc.grp_id);
  }

  answered(ctx, input.escId, input.answer);
  await ctx.sched.tick();
  return { ok: true };
}

/** A level declines. Not a failure — it is what keeps a guess from becoming a premise. */
export async function abstain(
  deps: ChainDeps,
  escId: number,
  by: EscalationOpenState,
  why: string,
  actorGrpId?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ctx } = deps;
  const esc = await load(ctx.db, escId);
  if (!esc) return { ok: false, error: `no escalation ${escId}` };
  const refused = responderError(esc, by, actorGrpId);
  if (refused) return { ok: false, error: refused };
  const next = CHAIN[CHAIN.indexOf(by) + 1] ?? "boss";
  await ctx.db.update(escalation).set({ chain_state: next }).where(eq(escalation.id, escId));
  await ctx.bus.emit({
    grpId: esc.grp_id,
    author: by,
    kind: "escalation",
    intent: "ask",
    severity: esc.severity,
    body: `${by} passed this up: ${why || "no reason given"}`,
    meta: { escalation_id: escId, next },
  });
  await route(deps, escId);
  return { ok: true };
}

/**
 * Undo a stand-in's answer and take over.
 *
 * Without this, delegated answers are an irreversible bet and the boss would
 * rightly never enable them. Rolling the worktree back to the checkpoint recorded
 * when the question was asked is what makes the bet reversible.
 */
export async function revoke(deps: ChainDeps, escId: number): Promise<{ rolledBackTo?: string; answeredBy?: string }> {
  const { ctx } = deps;
  const [esc] = await ctx.db
    .select({
      grp_id: escalation.grp_id,
      answered_by: escalation.answered_by,
      checkpoint_sha: escalation.checkpoint_sha,
    })
    .from(escalation)
    .where(eq(escalation.id, escId));
  if (!esc) return {};

  await ctx.db.update(escalation).set({ chain_state: "boss", answer: null }).where(eq(escalation.id, escId));
  if (esc.grp_id) await ctx.sched.cancelPending(esc.grp_id, "answer revoked");

  let rolledBackTo: string | undefined;
  // The group's own checkout. Gated on `grp.worktree` before — a column nothing
  // writes — so revoking an answer never actually revoked the work done on it.
  if (esc.checkpoint_sha && esc.grp_id) {
    const back = await rollbackTo(sandboxGit(ctx, { grp: esc.grp_id }), WORK, esc.checkpoint_sha);
    if (back.ok) rolledBackTo = esc.checkpoint_sha;
    else {
      await ctx.bus.emit({
        grpId: esc.grp_id,
        author: "orchestrator",
        kind: "escalation",
        intent: "inform",
        severity: "advisory",
        body: `answer revoked, but the rollback to ${esc.checkpoint_sha.slice(0, 8)} failed: ${back.error}`,
      });
    }
  }
  await ctx.bus.emit({
    grpId: esc.grp_id,
    author: "boss",
    kind: "state_change",
    body:
      `revoked ${esc.answered_by ?? "the"} answer` +
      (rolledBackTo ? ` and rolled back to ${rolledBackTo.slice(0, 8)}` : ""),
    meta: { escalation_id: escId, ...(rolledBackTo ? { rolledBackTo } : {}) },
  });
  return {
    ...(rolledBackTo ? { rolledBackTo } : {}),
    ...(esc.answered_by ? { answeredBy: esc.answered_by } : {}),
  };
}

/**
 * A value, like `CHAIN` above, so the two doors can spell it from here.
 *
 * It was a bare union type, so neither route that takes it could reach it: the
 * boss's `/api/v1/say` restated the three words as an array literal plus an
 * unchecked `as Triage`, and `/orch/v1/triage` restated them again as a `z.enum`.
 * A fourth verb added here would have compiled everywhere and been refused by
 * one of the two doors at runtime.
 */
export const TRIAGE = ["patch", "respec", "reject"] as const;
export type Triage = (typeof TRIAGE)[number];

/**
 * What the boss's complaint means for the work.
 *
 * `respec` has to exist. Without it every complaint is heard as "change this
 * line", and a wrong decomposition can never be corrected — the group keeps
 * polishing something the boss did not ask for.
 */
/**
 * Send the requirement back to planning, and say what to plan.
 *
 * PLANNING, not DRAFT: DRAFT blocks dispatch, so setting it here deadlocked the
 * turn enqueued on the next line — the group sat waiting on a boss being shown
 * the very card that had just been thrown out. Both callers do the same two
 * things, which is why they are one.
 */
async function replan(ctx: Ctx, grpId: number, skills: string[], brief: Record<string, unknown>): Promise<void> {
  await ctx.db.update(grp).set({ status: "PLANNING" }).where(eq(grp.id, grpId));
  await ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    payload: { role: roleFor(ctx, "plan_requirement"), skills, ...brief },
  });
}

export async function triage(
  deps: ChainDeps,
  grpId: number,
  as: Triage,
  note: string,
  skills: string[] = [],
): Promise<void> {
  const { ctx } = deps;
  // Through bossFact: a patch is the boss complaining, and the third identical
  // complaint is supposed to become a project rule rather than a third isolated fact.
  //
  // `??` on a void call always took the fallback: bossFact returned undefined
  // whether or not it ran, so every sentence the boss said was written twice.
  // Awaited for the same reason it is not `??` — the note has to be written
  // before the event below says it was.
  const body = `boss (${as}): ${note}`;
  if (deps.bossFact) await deps.bossFact(grpId, body);
  else {
    await addNote(ctx.db, { grpId, kind: "fact", lang: ctx.config.language, body });
  }
  await ctx.bus.emit({
    grpId,
    author: roleFor(ctx, "triage_boss_feedback"),
    kind: "state_change",
    intent: "decision",
    body: `triaged as ${as}: ${note}`,
    meta: { triage: as },
  });

  if (as === "reject") {
    // Actually dissolve it. Cancelling the queue left the group ACTIVE, so it went
    // on holding its paths against every other group — a requirement nobody wanted
    // could block one they did, indefinitely. The retro turn that used to be
    // enqueued here could never run either: no status a dropped group has is
    // dispatchable, so it sat pending forever.
    await dropGroup(ctx, grpId, note);
  } else if (as === "respec") {
    await replan(ctx, grpId, skills, { respec: note, rotate: true });
  } else {
    // A patch normally goes to the PM, who owns the work in flight. But while the
    // card is waiting for approval there is no work in flight and no PM — the
    // Dispatcher owns the card, and the card is the thing that has to change.
    // Sending it to a PM meant the addition was never read and the boss approved a
    // card that did not contain what they had just asked for.
    const draft =
      (await ctx.db.select({ status: grp.status }).from(grp).where(eq(grp.id, grpId)))[0]?.status === "DRAFT";
    if (draft) {
      await replan(ctx, grpId, skills, {
        rejection:
          `The boss added a requirement while the card was waiting for approval: ${note}\n\n` +
          `Rewrite the card so it covers this, then file it again with \`orch draft\`.`,
      });
    } else {
      await ctx.sched.enqueue("agent_turn", {
        grp_id: grpId,
        payload: { role: roleFor(ctx, "lead_group"), rejection: `The boss wants a correction: ${note}`, skills },
      });
    }
  }
  await ctx.sched.tick();
}
