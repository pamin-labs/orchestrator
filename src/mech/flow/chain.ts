import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { roleFor, type Ctx } from "../../mech/ctx.ts";
import { addNote } from "../util/rows.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { orm } from "../../platform/persistence/orm.ts";
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
  type GrpState,
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
const RESERVED = [
  /\b(spend|pay|purchase|buy|subscri|billing|invoice|budget increase)\b/i,
  /\b(merge|merging)\b.*\b(main|master)\b/i,
  /\b(secret|credential|api[_ -]?key|token|password|\.env)\b/i,
  /\b(deploy|publish|release)\b.*\b(prod|production|live)\b/i,
  /\b(scope|out of scope|drop the|add a feature|instead of what)\b/i,
  /(花钱|付费|采购|订阅|预算|密钥|凭据|上线|发布到生产|需求范围|范围变更)/,
];

export function isReserved(question: string): boolean {
  return RESERVED.some((re) => re.test(question));
}

/** Where a new question should start. */
export function entryPoint(question: string): (typeof CHAIN)[number] {
  return isReserved(question) ? "boss" : "pm";
}

export interface ChainDeps {
  /** Wired by api.ts: records a boss fact and checks whether it is the third of its kind. */
  bossFact?: (grpId: number | null, body: string) => void;
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

/**
 * Raw, for its type rather than its SQL. `EscRow.chain_state` is `EscalationState`
 * and `escalation.chain_state` is declared `text()`, so reading it through the
 * schema yields `string` and every caller that narrows on the union stops
 * compiling. The generic is where that claim currently lives; giving the column a
 * `$type<EscalationState>()` in `schema.ts` would move it somewhere checked, and
 * that file belongs to another zone.
 */
function load(db: DB, id: number): EscRow | null {
  return (
    db
      .query<EscRow, [number]>(
        "SELECT id, grp_id, agent_id, severity, question, chain_state FROM escalation WHERE id = ?",
      )
      .get(id) ?? null
  );
}

/**
 * Route a question to whoever should look at it next.
 *
 * A level that has no agent in this group is skipped rather than waited on: an
 * absent Architect must not turn into a stalled question.
 */
export function route(deps: ChainDeps, escId: number): string {
  const { ctx } = deps;
  const esc = load(ctx.db, escId);
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
  // Raw for the same reason as `load`: `isDispatchableGrpState` takes a `GrpState`,
  // and the schema types this column `text()`.
  const status = esc.grp_id
    ? ctx.db.query<{ status: GrpState }, [number]>("SELECT status FROM grp WHERE id = ?").get(esc.grp_id)?.status
    : null;
  let level: EscalationOpenState =
    esc.severity === "blocker" && status && !isDispatchableGrpState(status) ? "boss" : esc.chain_state;
  for (;;) {
    if (level === "boss") {
      orm(ctx.db).update(escalation).set({ chain_state: "boss" }).where(eq(escalation.id, escId)).run();
      deps.notifyBoss?.(escId, esc.question, esc.severity);
      ctx.bus.emit({
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

    const agent = findResponder(ctx, esc.grp_id, level);
    if (agent) {
      orm(ctx.db).update(escalation).set({ chain_state: level }).where(eq(escalation.id, escId)).run();
      ctx.sched.enqueue("agent_turn", {
        grp_id: esc.grp_id,
        agent_id: agent,
        payload: { escalation: escId, role: level },
        priority: esc.severity === "blocker" ? 8 : 2,
      });
      ctx.sched.tick();
      return level;
    }
    level = CHAIN[CHAIN.indexOf(level) + 1]!;
  }
}

/** A responder for this level: in-group for PM, standing for the rest. */
function groupResponder(db: DB, grpId: number | null): number | null {
  return (
    orm(db)
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
      )
      .get()?.id ?? null
  );
}

function standingResponder(db: DB, role: string): number | null {
  return (
    orm(db)
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(and(isNull(agentTable.grp_id), eq(agentTable.role, role), ne(agentTable.state, "retired")))
      .get()?.id ?? null
  );
}

function findResponder(ctx: Ctx, grpId: number | null, role: string): number | null {
  if (role === roleFor(ctx, "lead_group")) return groupResponder(ctx.db, grpId);
  const assigned = standingResponder(ctx.db, role);
  if (assigned) return assigned;
  // A configured-but-not-yet-hired standing role is a level that exists; skipping
  // it would send the question to the boss for no reason.
  if (!(ctx.knownRoles?.() ?? []).includes(role)) return null;
  return ctx.hire?.(null, role) ?? null;
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

function citationError(db: DB, input: AnswerInput): string | null {
  if (input.by !== "cos") return null;
  if (!input.refNoteId) return "a stand-in answer must cite the decision it rests on (--ref <note_id>)";
  const note = orm(db)
    .select({ kind: noteTable.kind })
    .from(noteTable)
    .where(eq(noteTable.id, input.refNoteId))
    .get();
  if (!note) return `no note ${input.refNoteId}`;
  if (note.kind === "decision" || note.kind === "fact") return null;
  return `note ${input.refNoteId} is a ${note.kind}, not a decision`;
}

function answerError(db: DB, esc: EscRow, input: AnswerInput): string | null {
  if (esc.chain_state === "answered") return "already answered";
  const responder = responderError(esc, input.by, input.actorGrpId);
  if (responder) return responder;
  const citation = citationError(db, input);
  if (citation) return citation;
  return input.by !== "boss" && isReserved(esc.question)
    ? "this one is reserved for the boss whatever the precedent"
    : null;
}

/** A level answers. Resolves whoever is blocked on `orch ask-boss`. */
export function answer(deps: ChainDeps, input: AnswerInput): { ok: true } | { ok: false; error: string } {
  const { ctx } = deps;
  const esc = load(ctx.db, input.escId);
  if (!esc) return { ok: false, error: `no escalation ${input.escId}` };
  const refused = answerError(ctx.db, esc, input);
  if (refused) return { ok: false, error: refused };

  orm(ctx.db)
    .update(escalation)
    .set({
      answer: input.answer,
      answered_by: input.by,
      ref_note_id: input.refNoteId ?? null,
      chain_state: "answered",
      answered_at: sql`unixepoch() * 1000`,
    })
    .where(eq(escalation.id, input.escId))
    .run();
  ctx.bus.emit({
    grpId: esc.grp_id,
    author: input.by,
    kind: "say",
    intent: "inform",
    body: input.answer,
    meta: { in_reply_to_escalation: input.escId, answered_by: input.by, ref: input.refNoteId ?? null },
  });
  if (esc.severity === "blocker" && esc.grp_id) {
    release(ctx, esc.grp_id);
  }

  const w = ctx.waiters.get(`escalation:${input.escId}`);
  ctx.waiters.delete(`escalation:${input.escId}`);
  w?.(input.answer);
  ctx.sched.tick();
  return { ok: true };
}

/** A level declines. Not a failure — it is what keeps a guess from becoming a premise. */
export function abstain(
  deps: ChainDeps,
  escId: number,
  by: EscalationOpenState,
  why: string,
  actorGrpId?: number | null,
): { ok: true } | { ok: false; error: string } {
  const { ctx } = deps;
  const esc = load(ctx.db, escId);
  if (!esc) return { ok: false, error: `no escalation ${escId}` };
  const refused = responderError(esc, by, actorGrpId);
  if (refused) return { ok: false, error: refused };
  const next = CHAIN[CHAIN.indexOf(by) + 1] ?? "boss";
  orm(ctx.db).update(escalation).set({ chain_state: next }).where(eq(escalation.id, escId)).run();
  ctx.bus.emit({
    grpId: esc.grp_id,
    author: by,
    kind: "escalation",
    intent: "ask",
    severity: esc.severity,
    body: `${by} passed this up: ${why || "no reason given"}`,
    meta: { escalation_id: escId, next },
  });
  route(deps, escId);
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
  const esc = orm(ctx.db)
    .select({
      grp_id: escalation.grp_id,
      answered_by: escalation.answered_by,
      checkpoint_sha: escalation.checkpoint_sha,
    })
    .from(escalation)
    .where(eq(escalation.id, escId))
    .get();
  if (!esc) return {};

  orm(ctx.db)
    .update(escalation)
    .set({ chain_state: "boss", answer: null })
    .where(eq(escalation.id, escId))
    .run();
  if (esc.grp_id) ctx.sched.cancelPending(esc.grp_id, "answer revoked");

  let rolledBackTo: string | undefined;
  // The group's own checkout. Gated on `grp.worktree` before — a column nothing
  // writes — so revoking an answer never actually revoked the work done on it.
  if (esc.checkpoint_sha && esc.grp_id) {
    const back = await rollbackTo(sandboxGit(ctx, { grp: esc.grp_id }), WORK, esc.checkpoint_sha);
    if (back.ok) rolledBackTo = esc.checkpoint_sha;
    else {
      ctx.bus.emit({
        grpId: esc.grp_id,
        author: "orchestrator",
        kind: "escalation",
        intent: "inform",
        severity: "advisory",
        body: `answer revoked, but the rollback to ${esc.checkpoint_sha.slice(0, 8)} failed: ${back.error}`,
      });
    }
  }
  ctx.bus.emit({
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
export function triage(deps: ChainDeps, grpId: number, as: Triage, note: string, skills: string[] = []): void {
  const { ctx } = deps;
  // Through bossFact: a patch is the boss complaining, and the third identical
  // complaint is supposed to become a project rule rather than a third isolated fact.
  //
  // `??` on a void call always takes the fallback: bossFact returns undefined
  // whether or not it ran, so every sentence the boss said was written twice and
  // the requirement's 记录 tab showed each one doubled.
  const body = `boss (${as}): ${note}`;
  if (deps.bossFact) deps.bossFact(grpId, body);
  else {
    addNote(ctx.db, { grpId, kind: "fact", lang: ctx.config.language, body });
  }
  ctx.bus.emit({
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
    dropGroup(ctx, grpId, note);
  } else if (as === "respec") {
    // PLANNING, not DRAFT. DRAFT blocks dispatch, so setting it here deadlocked the
    // Dispatcher turn enqueued on the next line — the group sat waiting on a boss
    // who was being shown the very card that had just been thrown out.
    orm(ctx.db).update(grp).set({ status: "PLANNING" }).where(eq(grp.id, grpId)).run();
    ctx.sched.enqueue("agent_turn", {
      grp_id: grpId,
      payload: { role: roleFor(ctx, "plan_requirement"), respec: note, rotate: true, skills },
    });
  } else {
    // A patch normally goes to the PM, who owns the work in flight. But while the
    // card is waiting for approval there is no work in flight and no PM — the
    // Dispatcher owns the card, and the card is the thing that has to change.
    // Sending it to a PM meant the addition was never read and the boss approved a
    // card that did not contain what they had just asked for.
    const draft =
      orm(ctx.db).select({ status: grp.status }).from(grp).where(eq(grp.id, grpId)).get()?.status === "DRAFT";
    if (draft) {
      orm(ctx.db).update(grp).set({ status: "PLANNING" }).where(eq(grp.id, grpId)).run();
      ctx.sched.enqueue("agent_turn", {
        grp_id: grpId,
        payload: {
          role: roleFor(ctx, "plan_requirement"),
          rejection:
            `The boss added a requirement while the card was waiting for approval: ${note}\n\n` +
            `Rewrite the card so it covers this, then file it again with \`orch draft\`.`,
          skills,
        },
      });
    } else {
      ctx.sched.enqueue("agent_turn", {
        grp_id: grpId,
        payload: { role: roleFor(ctx, "lead_group"), rejection: `The boss wants a correction: ${note}`, skills },
      });
    }
  }
  ctx.sched.tick();
}
