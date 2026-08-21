import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { answered, awaitAnswer, roleFor, type Ctx } from "../../mech/ctx.ts";
import {
  abstain,
  CHAIN,
  answer as chainAnswer,
  entryPoint,
  revoke,
  route,
  TRIAGE,
  triage,
} from "../../mech/flow/chain.ts";
import { raise } from "../../mech/flow/escalate.ts";
import { hold } from "../../mech/flow/intercept.ts";
import { newGroup } from "../../mech/flow/newgroup.ts";
import { sandboxGit } from "../../mech/git/checkout.ts";
import { WORK } from "../../mech/sandbox/sandbox.ts";
import { Attachment as AttachmentSchema, GroupRef, Id, IdParams, Prose } from "../../contracts/fields.ts";
import { withAttachments } from "../../mech/util/attachment-text.ts";
import { bossFact } from "../panel/attach.ts";
import type { AgentHandler, Handler } from "../../http/handler.ts";
import { badEnglish, json, message } from "../../http/respond.ts";
import { mayAct, resolveGroup } from "./access.ts";
import { slug } from "../slug.ts";
import {
  agent,
  escalation as escalations,
  grp as grps,
  note as notes,
  slice as slices,
} from "../../platform/persistence/schema.ts";

/**
 * A question that an agent could not answer for itself, and everything that
 * happens to it after.
 *
 * The chain is the point: a question goes up one level at a time and only
 * reaches the boss when nobody below could take it. So filing, answering,
 * delegating back down, withdrawing, and turning one into a requirement of its
 * own are one subject, not five.
 */

/**
 * What kind of question it is, from a closed set.
 *
 * Closed, because the queue groups by it: free text would give twelve spellings
 * of "environment" and group nothing. Unknown or missing falls to `other` rather
 * than being rejected — same rule as the brief, an agent must never be stuck on
 * a taxonomy.
 */
const ASK_KINDS = ["env", "spec", "boundary", "design", "other"] as const;
export type AskKind = (typeof ASK_KINDS)[number];
const isAskKind = (value: string): value is AskKind => ASK_KINDS.some((kind) => kind === value);

export const askKind = (given: string | undefined): AskKind => {
  const value = given?.trim() ?? "";
  return isAskKind(value) ? value : "other";
};

export function brief(given: string | undefined, question: string): string {
  const raw = (given ?? question.split(/[\n。.!?！？]/)[0] ?? "").trim();
  return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw;
}

/**
 * `kind` and `severity` fall back rather than refuse.
 *
 * Same rule the brief follows: a question that cannot be filed is an agent stuck
 * on a taxonomy, and the fallbacks are right often enough. `askKind` maps
 * anything unfamiliar to `other`; anything that is not the word "blocker" is
 * advisory, because promoting a question to a blocker on a typo stops a group.
 */
export const AskBossBody = z.object({
  question: Prose(),
  severity: z.string().max(20).optional(),
  brief: z.string().max(200).optional(),
  kind: z.string().max(40).optional(),
});

export const postAskBoss = (async (ctx, _req, a, _p, b) => {
  const severity = b.severity === "blocker" ? "blocker" : "advisory";

  const id = (await raise(ctx.db, {
    grpId: a.grp_id,
    agentId: a.id,
    severity,
    question: b.question,
    brief: brief(b.brief, b.question),
    kind: askKind(b.kind),
    chain: entryPoint(b.question),
  }))!;
  // Before `route()`, not after: it can hand the question to a stand-in that
  // answers within the same tick, and an answer with no waiter yet is dropped.
  // The symptom was a request that never returned — an agent blocked forever on
  // a question that had already been answered.
  const answer = awaitAnswer(ctx, id);

  // The commit the question was asked at, so a stand-in's answer can be undone.
  if (a.grp_id) {
    const head = await sandboxGit(ctx, { grp: a.grp_id })(["rev-parse", "HEAD"], WORK);
    if (head.code === 0) {
      await ctx.db.update(escalations).set({ checkpoint_sha: head.out.trim() }).where(eq(escalations.id, id));
    }
  }
  await ctx.db.update(agent).set({ state: "blocked" }).where(eq(agent.id, a.id));
  // A blocker is the one intent that stops the whole group: the answer changes
  // the premise everyone else is reasoning from.
  if (severity === "blocker" && a.grp_id) {
    await hold(ctx.db, a.grp_id, { reason: "escalation", from: "RUNNING" });
  }
  await ctx.bus.emit({
    grpId: a.grp_id,
    author: a.role,
    kind: "escalation",
    intent: "ask",
    severity,
    body: b.question,
    meta: { escalation_id: id },
  });

  await route({ ctx, ...(ctx.notifyBoss ? { notifyBoss: ctx.notifyBoss } : {}) }, id);

  const text = await answer;
  await ctx.db.update(agent).set({ state: "idle" }).where(eq(agent.id, a.id));
  return message(text);
}) satisfies AgentHandler<z.infer<typeof AskBossBody>>;

export const AnswerBody = z.object({
  escalation_id: Id,
  answer: z.string().max(20_000).optional(),
  abstain: z.boolean().optional(),
  why: z.string().max(4000).optional(),
  ref: Id.optional(),
});

export const postAnswer2 = (async (ctx, _req, a, _p, b) => {
  const deps = { ctx, ...(ctx.notifyBoss ? { notifyBoss: ctx.notifyBoss } : {}) };
  const level = z.enum(CHAIN).safeParse(a.role);
  if (!level.success) return badEnglish(`${a.role} is not an answer-chain level`);

  if (b.abstain) {
    // Abstaining is the expected move when a level is unsure: a guess made on
    // the boss's behalf becomes a premise the whole group reasons from.
    const r = await abstain(deps, b.escalation_id, level.data, b.why ?? "", a.grp_id);
    return r.ok ? message("passed up") : badEnglish(r.error);
  }
  if (!b.answer?.trim()) return badEnglish("an answer needs text, or pass --abstain");
  const r = await chainAnswer(deps, {
    escId: b.escalation_id,
    by: level.data,
    answer: b.answer,
    actorGrpId: a.grp_id,
    ...(b.ref === undefined ? {} : { refNoteId: b.ref }),
  });
  return r.ok ? message("ok") : badEnglish(r.error);
}) satisfies AgentHandler<z.infer<typeof AnswerBody>>;

export const TriageBody = z.object({
  group_id: GroupRef,
  as: z.enum(TRIAGE),
  note: z.string().max(8000).optional(),
});

export const postTriage = (async (ctx, _req, a, _p, b) => {
  if (a.role !== roleFor(ctx, "triage_boss_feedback"))
    return badEnglish(`${a.role} does not triage the boss's feedback`);
  const gid = await resolveGroup(ctx, b.group_id);
  if (!gid) return badEnglish("which group? pass its id or name");
  if (!(await mayAct(ctx.db, a, gid))) return message("not your group", 403);
  await triage({ ctx, bossFact: (g, body) => bossFact(ctx, g, body) }, gid, b.as, b.note ?? "");
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof TriageBody>>;

/**
 * This question is not a question. It is a piece of work.
 *
 * The commonest thing on the boss's queue is a blocker no answer resolves: a config
 * file is wrong, a shared fixture is broken, four groups are red on one line.
 * Answering means typing the fix into a chat box for an agent not allowed to apply
 * it, so these sat in 待办 until the boss did the work by hand.
 *
 * `orch blocked` is the same move made by an agent.
 */
/** A question the boss turns into a requirement of its own. */
export const RequirementBody = z.object({
  text: z.string().max(20_000).optional(),
  name: z.string().max(80).optional(),
});

export const postEscalationRequirement = (async (ctx, _req, params, b) => {
  const id = params.id;
  const [esc] = await ctx.db
    .select({ grp_id: escalations.grp_id, question: escalations.question, answer: escalations.answer })
    .from(escalations)
    .where(eq(escalations.id, id));
  if (!esc) return message("no such question", 404);
  if (esc.answer) return badEnglish("already answered");

  // A standing agent carries the project on itself; one inside a group carries it
  // on the group. The join replaces a scalar subquery reading the asker's id back
  // out of the row this handler already has.
  const [owner] = esc.grp_id
    ? await ctx.db.select({ project_id: grps.project_id }).from(grps).where(eq(grps.id, esc.grp_id))
    : await ctx.db
        .select({ project_id: agent.project_id })
        .from(escalations)
        .leftJoin(agent, eq(agent.id, escalations.agent_id))
        .where(eq(escalations.id, id));
  const projectId = owner?.project_id ?? null;
  if (!projectId) return badEnglish("cannot tell which project this belongs to");

  const idea = [b.text?.trim(), esc.question].filter(Boolean).join("\n\n");
  const name = (b.name ?? slug(idea)).slice(0, 40) || `esc-${id}`;
  const grp = await ctx.bus.transaction(async (tx) => {
    const created = await newGroup(ctx, { projectId, name, idea });
    await ctx.sched.enqueue("agent_turn", {
      grp_id: created.id,
      priority: 6,
      payload: { role: roleFor(ctx, "plan_requirement"), idea },
    });

    await tx
      .update(escalations)
      .set({
        answer: `开成需求 ${name}（grp ${created.id}）`,
        answered_by: "boss",
        chain_state: "answered",
        answered_at: Date.now(),
      })
      .where(eq(escalations.id, id));
    // A blocker on a group that has already stopped is what `blocked_on` is for: the
    // group comes back by itself when the new requirement lands, so this does not
    // become a second thing for the boss to remember.
    if (esc.grp_id) {
      await tx
        .update(grps)
        .set({ blocked_on: created.id })
        // `isNull`, not `eq(..., null)`: only a group nothing else is already
        // waiting on may be pointed at this new one.
        .where(and(eq(grps.id, esc.grp_id), inArray(grps.status, ["PAUSED", "PAUSING"]), isNull(grps.blocked_on)));
      await ctx.bus.emit({
        grpId: esc.grp_id,
        author: "boss",
        kind: "state_change",
        body: `这个问题开成了需求 ${name}（grp ${created.id}）`,
        meta: { requirement: created.id, escalation_id: id },
      });
    }
    return created;
  });
  answered(ctx, id, `the boss turned this into requirement ${name} (grp ${grp.id}); stop and wait for it`);
  await ctx.sched.tick();
  return json({ grp_id: grp.id, name });
}) satisfies Handler<z.infer<typeof RequirementBody>, z.infer<typeof IdParams>>;

export const postRevoke = (async (ctx, _req, params) => {
  const out = await revoke({ ctx }, params.id);
  return json(out);
}) satisfies Handler<undefined, z.infer<typeof IdParams>>;

export const BossAnswerBody = z.object({
  answer: z.string().min(1).max(20_000),
  attachments: z.array(AttachmentSchema).max(20).optional(),
});

export const postAnswer = (async (ctx, _req, params, b) => {
  const id = params.id;
  const [esc] = await ctx.db
    .select({ grp_id: escalations.grp_id, severity: escalations.severity })
    .from(escalations)
    .where(eq(escalations.id, id));
  if (!esc) return message("no such escalation", 404);

  // The boss answers through the same path a stand-in would, so unblocking the
  // caller and un-pausing the group cannot drift between the two.
  const r = await chainAnswer({ ctx }, { escId: id, by: "boss", answer: withAttachments(b.answer, b.attachments) });
  return r.ok ? message("ok") : badEnglish(r.error);
}) satisfies Handler<z.infer<typeof BossAnswerBody>, z.infer<typeof IdParams>>;

/**
 * A first draft of the answer, from the cheapest model there is.
 *
 * Most of what reaches the boss is not a judgement call — it is a question whose
 * answer is already on the blackboard, asked by an agent that could not find it.
 * Writing that out by hand is the boss doing retrieval, which is the one job this
 * system has. So: the same context the agent had, and one cheap call.
 */
/**
 * A draft in a box, never the answer: nothing is sent until the boss sends it, and
 * it lands in the composer where it can be rewritten. Generated on open rather
 * than stored, because the blackboard moves while a question waits and a stored
 * draft is a stale one.
 *
 * No draft is a fine outcome — unreachable model, nothing useful to say, and the
 * composer is just the composer.
 */
type AnswerDraftRow = {
  grp_id: number | null;
  question: string;
  severity: string;
  asker: string | null;
  project_id: number | null;
};

async function answerDraftContext(
  ctx: Ctx,
  groupId: number | null,
): Promise<{ requirement: string; notes: string[]; slices: string[] }> {
  if (!groupId) return { requirement: "standing", notes: [], slices: [] };
  const [found] = await ctx.db.select({ name: grps.name }).from(grps).where(eq(grps.id, groupId));
  const requirement = found?.name ?? "?";
  const recent = await ctx.db
    .select({ kind: notes.kind, body: notes.body })
    .from(notes)
    // The standing half of the blackboard has no group, so `isNull` is what puts
    // it in scope at all — `eq(grp_id, null)` would drop every one of them.
    .where(
      or(eq(notes.grp_id, groupId), and(isNull(notes.grp_id), inArray(notes.kind, ["decision", "lesson", "fact"]))),
    )
    // Both keys: `at` alone reorders the notes written inside one millisecond.
    .orderBy(desc(notes.at), desc(notes.id))
    .limit(12);
  const noteLines = recent.map((note) => `[${note.kind}] ${note.body.slice(0, 400)}`);
  const planned = await ctx.db
    .select({ seq: slices.seq, title: slices.title, status: slices.status })
    .from(slices)
    .where(eq(slices.grp_id, groupId))
    .orderBy(slices.seq);
  const sliceLines = planned.map((slice) => `S${slice.seq} ${slice.status} ${slice.title}`);
  return { requirement, notes: noteLines, slices: sliceLines };
}

/**
 * Scaffolding for a model, so it is English and has no second version.
 *
 * This was a Chinese half and an English half behind `isChinese(language)` — the
 * last two-language pair in the codebase, and the reason a boss reading Korean
 * got the English one. But the branch answered a question nobody asked: what the
 * boss reads is the *draft*, and its language comes from the `## Output
 * language` block `src/prompt/assemble.ts` injects. Nothing here is read by a
 * person.
 */
function answerDraftPrompt(
  escalation: AnswerDraftRow,
  context: Awaited<ReturnType<typeof answerDraftContext>>,
): string {
  return [
    "You draft answers for the boss. Below is a question an agent escalated, plus this requirement's blackboard. Write a reply the boss can send as it stands.",
    "Rules: conclusion and evidence, no preamble, no restating the question, at most 4 lines. Answer from the blackboard where it can be answered; where it cannot, say what is missing and give the decision you think most likely.",
    "",
    `requirement: ${context.requirement}`,
    `asker: ${escalation.asker ?? "?"} (${escalation.severity})`,
    `question: ${escalation.question.slice(0, 2000)}`,
    context.slices.length ? `\nslices:\n${context.slices.join("\n")}` : "",
    context.notes.length ? `\nblackboard:\n${context.notes.join("\n")}` : "",
  ].join("\n");
}

export const getAnswerDraft = (async (ctx, _req, params) => {
  if (!ctx.askIn) return json({ text: "" });
  const [escalation]: (AnswerDraftRow | undefined)[] = await ctx.db
    .select({
      grp_id: escalations.grp_id,
      question: escalations.question,
      severity: escalations.severity,
      asker: agent.role,
      // Raw: `coalesce` has no Drizzle operator. A standing agent carries the
      // project on itself; one inside a group carries it on the group.
      project_id: sql<number | null>`coalesce(${grps.project_id}, ${agent.project_id})`,
    })
    .from(escalations)
    .leftJoin(agent, eq(agent.id, escalations.agent_id))
    .leftJoin(grps, eq(grps.id, escalations.grp_id))
    .where(and(eq(escalations.id, params.id), isNull(escalations.answer)));
  if (!escalation?.project_id) return json({ text: "" });
  // The blackboard is newest-first and capped: this is the cheapest model in
  // the system and a 40k-character prompt costs more than the answer is worth.
  const context = await answerDraftContext(ctx, escalation.grp_id);
  const prompt = answerDraftPrompt(escalation, context);

  try {
    const out = (await ctx.askIn({ project: escalation.project_id })(prompt)).trim();
    return json({ text: out.length > 1200 ? out.slice(0, 1200) : out });
  } catch {
    return json({ text: "" });
  }
}) satisfies Handler<undefined, z.infer<typeof IdParams>>;

/**
 * Hand a question back down the chain instead of answering it.
 *
 * docs/project/plan.md §8 puts `[回答] [转 Architect]` on the same line for a reason: plenty of
 * what reaches the boss is a technical call somebody else should make, and
 * without this the only ways out are answering it or leaving it to rot.
 */
/**
 * `to` is checked against `CHAIN` rather than restated as an enum here: the
 * chain is the order questions travel in, it lives in one place, and a copy of
 * it in a schema is the copy that goes stale when a level is added.
 */
export const DelegateBody = z.object({ to: z.enum(CHAIN).exclude(["boss"]).default("architect") });

export const postDelegate = (async (ctx, _req, params, b) => {
  const to = b.to;
  const id = params.id;
  const [esc] = await ctx.db
    .select({ grp_id: escalations.grp_id, question: escalations.question })
    .from(escalations)
    .where(eq(escalations.id, id));
  if (!esc) return message("no such escalation", 404);

  await ctx.db.update(escalations).set({ chain_state: to }).where(eq(escalations.id, id));
  await ctx.bus.emit({
    grpId: esc.grp_id,
    author: "boss",
    kind: "escalation",
    intent: "request",
    body: `转给 ${to}：${esc.question}`,
    meta: { escalation_id: id, chain_state: to },
  });
  // route() skips a level with nobody in it, so this cannot strand the question:
  // worst case it comes straight back.
  const landed = await route({ ctx, ...(ctx.notifyBoss ? { notifyBoss: ctx.notifyBoss } : {}) }, id);
  return message(landed);
}) satisfies Handler<z.infer<typeof DelegateBody>, z.infer<typeof IdParams>>;
