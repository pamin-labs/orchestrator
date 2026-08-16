import { abstain, answer as chainAnswer, CHAIN, entryPoint, revoke, route, triage, type Triage } from "../mech/flow/chain.ts";
import { z } from "zod";
import { GroupRef, Prose } from "./valid.ts";
import { bad, body, json, mayAct, resolveGroup, text, type AgentHandler, type Handler } from "./shared.ts";
import { bossFact, withAttachments, type Attachment } from "./attach.ts";
import { slug } from "./slug.ts";
import { sandboxGit } from "../mech/git/checkout.ts";
import { WORK } from "../mech/sandbox/sandbox.ts";

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
export const ASK_KINDS = ["env", "spec", "boundary", "design", "other"] as const;

export const askKind = (given: string | undefined): string =>
  ASK_KINDS.includes((given ?? "").trim() as (typeof ASK_KINDS)[number]) ? given!.trim() : "other";

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

export const postAskBoss: AgentHandler<z.infer<typeof AskBossBody>> = async (ctx, _req, a, _p, b) => {
  const severity = b.severity === "blocker" ? "blocker" : "advisory";

  const row = ctx.db
    .query<{ id: number }, [number | null, number, string, string, string, string]>(
      `INSERT INTO escalation (grp_id, agent_id, severity, question, brief, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    )
    .get(a.grp_id, a.id, severity, b.question, brief(b.brief, b.question), askKind(b.kind))!;

  // The commit the question was asked at, so a stand-in's answer can be undone.
  if (a.grp_id) {
    const head = await sandboxGit(ctx, { grp: a.grp_id })(WORK, ["rev-parse", "HEAD"], WORK);
    if (head.code === 0) {
      ctx.db.run("UPDATE escalation SET checkpoint_sha = ? WHERE id = ?", [head.out.trim(), row.id]);
    }
  }
  ctx.db.run("UPDATE escalation SET chain_state = ? WHERE id = ?", [entryPoint(b.question), row.id]);

  ctx.db.run("UPDATE agent SET state = 'blocked' WHERE id = ?", [a.id]);
  // A blocker is the one intent that stops the whole group: the answer changes
  // the premise everyone else is reasoning from.
  if (severity === "blocker" && a.grp_id) {
    ctx.db.run(
      "UPDATE grp SET status = 'PAUSING', paused_at = unixepoch() * 1000 WHERE id = ? AND status = 'RUNNING'",
      [a.grp_id],
    );
  }
  ctx.bus.emit({
    grpId: a.grp_id,
    author: a.role,
    kind: "escalation",
    intent: "ask",
    severity,
    body: b.question,
    meta: { escalation_id: row.id },
  });

  route({ ctx, notifyBoss: ctx.notifyBoss }, row.id);

  const answer = await new Promise<string>((resolve) => {
    ctx.waiters.set(`escalation:${row.id}`, resolve);
  });
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ?", [a.id]);
  return text(answer);
};

export const AnswerBody = z.object({
  escalation_id: z.number().int().positive(),
  answer: z.string().max(20_000).optional(),
  abstain: z.boolean().optional(),
  why: z.string().max(4000).optional(),
  ref: z.number().int().positive().optional(),
});

export const postAnswer2: AgentHandler<z.infer<typeof AnswerBody>> = async (ctx, _req, a, _p, b) => {
  const deps = { ctx, notifyBoss: ctx.notifyBoss };

  if (b.abstain) {
    // Abstaining is the expected move when a level is unsure: a guess made on
    // the boss's behalf becomes a premise the whole group reasons from.
    abstain(deps, b.escalation_id, a.role, b.why ?? "");
    return text("passed up");
  }
  if (!b.answer?.trim()) return bad("an answer needs text, or pass --abstain");
  const r = chainAnswer(deps, {
    escId: b.escalation_id,
    by: a.role,
    answer: b.answer,
    refNoteId: b.ref,
  });
  return r.ok ? text("ok") : bad(r.error);
};

export const TriageBody = z.object({
  group_id: GroupRef,
  as: z.enum(["patch", "respec", "reject"]),
  note: z.string().max(8000).optional(),
});

export const postTriage: AgentHandler<z.infer<typeof TriageBody>> = async (ctx, _req, a, _p, b) => {
  if (a.role !== "cos") return bad(`${a.role} does not triage the boss's feedback`);
  const gid = resolveGroup(ctx, b.group_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your group", 403);
  triage({ ctx, bossFact: (g, body) => bossFact(ctx, g, body) }, gid, b.as as Triage, b.note ?? "");
  return text("ok");
};

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
export const postEscalationRequirement: Handler = async (ctx, req, params) => {
  const id = Number(params.id);
  const b = await body<{ text?: string; name?: string }>(req);
  const esc = ctx.db
    .query<{ grp_id: number | null; question: string; answer: string | null }, [number]>(
      "SELECT grp_id, question, answer FROM escalation WHERE id = ?",
    )
    .get(id);
  if (!esc) return text("no such question", 404);
  if (esc.answer) return bad("already answered");

  const projectId = esc.grp_id
    ? (ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(esc.grp_id)
        ?.project_id ?? null)
    : (ctx.db.query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?").get(
        ctx.db.query<{ agent_id: number | null }, [number]>("SELECT agent_id FROM escalation WHERE id = ?").get(id)
          ?.agent_id ?? 0,
      )?.project_id ?? null);
  if (!projectId) return bad("cannot tell which project this belongs to");

  const idea = [b.text?.trim(), esc.question].filter(Boolean).join("\n\n");
  const name = (b.name ?? slug(idea)).slice(0, 40) || `esc-${id}`;
  const grp = ctx.db
    .query<{ id: number }, [number, string]>(
      "INSERT INTO grp (project_id, name, status, created_at) VALUES (?, ?, 'PLANNING', unixepoch() * 1000) RETURNING id",
    )
    .get(projectId, name)!;
  ctx.db.run("INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (?, ?, 'group', unixepoch() * 1000)", [
    projectId,
    grp.id,
  ]);
  ctx.db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
    [projectId, grp.id, ctx.config.language, idea],
  );
  ctx.bus.emit({ grpId: grp.id, author: "boss", kind: "boss_say", intent: "request", body: idea });
  ctx.sched.enqueue("agent_turn", { grp_id: grp.id, priority: 6, payload: { role: "dispatcher", idea } });

  ctx.db.run(
    `UPDATE escalation SET answer = ?, answered_by = 'boss', chain_state = 'answered',
     answered_at = unixepoch() * 1000 WHERE id = ?`,
    [`开成需求 ${name}（grp ${grp.id}）`, id],
  );
  // A blocker on a group that has already stopped is what `blocked_on` is for: the
  // group comes back by itself when the new requirement lands, so this does not
  // become a second thing for the boss to remember.
  if (esc.grp_id) {
    ctx.db.run(
      `UPDATE grp SET blocked_on = ? WHERE id = ? AND status IN ('PAUSED','PAUSING') AND blocked_on IS NULL`,
      [grp.id, esc.grp_id],
    );
    ctx.bus.emit({
      grpId: esc.grp_id,
      author: "boss",
      kind: "state_change",
      body: `这个问题开成了需求 ${name}（grp ${grp.id}）`,
      meta: { requirement: grp.id, escalation_id: id },
    });
  }
  const w = ctx.waiters.get(`escalation:${id}`);
  ctx.waiters.delete(`escalation:${id}`);
  w?.(`the boss turned this into requirement ${name} (grp ${grp.id}); stop and wait for it`);
  ctx.sched.tick();
  return json({ grp_id: grp.id, name });
};

export const postRevoke: Handler = async (ctx, _req, params) => {
  const out = await revoke({ ctx }, Number(params.id));
  return json(out);
};

export const postAnswer: Handler = async (ctx, req, params) => {
  const b = await body<{ answer: string; answered_by?: string; attachments?: Attachment[] }>(req);
  const id = Number(params.id);
  const esc = ctx.db
    .query<{ grp_id: number | null; severity: string }, [number]>(
      "SELECT grp_id, severity FROM escalation WHERE id = ?",
    )
    .get(id);
  if (!esc) return text("no such escalation", 404);

  // The boss answers through the same path a stand-in would, so unblocking the
  // caller and un-pausing the group cannot drift between the two.
  const r = chainAnswer(
    { ctx },
    { escId: id, by: b.answered_by ?? "boss", answer: withAttachments(b.answer ?? "", b.attachments) },
  );
  return r.ok ? text("ok") : bad(r.error);
};

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
export const getAnswerDraft: Handler = async (ctx, _req, params) => {
  if (!ctx.askIn) return json({ text: "" });
  const id = Number(params.id);
  const e = ctx.db
    .query<{ grp_id: number | null; question: string; severity: string; asker: string | null; project_id: number | null }, [number]>(
      `SELECT e.grp_id, e.question, e.severity, a.role AS asker,
              coalesce(g.project_id, a.project_id) AS project_id
       FROM escalation e LEFT JOIN agent a ON a.id = e.agent_id
       LEFT JOIN grp g ON g.id = e.grp_id
       WHERE e.id = ? AND e.answer IS NULL`,
    )
    .get(id);
  if (!e?.project_id) return json({ text: "" });

  const grp = e.grp_id
    ? ctx.db.query<{ name: string }, [number]>("SELECT name FROM grp WHERE id = ?").get(e.grp_id)
    : null;
  // The blackboard, newest first and capped: this is the cheapest model in the
  // system and a 40k-character prompt would cost more than the answer is worth.
  const notes = e.grp_id
    ? ctx.db
        .query<{ kind: string; body: string }, [number]>(
          `SELECT kind, body FROM note
           WHERE (grp_id = ? OR (grp_id IS NULL AND kind IN ('decision','lesson','fact')))
           ORDER BY at DESC LIMIT 12`,
        )
        .all(e.grp_id)
        .map((n) => `[${n.kind}] ${n.body.slice(0, 400)}`)
    : [];
  const slices = e.grp_id
    ? ctx.db
        .query<{ seq: number; title: string; status: string }, [number]>(
          "SELECT seq, title, status FROM slice WHERE grp_id = ? ORDER BY seq",
        )
        .all(e.grp_id)
        .map((s) => `S${s.seq} ${s.status} ${s.title}`)
    : [];

  const zh = (ctx.config.language ?? "zh") !== "en";
  const prompt = [
    zh
      ? "你是老板的助手。下面是一个 agent 提给老板的问题，以及这个需求的黑板内容。写出老板可以直接发出去的答复。"
      : "You draft answers for the boss. Below is a question an agent escalated, plus this requirement's blackboard. Write the reply the boss could send as-is.",
    zh
      ? "要求：直接给结论和依据，不要开场白，不要复述问题，不超过 4 行。黑板里答得出来就直接答；答不出来就说清楚缺什么、并给出你认为最可能的决定。"
      : "Rules: conclusion and evidence, no preamble, no restating the question, at most 4 lines. Answer from the blackboard when it is there; when it is not, say what is missing and give the most likely decision.",
    ``,
    `${zh ? "需求" : "requirement"}: ${grp?.name ?? (zh ? "常驻岗" : "standing")}`,
    `${zh ? "提问的人" : "asker"}: ${e.asker ?? "?"} (${e.severity})`,
    `${zh ? "问题" : "question"}: ${e.question.slice(0, 2000)}`,
    slices.length ? `\n${zh ? "切片" : "slices"}:\n${slices.join("\n")}` : "",
    notes.length ? `\n${zh ? "黑板" : "blackboard"}:\n${notes.join("\n")}` : "",
  ].join("\n");

  try {
    const out = (await ctx.askIn({ project: e.project_id })(prompt)).trim();
    return json({ text: out.length > 1200 ? out.slice(0, 1200) : out });
  } catch {
    return json({ text: "" });
  }
};

/**
 * Hand a question back down the chain instead of answering it.
 *
 * PLAN.md §8 puts `[回答] [转 Architect]` on the same line for a reason: plenty of
 * what reaches the boss is a technical call somebody else should make, and
 * without this the only ways out are answering it or leaving it to rot.
 */
export const postDelegate: Handler = async (ctx, req, params) => {
  const b = await body<{ to?: string }>(req);
  const to = b.to ?? "architect";
  if (!CHAIN.includes(to as never) || to === "boss") {
    return bad(`to must be one of: ${CHAIN.filter((c) => c !== "boss").join(", ")}`);
  }
  const id = Number(params.id);
  const esc = ctx.db
    .query<{ grp_id: number | null; question: string }, [number]>(
      "SELECT grp_id, question FROM escalation WHERE id = ?",
    )
    .get(id);
  if (!esc) return text("no such escalation", 404);

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
  const landed = route({ ctx, notifyBoss: ctx.notifyBoss }, id);
  return text(landed);
};

