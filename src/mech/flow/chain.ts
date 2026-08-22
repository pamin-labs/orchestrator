import { msg } from "@lingui/core/macro";
import type { Said } from "../../contracts/said.ts";
import { and, eq, isNull, ne } from "drizzle-orm";
import { answered, roleFor, type Ctx } from "../../mech/ctx.ts";
import { addNote } from "../util/rows.ts";
import type { DB } from "../../platform/persistence/database.ts";
import { agent as agentTable, escalation, grp, note as noteTable } from "../../platform/persistence/schema.ts";
import { activeTracer } from "../../platform/observability/traces.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { errText } from "../../platform/process/text.ts";
import { rollbackTo } from "../git/gitops.ts";
import { sandboxGit } from "../git/checkout.ts";
import { UTIL, WORK } from "../sandbox/sandbox.ts";
import { dropGroup } from "./start.ts";
import { release } from "./intercept.ts";
import {
  ESCALATION_OPEN_STATES,
  isDispatchableGrpState,
  isTerminalEscalationState,
  type EscalationOpenState,
  type EscalationState,
  isAskKind,
  TO_BOSS,
} from "../../contracts/states.ts";
import { outputLanguage } from "../../contracts/config.ts";

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
  /** What the asker said it is about. Null on every row filed before the column,
   *  and on the system-raised ones `escalate.ts` files with no kind at all. */
  kind: string | null;
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
      kind: escalation.kind,
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
        say: msg`for you: ${{ question: esc.question }}`,
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

const RESERVED_REFUSAL = "this one is reserved for the boss whatever the precedent";

/**
 * The five reserved topics, as a question for a reader who is not the PM.
 *
 * English, and not through `msg`: the reader is a model, which is ADR 035's
 * first exemption. The list is `TO_BOSS` said in sentences, and it is here
 * rather than in `states.ts` because the vocabulary is a contract and the way it
 * is asked is not.
 */
const CLASSIFY = [
  "Answer with one word, yes or no, and nothing else.",
  "Does the question below ask a person to decide any of these:",
  "spending money, or a budget; merging to the main branch; a credential, secret,",
  "token or API key; deploying or releasing to production; or changing what is in",
  "scope for the requirement?",
  "",
  "question:",
].join("\n");

/**
 * Whether this is reserved, asked of somebody other than the asker.
 *
 * The gate at the asking end is one word — `TO_BOSS.has(kind)` — and the agent
 * that saves itself a round trip by filing a budget question as `env` is the
 * same agent that files. So the PM's own attempt to answer is where it is asked
 * again, which is also the moment the damage would happen. That replaced ten
 * rows of per-language keyword regex; a model reads all ten languages, and the
 * regex's own comment recorded sixteen of eighteen probes leaking.
 */
/**
 * This is not "a gate a model can talk its way out of": the reader is not the
 * PM, it is not in the conversation, and it is shown the question rather than an
 * argument about the question.
 */
/**
 * Three edges, and they are not the same edge. No `askIn` at all is a
 * *configuration* — `indexModel.model` empty turns the cheap tier off — so the
 * second reader does not exist and this abstains; failing closed there would
 * leave a stand-in unable to answer anything on a deployment that chose to run
 * without it.
 */
/**
 * A call that throws, times out, or answers something that is not yes or no is a
 * check that did not run, and raises. That is what keeps the property the
 * declared topic had: no path routes a question *away* from the boss.
 *
 * ponytail: no cache and no deadline of its own — one call per answer attempt,
 * inside `modelAsk`'s own 60s. Bound it here if answer attempts ever get cheap
 * enough for that to be the slow part.
 */
async function secondOpinion(ctx: Ctx, esc: EscRow): Promise<boolean> {
  const askIn = ctx.askIn;
  if (!askIn) return false;
  return activeTracer().startActiveSpan("chain.reserved", async (span) => {
    try {
      const said = (await askIn(esc.grp_id ? { grp: esc.grp_id } : UTIL)(`${CLASSIFY}\n${esc.question.slice(0, 2000)}`))
        .trim()
        .toLowerCase();
      if (said.startsWith("yes")) return true;
      if (said.startsWith("no")) return false;
      throw new Error(`not a verdict: ${said.slice(0, 40)}`);
    } catch (cause) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(cause) });
      return true;
    } finally {
      span.end();
    }
  });
}

async function answerError(ctx: Ctx, esc: EscRow, input: AnswerInput): Promise<string | null> {
  if (esc.chain_state === "answered") return "already answered";
  const responder = responderError(esc, input.by, input.actorGrpId);
  if (responder) return responder;
  const citation = await citationError(ctx.db, input);
  if (citation) return citation;
  if (input.by === "boss") return null;
  // The stored word, not the question's prose: the same move `dedupe_key` made,
  // one column over. A row filed before the column has none and falls to the
  // reader below, which is why nothing had to be backfilled.
  if (esc.kind !== null && isAskKind(esc.kind) && TO_BOSS.has(esc.kind)) return RESERVED_REFUSAL;
  return (await secondOpinion(ctx, esc)) ? RESERVED_REFUSAL : null;
}

/** A level answers. Resolves whoever is blocked on `orch ask-boss`. */
export async function answer(
  deps: ChainDeps,
  input: AnswerInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ctx } = deps;
  const esc = await load(ctx.db, input.escId);
  if (!esc) return { ok: false, error: `no escalation ${input.escId}` };
  const refused = await answerError(ctx, esc, input);
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
    say: why ? msg`${{ by }} passed this up: ${{ why }}` : msg`${{ by }} passed this up, with no reason given`,
    meta: { escalation_id: escId, next },
  });
  await route(deps, escId);
  return { ok: true };
}

/**
 * Four sentences rather than an English article passed as a value.
 *
 * This was one template with `answered_by ?? "the"` in it, which put the word
 * "the" on the wire and read as "撤销了 the 的答复" in every language that has no
 * article. Out here rather than inline, so that naming the four does not make
 * `revoke` itself a branchier function than it is.
 */
function revoked(by: string | null, sha: string | undefined): Said {
  const at = sha?.slice(0, 8);
  if (by)
    return at ? msg`revoked ${{ by }}'s answer and rolled back to ${{ sha: at }}` : msg`revoked ${{ by }}'s answer`;
  return at ? msg`revoked the answer and rolled back to ${{ sha: at }}` : msg`revoked the answer`;
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
        say: msg`answer revoked, but the rollback to ${{ sha: esc.checkpoint_sha.slice(0, 8) }} failed: ${{ why: back.error ?? "" }}`,
      });
    }
  }
  await ctx.bus.emit({
    grpId: esc.grp_id,
    author: "boss",
    kind: "state_change",
    say: revoked(esc.answered_by, rolledBackTo),
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
    await addNote(ctx.db, { grpId, kind: "fact", lang: outputLanguage(ctx.config), body });
  }
  await ctx.bus.emit({
    grpId,
    author: roleFor(ctx, "triage_boss_feedback"),
    kind: "state_change",
    intent: "decision",
    say: msg`triaged as ${{ as: as }}: ${{ note }}`,
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
