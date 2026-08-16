import { projectOfAgent } from "../../mech/util/rows.ts";
import { z } from "zod";
import { Attachment as AttachmentSchema, GroupRef, Prose } from "../valid.ts";
import { bad, resolveGroup, text, type AgentHandler, type Handler } from "../shared.ts";
import { bossFact, withAttachments } from "../panel/attach.ts";
import { triage, type Triage } from "../../mech/flow/chain.ts";
import { projectSkills, skillNames } from "../../mech/skills.ts";
import type { Ctx } from "../../ctx.ts";

/**
 * Agent to agent, and boss to anyone.
 *
 * One delivery path, two front doors. `resolveTarget` is what makes them one:
 * a role name, a group, or a channel all land as the same event, and a role
 * with nobody in it hires somebody rather than dropping the message — a mail to
 * an Architect that does not exist yet used to be a silent no-op with a sender
 * waiting for a reply that could never come.
 */

const WAKING = new Set(["ask", "request", "inform"]);

export const MailBody = z.object({
  target: z.string().min(1).max(80),
  // A closed set, and the reason it is closed: `ask` and `request` wake the
  // recipient, the other three do not. A free-text intent would be a wake-up
  // decided by spelling.
  intent: z.enum(["ask", "request", "inform", "note", "decision"], {
    error: "intent must be one of: ask, request, inform, note, decision",
  }),
  // Deliberately allows the empty string. The refusal for it is below, in the
  // handler, because the message worth sending names the caller's own `target`
  // and `intent` — and a schema cannot see a sibling field. Shape here, advice
  // there.
  body: z.string().max(8000),
  severity: z.string().max(20).optional(),
  in_reply_to: z.number().int().positive().optional(),
});

export const postMail: AgentHandler<z.infer<typeof MailBody>> = async (ctx, _req, a, _p, b) => {
  // An empty message wakes someone with nothing to answer. Measured: the
  // Dispatcher invented a `--wait` flag, the parser took it, and the mail went
  // out with no body — the Architect burned a turn on "收到的 ask 消息内容为空".
  if (!b.body.trim()) {
    return bad(
      `mail to "${b.target}" has an empty body. Put the message in quotes as the last ` +
        `argument: orch mail ${b.target} --intent ${b.intent} "…". There is no --wait flag; ` +
        `ask blocks on its own.`,
    );
  }
  // An empty message wakes someone with nothing to answer. Measured: the
  // Dispatcher invented a `--wait` flag, the parser took it, and the mail went
  // out with no body — the Architect burned a turn on "收到的 ask 消息内容为空".
  if (!b.body?.trim()) {
    return bad(
      `mail to "${b.target}" has an empty body. Put the message in quotes as the last ` +
        `argument: orch mail ${b.target} --intent ${b.intent} "…". There is no --wait flag; ` +
        `ask blocks on its own.`,
    );
  }

  // The recipient is an explicit parameter, not an `@` parsed out of prose:
  // waking someone means enqueueing an agent_turn for them, nothing more.
  let target: { agentId: number; grpId: number | null } | null = null;
  if (WAKING.has(b.intent)) {
    const senderProject = projectOfAgent(ctx.db, a.id);
    target = resolveTarget(ctx, a.grp_id, b.target, senderProject);
    if (!target) {
      const known = (ctx.knownRoles?.() ?? []).join(", ");
      // Never a silent no-op: an unreachable recipient is exactly how an agent
      // ends up asking a wall twice and then giving up.
      return bad(`no such recipient "${b.target}". Roles that exist: ${known || "none configured"}`);
    }
  }

  // A standing agent has no group of its own, so stamping the sender's group
  // would file its reply under nothing and drop it out of the group's timeline.
  // Measured: the Architect's objection to a DRAFT card landed with grp_id NULL
  // and the boss approved a card that said 反对 : 无.
  ctx.bus.emit({
    grpId: a.grp_id ?? target?.grpId ?? null,
    author: a.role,
    kind: "say",
    intent: b.intent,
    severity: b.severity ?? null,
    body: b.body,
    target: b.target,
    meta: { in_reply_to: b.in_reply_to ?? null },
  });

  if (target) {
    // The message travels with the job. A standing recipient is not in the
    // sender's channel, so relying on the unread cursor would wake it with an
    // empty prompt and it would never see the question at all.
    ctx.sched.enqueue("agent_turn", {
      grp_id: target.grpId,
      agent_id: target.agentId,
      priority: b.intent === "ask" ? 4 : 0,
      payload: {
        mail: {
          from: a.role,
          from_group: a.grp_id,
          intent: b.intent,
          body: b.body,
        },
      },
    });
  }
  ctx.sched.tick();
  return text("ok");
};

/**
 * The boss says something, and it reaches someone.
 *
 * PLAN.md §7 makes this the whole feedback loop: dissatisfaction that only gets
 * heard as "change one line" is how a wrong decomposition never gets corrected.
 * The panel had no way to say anything at all — every route into the blackboard
 * needed an agent token, so the boss could approve and reject but never explain.
 *
 * `triage` decides what the words mean: patch keeps going, respec sends the whole
 * requirement back to the Dispatcher, reject dissolves it. The CoS normally makes
 * that call; the boss saying it directly is the same call, made by the one person
 * whose opinion it is.
 */
export const SayBody = z.object({
  group_id: GroupRef.optional(),
  target: z.string().max(80).optional(),
  body: Prose(20_000),
  as: z.string().max(40).optional(),
  attachments: z.array(AttachmentSchema).max(20).optional(),
});

export const postSay: Handler<z.infer<typeof SayBody>> = async (ctx, _req, _p, b) => {
  // A screenshot is as useful when saying "这里不对" as when filing the idea.
  const said = withAttachments(b.body.trim(), b.attachments);
  const grpId = b.group_id == null ? null : resolveGroup(ctx, b.group_id);
  if (b.group_id != null && !grpId) return bad("no such requirement");

  const project = grpId
    ? ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
        ?.project_id ?? null
    : null;
  const repo = project
    ? ctx.db.query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?").get(project)
        ?.repo_path
    : null;
  // A skill the boss pointed at is inlined into that turn — for triage too,
  // since "do it this way instead" is exactly when it matters. `/name` resolves
  // against the repository's own skills as well as this machine's: they are what
  // a project ships to be used, and being unable to name one was the gap.
  const skills = skillNames(said, repo, projectSkills(ctx.db, project));

  if (b.as) {
    if (!["patch", "respec", "reject"].includes(b.as)) return bad("as must be patch, respec or reject");
    if (!grpId) return bad("triage needs a requirement");
    ctx.bus.emit({ grpId, author: "boss", kind: "boss_say", intent: "request", body: said });
    triage(
      { ctx, bossFact: (g, body) => bossFact(ctx, g, body) },
      grpId,
      b.as as Triage,
      said,
      skills,
    );
    ctx.sched.tick();
    return text("ok");
  }

  // Plain talk. The recipient defaults to the group's PM: PLAN.md §7 makes the PM
  // the group's only conversational entrance so one sentence costs one turn
  // instead of five.
  const to = b.target || "pm";
  const target = resolveTarget(ctx, grpId, to, project);
  if (!target) {
    const known = (ctx.knownRoles?.() ?? []).join(", ");
    return bad(`没有 "${to}" 这个收件人。现有角色：${known || "none configured"}`);
  }
  ctx.bus.emit({
    grpId: grpId ?? target.grpId ?? null,
    author: "boss",
    kind: "boss_say",
    intent: "request",
    body: said,
    target: to,
  });
  // Boss talk jumps the queue: the whole point of L1 intercept is that it lands on
  // the next turn rather than after everything already enqueued.
  ctx.sched.enqueue("agent_turn", {
    grp_id: target.grpId ?? grpId,
    agent_id: target.agentId,
    priority: 6,
    payload: { mail: { from: "boss", from_group: null, intent: "request", body: said }, skills },
  });
  ctx.sched.tick();
  return text("ok");
};

/**
 * Who a message is for: someone in the sender's group first, then the standing
 * holder of that role, and finally — for a role that exists in config but has no
 * agent yet — a newly hired one.
 */
function resolveTarget(
  ctx: Ctx,
  senderGrp: number | null,
  role: string,
  senderProject: number | null,
): { agentId: number; grpId: number | null } | null {
  if (senderGrp) {
    const inGroup = ctx.db
      .query<{ id: number }, [number, string]>(
        "SELECT id FROM agent WHERE grp_id = ? AND role = ? AND state != 'retired'",
      )
      .get(senderGrp, role);
    if (inGroup) return { agentId: inGroup.id, grpId: senderGrp };
  }
  // Anyone in this project with that role, group or not. A standing Architect
  // replying to `orch mail dispatcher` must reach the group's Dispatcher rather
  // than cause a second one to be hired — which is how one project ended up
  // paying for two opus Dispatchers.
  const inProject = ctx.db
    .query<{ id: number; grp_id: number | null }, [string, number | null, number | null]>(
      `SELECT id, grp_id FROM agent
       WHERE role = ? AND state != 'retired' AND (project_id IS ? OR ? IS NULL)
       ORDER BY (grp_id IS NOT NULL) DESC, id DESC LIMIT 1`,
    )
    .get(role, senderProject, senderProject);
  if (inProject) return { agentId: inProject.id, grpId: inProject.grp_id };

  if (!(ctx.knownRoles?.() ?? []).includes(role)) return null;
  const hired = ctx.hire?.(null, role, senderProject) ?? null;
  return hired === null ? null : { agentId: hired, grpId: null };
}
