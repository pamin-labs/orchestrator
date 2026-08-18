import { z } from "zod";
import type { Ctx } from "../../mech/ctx.ts";
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
import type { SliceState } from "../../contracts/states.ts";
import { Attachment as AttachmentSchema, GroupRef, Id, IdParams, Prose } from "../../contracts/fields.ts";
import { withAttachments } from "../../mech/util/attachment-text.ts";
import { bossFact } from "../panel/attach.ts";
import type { AgentHandler, Handler } from "../../http/handler.ts";
import { bad, json, message } from "../../http/respond.ts";
import { mayAct, resolveGroup } from "./access.ts";
import { slug } from "../slug.ts";

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

  const id = raise(ctx.db, {
    grpId: a.grp_id,
    agentId: a.id,
    severity,
    question: b.question,
    brief: brief(b.brief, b.question),
    kind: askKind(b.kind),
    chain: entryPoint(b.question),
  })!;

  // The commit the question was asked at, so a stand-in's answer can be undone.
  if (a.grp_id) {
    const head = await sandboxGit(ctx, { grp: a.grp_id })(["rev-parse", "HEAD"], WORK);
    if (head.code === 0) {
      ctx.db.run("UPDATE escalation SET checkpoint_sha = ? WHERE id = ?", [head.out.trim(), id]);
    }
  }
  ctx.db.run("UPDATE agent SET state = 'blocked' WHERE id = ?", [a.id]);
  // A blocker is the one intent that stops the whole group: the answer changes
  // the premise everyone else is reasoning from.
  if (severity === "blocker" && a.grp_id) {
    hold(ctx.db, a.grp_id, { reason: "escalation", from: "RUNNING" });
  }
  ctx.bus.emit({
    grpId: a.grp_id,
    author: a.role,
    kind: "escalation",
    intent: "ask",
    severity,
    body: b.question,
    meta: { escalation_id: id },
  });

  route({ ctx, ...(ctx.notifyBoss ? { notifyBoss: ctx.notifyBoss } : {}) }, id);

  const answer = await new Promise<string>((resolve) => {
    ctx.waiters.set(`escalation:${id}`, resolve);
  });
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ?", [a.id]);
  return message(answer);
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
  if (!level.success) return bad(`${a.role} is not an answer-chain level`);

  if (b.abstain) {
    // Abstaining is the expected move when a level is unsure: a guess made on
    // the boss's behalf becomes a premise the whole group reasons from.
    const r = abstain(deps, b.escalation_id, level.data, b.why ?? "", a.grp_id);
    return r.ok ? message("passed up") : bad(r.error);
  }
  if (!b.answer?.trim()) return bad("an answer needs text, or pass --abstain");
  const r = chainAnswer(deps, {
    escId: b.escalation_id,
    by: level.data,
    answer: b.answer,
    actorGrpId: a.grp_id,
    ...(b.ref === undefined ? {} : { refNoteId: b.ref }),
  });
  return r.ok ? message("ok") : bad(r.error);
}) satisfies AgentHandler<z.infer<typeof AnswerBody>>;

export const TriageBody = z.object({
  group_id: GroupRef,
  as: z.enum(TRIAGE),
  note: z.string().max(8000).optional(),
});

export const postTriage = (async (ctx, _req, a, _p, b) => {
  if (a.role !== "cos") return bad(`${a.role} does not triage the boss's feedback`);
  const gid = resolveGroup(ctx, b.group_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx.db, a, gid)) return message("not your group", 403);
  triage({ ctx, bossFact: (g, body) => bossFact(ctx, g, body) }, gid, b.as, b.note ?? "");
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof TriageBody>>;

/**
 * This question is not a question. It is a piece of work.
 *
 * The commonest thing on the boss's queue is a blocker that no answer resolves:
 * a config file is wrong, a shared fixture is broken, four groups are red on one
 * line. Answering it means typing the fix into a chat box for an agent that is not
 * allowed to apply it; the honest response is "somebody has to go and do this".
 * There was no way to say that, so these sat in 待办 until the boss did the work
 * by hand — which is the one outcome the whole system exists to avoid.
 *
 * `orch blocked` is the same move made by an agent. This is it made by the boss,
 * on anything already in the queue, including the findings agents cannot act on.
 */
/** A question the boss turns into a requirement of its own. */
export const RequirementBody = z.object({
  text: z.string().max(20_000).optional(),
  name: z.string().max(80).optional(),
});

export const postEscalationRequirement = (async (ctx, _req, params, b) => {
  const id = params.id;
  const esc = ctx.db
    .query<{ grp_id: number | null; question: string; answer: string | null }, [number]>(
      "SELECT grp_id, question, answer FROM escalation WHERE id = ?",
    )
    .get(id);
  if (!esc) return message("no such question", 404);
  if (esc.answer) return bad("already answered");

  const projectId = esc.grp_id
    ? (ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(esc.grp_id)
        ?.project_id ?? null)
    : (ctx.db
        .query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?")
        .get(
          ctx.db.query<{ agent_id: number | null }, [number]>("SELECT agent_id FROM escalation WHERE id = ?").get(id)
            ?.agent_id ?? 0,
        )?.project_id ?? null);
  if (!projectId) return bad("cannot tell which project this belongs to");

  const idea = [b.text?.trim(), esc.question].filter(Boolean).join("\n\n");
  const name = (b.name ?? slug(idea)).slice(0, 40) || `esc-${id}`;
  const grp = ctx.db.transaction(() => {
    const created = newGroup(ctx, { projectId, name, idea });
    ctx.sched.enqueue("agent_turn", { grp_id: created.id, priority: 6, payload: { role: "dispatcher", idea } });

    ctx.db.run(
      `UPDATE escalation SET answer = ?, answered_by = 'boss', chain_state = 'answered',
       answered_at = unixepoch() * 1000 WHERE id = ?`,
      [`开成需求 ${name}（grp ${created.id}）`, id],
    );
    // A blocker on a group that has already stopped is what `blocked_on` is for: the
    // group comes back by itself when the new requirement lands, so this does not
    // become a second thing for the boss to remember.
    if (esc.grp_id) {
      ctx.db.run(
        `UPDATE grp SET blocked_on = ? WHERE id = ? AND status IN ('PAUSED','PAUSING') AND blocked_on IS NULL`,
        [created.id, esc.grp_id],
      );
      ctx.bus.emit({
        grpId: esc.grp_id,
        author: "boss",
        kind: "state_change",
        body: `这个问题开成了需求 ${name}（grp ${created.id}）`,
        meta: { requirement: created.id, escalation_id: id },
      });
    }
    return created;
  })();
  const w = ctx.waiters.get(`escalation:${id}`);
  ctx.waiters.delete(`escalation:${id}`);
  w?.(`the boss turned this into requirement ${name} (grp ${grp.id}); stop and wait for it`);
  ctx.sched.tick();
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
  const esc = ctx.db
    .query<{ grp_id: number | null; severity: string }, [number]>(
      "SELECT grp_id, severity FROM escalation WHERE id = ?",
    )
    .get(id);
  if (!esc) return message("no such escalation", 404);

  // The boss answers through the same path a stand-in would, so unblocking the
  // caller and un-pausing the group cannot drift between the two.
  const r = chainAnswer({ ctx }, { escId: id, by: "boss", answer: withAttachments(b.answer, b.attachments) });
  return r.ok ? message("ok") : bad(r.error);
}) satisfies Handler<z.infer<typeof BossAnswerBody>, z.infer<typeof IdParams>>;

/**
 * A first draft of the answer, from the cheapest model there is.
 *
 * Answering is one of the boss's three approval points, and most of what reaches
 * it is not a judgement call — it is a question whose answer is already in the
 * blackboard, asked by an agent that could not find it. Writing that answer out
 * by hand is the boss doing retrieval, which is the one job this system has.
 *
 * So: same context the agent had — the group's journal, its decisions, its
 * slices — and one cheap call. It is a draft in a box, never the answer: nothing
 * is sent until the boss sends it, and it lands in the composer where it can be
 * rewritten. Generated on open rather than stored, because a stored draft is a
 * stale one — the blackboard moves while the question waits, and by the time the
 * boss looks, the reason for the answer may have changed.
 *
 * No draft is a fine outcome. If the model is unreachable or says nothing useful
 * this returns nothing and the composer is the composer.
 */
type AnswerDraftRow = {
  grp_id: number | null;
  question: string;
  severity: string;
  asker: string | null;
  project_id: number | null;
};

function answerDraftContext(
  ctx: Ctx,
  groupId: number | null,
): { requirement: string; notes: string[]; slices: string[] } {
  if (!groupId) return { requirement: ctx.config.language === "en" ? "standing" : "常驻岗", notes: [], slices: [] };
  const requirement =
    ctx.db.query<{ name: string }, [number]>("SELECT name FROM grp WHERE id = ?").get(groupId)?.name ?? "?";
  const notes = ctx.db
    .query<{ kind: string; body: string }, [number]>(
      `SELECT kind, body FROM note
       WHERE (grp_id = ? OR (grp_id IS NULL AND kind IN ('decision','lesson','fact')))
       ORDER BY at DESC, id DESC LIMIT 12`,
    )
    .all(groupId)
    .map((note) => `[${note.kind}] ${note.body.slice(0, 400)}`);
  const slices = ctx.db
    .query<{ seq: number; title: string; status: SliceState }, [number]>(
      "SELECT seq, title, status FROM slice WHERE grp_id = ? ORDER BY seq",
    )
    .all(groupId)
    .map((slice) => `S${slice.seq} ${slice.status} ${slice.title}`);
  return { requirement, notes, slices };
}

function answerDraftPrompt(
  language: string,
  escalation: AnswerDraftRow,
  context: ReturnType<typeof answerDraftContext>,
): string {
  const [intro, rules, requirement, asker, question, slices, notes] =
    language === "en"
      ? [
          "You draft answers for the boss. Below is a question an agent escalated, plus this requirement's blackboard. Write the reply the boss could send as-is.",
          "Rules: conclusion and evidence, no preamble, no restating the question, at most 4 lines. Answer from the blackboard when it is there; when it is not, say what is missing and give the most likely decision.",
          "requirement",
          "asker",
          "question",
          "slices",
          "blackboard",
        ]
      : [
          "你是老板的助手。下面是一个 agent 提给老板的问题，以及这个需求的黑板内容。写出老板可以直接发出去的答复。",
          "要求：直接给结论和依据，不要开场白，不要复述问题，不超过 4 行。黑板里答得出来就直接答；答不出来就说清楚缺什么、并给出你认为最可能的决定。",
          "需求",
          "提问的人",
          "问题",
          "切片",
          "黑板",
        ];
  return [
    intro,
    rules,
    "",
    `${requirement}: ${context.requirement}`,
    `${asker}: ${escalation.asker ?? "?"} (${escalation.severity})`,
    `${question}: ${escalation.question.slice(0, 2000)}`,
    context.slices.length ? `\n${slices}:\n${context.slices.join("\n")}` : "",
    context.notes.length ? `\n${notes}:\n${context.notes.join("\n")}` : "",
  ].join("\n");
}

export const getAnswerDraft = (async (ctx, _req, params) => {
  if (!ctx.askIn) return json({ text: "" });
  const escalation = ctx.db
    .query<AnswerDraftRow, [number]>(
      `SELECT e.grp_id, e.question, e.severity, a.role AS asker,
              coalesce(g.project_id, a.project_id) AS project_id
      FROM escalation e LEFT JOIN agent a ON a.id = e.agent_id
       LEFT JOIN grp g ON g.id = e.grp_id
       WHERE e.id = ? AND e.answer IS NULL`,
    )
    .get(params.id);
  if (!escalation?.project_id) return json({ text: "" });
  // The blackboard is newest-first and capped: this is the cheapest model in
  // the system and a 40k-character prompt costs more than the answer is worth.
  const prompt = answerDraftPrompt(ctx.config.language, escalation, answerDraftContext(ctx, escalation.grp_id));

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
  const esc = ctx.db
    .query<{ grp_id: number | null; question: string }, [number]>(
      "SELECT grp_id, question FROM escalation WHERE id = ?",
    )
    .get(id);
  if (!esc) return message("no such escalation", 404);

  ctx.db.run("UPDATE escalation SET chain_state = ? WHERE id = ?", [to, id]);
  ctx.bus.emit({
    grpId: esc.grp_id,
    author: "boss",
    kind: "escalation",
    intent: "request",
    body: `转给 ${to}：${esc.question}`,
    meta: { escalation_id: id, chain_state: to },
  });
  // route() skips a level with nobody in it, so this cannot strand the question:
  // worst case it comes straight back.
  const landed = route({ ctx, ...(ctx.notifyBoss ? { notifyBoss: ctx.notifyBoss } : {}) }, id);
  return message(landed);
}) satisfies Handler<z.infer<typeof DelegateBody>, z.infer<typeof IdParams>>;
