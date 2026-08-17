import type { Ctx } from "../../ctx.ts";
import { say } from "../../platform/text/lang.ts";
import type { Config } from "../../platform/config/load.ts";
import { getFile, type Scope } from "../../mech/sandbox/sandbox.ts";
import { listSkills, projectSkills, readSkillIn } from "../../mech/skills.ts";
import type { Delta } from "../../prompt/assemble.ts";
import type { Job } from "../../platform/scheduling/scheduler.ts";
import { ACTIVE_JOB_STATES, type SliceState, stateParam } from "../../contracts/states.ts";

/** Exported because `applySkills` takes one and is called from tests. */
export interface TurnAgent {
  id: number;
  project_id: number | null;
  role: string;
}

type TurnJob = Job<"agent_turn">;
type TurnPayload = TurnJob["payload"];

function escalationCard(ctx: Ctx, payload: TurnPayload): string | undefined {
  if (!payload.escalation) return;
  const esc = ctx.db
    .query<{ id: number; question: string; severity: string; agent_id: number | null }, [number]>(
      "SELECT id, question, severity, agent_id FROM escalation WHERE id = ?",
    )
    .get(payload.escalation);
  if (!esc) return;
  const asker =
    esc.agent_id === null
      ? "someone"
      : (ctx.db.query<{ role: string }, [number]>("SELECT role FROM agent WHERE id = ?").get(esc.agent_id)?.role ??
        "someone");
  return (
    `${asker} is blocked and asked (severity ${esc.severity}):\n${esc.question}\n\n` +
    `Answer it with \`orch answer ${esc.id} --answer "…"\`, or pass it up with ` +
    `\`orch answer ${esc.id} --abstain --why "…"\`. Abstaining is the right move if you are ` +
    `not sure — a guess becomes a premise the whole group then reasons from.`
  );
}

function mailCard(payload: TurnPayload): string | undefined {
  const mail = payload.mail;
  if (!mail) return;
  const group = mail.from_group ? ` (group ${mail.from_group})` : "";
  const reply =
    mail.intent === "ask"
      ? `Reply with \`orch mail ${mail.from} --intent inform "…"\`. If it needs a decision above your level, pass it up.`
      : "";
  return `${mail.from}${group} sent you a "${mail.intent}":\n${mail.body}\n\n${reply}`;
}

function boundaryCard(payload: TurnPayload): string | undefined {
  if (payload.boundary === undefined) return;
  const groups = Array.isArray(payload.boundary)
    ? payload.boundary
    : [{ id: payload.boundary, name: String(payload.boundary), idea: undefined }];
  const requirements = groups
    .map(
      (group) =>
        `${group.name} (group ${group.id}) wants: ${group.idea || "(no requirement recorded)"}\n` +
        `  orch owns ${group.id} --path "<glob>" --path "<glob>"`,
    )
    .join("\n\n");
  return (
    `This project now has more than one live group, so every one of them needs a path ` +
    `boundary before work is planned inside it. Cut all of them now — each group's own ` +
    `requirement is quoted so you can tell them apart:\n\n${requirements}` +
    `\n\nGive each group the paths ITS OWN requirement needs — a group told to add a new ` +
    `file needs a directory or a glob, not a list of files that already exist. Overlapping ` +
    `groups cannot run in parallel, so make them disjoint. Shared files (manifests, ` +
    `lockfiles, schemas, CI config) belong to no group — leave them out.`
  );
}

function auditCard(payload: TurnPayload): string | undefined {
  const groupId = payload.audit;
  if (!groupId) return;
  const branch = payload.audit_branch
    ? `Its branch is ${payload.audit_branch}; you are in the main checkout, so read it with ` +
      `\`git diff main...${payload.audit_branch}\` and \`git log main..${payload.audit_branch}\`.\n`
    : "";
  return (
    `Audit group ${payload.audit_group ?? groupId} (group_id ${groupId}) before the boss merges it.\n${branch}` +
    `Coverage against the DRAFT card, architectural consistency, and whether the journals ` +
    `describe what the diff does. Do NOT re-check what the gate covered.\n\n` +
    `File your verdict with exactly:\n` +
    `  orch audit ${groupId} --verdict pass|fail --note "what is missing or inconsistent"`
  );
}

function scribeCard(ctx: Ctx, payload: TurnPayload): string | undefined {
  const groupId = payload.scribe;
  if (!groupId) return;
  const base = ctx.db
    .query<{ base_branch: string | null }, [number]>(
      "SELECT p.base_branch FROM grp g JOIN project p ON p.id = g.project_id WHERE g.id = ?",
    )
    .get(groupId)?.base_branch;
  const ref = `origin/${base ?? "main"}`;
  return (
    `This branch passed its audit and is about to be published. Write what it says in a log.\n\n` +
    `Read it first — you are in the group's own checkout:\n` +
    `  git diff ${ref}...HEAD\n` +
    `  git log --format='%s' ${ref}..HEAD\n` +
    `Then \`orch ctx query\` for the card it was meant to deliver.\n\n` +
    `File it with exactly this, the body on stdin:\n` +
    `  orch pr ${groupId} --title "<type(scope): subject>" -\n\n` +
    `Nothing is published until that lands, and it is refused with a reason if the ` +
    `subject has no type prefix, runs past 72 characters, ends in a full stop, or ` +
    `either half is not English. A refusal is not the end of your turn — fix it and send it again.`
  );
}

function digestCard(ctx: Ctx, payload: TurnPayload): string | undefined {
  const digest = payload.digest;
  if (!digest) return;
  const rows = ctx.db
    .query<{ seq: number; author: string; body: string }, [number, number, number]>(
      `SELECT seq, author, body FROM event
       WHERE channel_id = ? AND seq > ? AND seq <= ? AND kind IN ('say','boss_say','note','escalation')
       ORDER BY seq LIMIT 400`,
    )
    .all(digest.channel_id, digest.from, digest.to);
  const events = rows
    .map((row) => `[${row.seq}] ${row.author}: ${row.body}`)
    .join("\n")
    .slice(0, 20_000);
  return (
    `Compress this channel backlog so nobody has to read it again. ${rows.length} events, ` +
    `seq ${digest.from}..${digest.to}.\n\n` +
    `File ONE note: \`orch journal add --kind journal -\`, at most 6 lines, covering what was ` +
    `decided, what is still open, and anything a later turn must not re-litigate. Names and ` +
    `file paths verbatim; drop the pleasantries.\n\n${events}`
  );
}

function sedimentCard(payload: TurnPayload): string | undefined {
  const sediment = payload.sediment;
  if (!sediment) return;
  return (
    `The boss has said the same thing ${sediment.length} times now, to different groups. ` +
    `A fact attached to one group is invisible to the next, so this has to become a project rule.\n\n` +
    sediment.map((text, index) => `${index + 1}. ${text}`).join("\n") +
    `\n\nWrite ONE rule with \`orch journal add --kind lesson -\` — at most 6 lines, phrased as an ` +
    `instruction a later group can follow without knowing this history ("QA 必须…", not "老板不满意…"). ` +
    `If these are not actually the same complaint, say so with \`orch mail cos --intent note\` and write nothing.`
  );
}

function applyPayloadCards(ctx: Ctx, payload: TurnPayload, delta: Delta): void {
  for (const card of [
    escalationCard(ctx, payload),
    mailCard(payload),
    boundaryCard(payload),
    auditCard(payload),
    scribeCard(ctx, payload),
    digestCard(ctx, payload),
    sedimentCard(payload),
    payload.idea ? `The boss wants: ${payload.idea}` : undefined,
  ]) {
    if (card !== undefined) delta.card = card;
  }
  if (payload.respec) delta.rejection = `The boss sent the DRAFT back: ${payload.respec}`;
  if (payload.rejection) delta.rejection = payload.rejection;
}

function applyWorkCard(ctx: Ctx, agent: TurnAgent, job: TurnJob, delta: Delta): void {
  if (job.slice_id) return applySliceCard(ctx, agent, job.slice_id, delta);
  if (!job.grp_id || job.payload.idea) return;
  const slices = ctx.db
    .query<{ seq: number; title: string; status: SliceState; difficulty: string }, [number]>(
      "SELECT seq, title, status, difficulty FROM slice WHERE grp_id = ? ORDER BY seq",
    )
    .all(job.grp_id);
  if (slices.length) {
    delta.card = slices
      .map((slice) => `S${slice.seq} [${slice.difficulty}] ${slice.title} — ${slice.status}`)
      .join("\n");
  }
}

function applySliceCard(ctx: Ctx, agent: TurnAgent, sliceId: number, delta: Delta): void {
  const slice = ctx.db
    .query<{ seq: number; title: string; accept_spec: string; difficulty: string }, [number]>(
      "SELECT seq, title, accept_spec, difficulty FROM slice WHERE id = ?",
    )
    .get(sliceId);
  if (!slice) return;
  delta.card = `Slice S${slice.seq} (slice_id ${sliceId}) [${slice.difficulty}]: ${slice.title}\nAccepted when: ${slice.accept_spec}`;
  if (agent.role === "qa") {
    delta.card += `\n\nFile your verdict with exactly:\n  orch review ${sliceId} --verdict pass|fail --note "one line per criterion"`;
  }
}

function applyHandoff(ctx: Ctx, groupId: number | null, rotated: boolean, delta: Delta): void {
  if (!rotated) return;
  const handoff = ctx.db
    .query<{ body: string }, [number | null]>(
      "SELECT body FROM note WHERE grp_id IS ? AND kind = 'handoff' ORDER BY at DESC LIMIT 1",
    )
    .get(groupId);
  delta.handoff =
    (handoff?.body ? `${handoff.body}\n\n` : "") +
    "This is a fresh session. Use `orch ctx query` for anything you are missing rather than assuming you remember it.";
}

/**
 * The skill text a turn is given.
 *
 * Takes the two fields it reads rather than the whole job: the names travel on
 * the payload and the bodies are read from inside the container at turn time, so
 * a test of this has no business constructing a scheduler row.
 */
export async function applySkills(
  ctx: Ctx,
  agent: TurnAgent,
  job: { grp_id: number | null; payload: { skills?: string[] | undefined } },
  scope: Scope,
  delta: Delta,
): Promise<void> {
  const wanted = job.payload.skills ?? [];
  if (!wanted.length) return;
  const row = ctx.db
    .query<{ repo_path: string; project_id: number }, [number | null]>(
      "SELECT p.repo_path, p.id AS project_id FROM project p JOIN grp g ON g.project_id = p.id WHERE g.id = ?",
    )
    .get(job.grp_id ?? null);
  const projectId = row?.project_id ?? agent.project_id ?? null;
  const all = listSkills(row?.repo_path, projectSkills(ctx.db, projectId));
  const found = wanted.map((name) => all.find((skill) => skill.name === name)).filter((skill) => skill !== undefined);
  if (!found.length) return;
  delta.skills = (
    await Promise.all(found.map((skill) => readSkillIn((path) => getFile(ctx, scope, path), skill)))
  ).join("\n\n");
}

interface UnreadRow {
  seq: number;
  author: string;
  intent: string | null;
  body: string;
}

function digestBacklog(ctx: Ctx, channelId: number, groupId: number, rows: UnreadRow[], limit: number): string {
  if (rows.length < limit) return "";
  const last = rows.at(-1)!;
  const behind = ctx.db
    .query<{ c: number; hi: number }, [number, number]>(
      `SELECT count(*) AS c, max(seq) AS hi FROM event
       WHERE channel_id = ? AND seq > ? AND kind IN ('say', 'boss_say', 'note', 'escalation')`,
    )
    .get(channelId, last.seq)!;
  if (behind.c === 0) return "";
  enqueueDigestOnce(ctx, channelId, groupId, last.seq, behind.hi);
  ctx.bus.emit({
    grpId: groupId,
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config.language, "unread.digest", { n: behind.c }),
    meta: { channel_id: channelId, behind: behind.c },
  });
  return `\n\n(${behind.c} 条更早的还没读，Librarian 正在压成一条摘要，别自己去翻)`;
}

function enqueueDigestOnce(ctx: Ctx, channelId: number, groupId: number, from: number, to: number): void {
  const queued = ctx.db
    .query<{ c: number }, [string, number]>(
      `SELECT count(*) AS c FROM job WHERE kind = 'agent_turn'
       AND state IN (SELECT value FROM json_each(?))
       AND json_extract(payload_json, '$.digest.channel_id') = ?`,
    )
    .get(stateParam(ACTIVE_JOB_STATES), channelId)!.c;
  if (queued !== 0) return;
  ctx.sched.enqueue("agent_turn", {
    grp_id: groupId,
    priority: 2,
    payload: { role: "librarian", digest: { channel_id: channelId, from, to } },
  });
}

function readUnread(ctx: Ctx, agent: TurnAgent, groupId: number | null, cfg: Config): string | undefined {
  if (!groupId) return;
  const channel = ctx.db
    .query<{ id: number }, [number]>("SELECT id FROM channel WHERE grp_id = ? LIMIT 1")
    .get(groupId);
  if (!channel) return;
  const cursor =
    ctx.db
      .query<{ last_seq: number }, [number, number]>(
        "SELECT last_seq FROM cursor WHERE agent_id = ? AND channel_id = ?",
      )
      .get(agent.id, channel.id)?.last_seq ?? 0;
  const limit = cfg.unreadDigestThreshold ?? 30;
  const rows = ctx.db
    .query<UnreadRow, [number, number, number]>(
      `SELECT seq, author, intent, body FROM event
       WHERE channel_id = ? AND seq > ? AND kind IN ('say', 'boss_say', 'note', 'escalation')
       ORDER BY seq LIMIT ?`,
    )
    .all(channel.id, cursor, limit);
  if (!rows.length) return;
  const tail = digestBacklog(ctx, channel.id, groupId, rows, limit);
  ctx.db.run(
    `INSERT INTO cursor (agent_id, channel_id, last_seq) VALUES (?, ?, ?)
     ON CONFLICT (agent_id, channel_id) DO UPDATE SET last_seq = excluded.last_seq`,
    [agent.id, channel.id, rows.at(-1)!.seq],
  );
  return rows.map((row) => `${row.author}${row.intent ? ` (${row.intent})` : ""}: ${row.body}`).join("\n") + tail;
}

/** Build only the per-turn delta; stable prompt material is owned elsewhere. */
export async function buildTurnDelta(
  deps: { ctx: Ctx; cfg: Config },
  agent: { id: number; project_id: number | null; role: string },
  job: Job<"agent_turn">,
  rotated: boolean,
  scope: Scope,
): Promise<Delta> {
  const delta: Delta = {};
  applyPayloadCards(deps.ctx, job.payload, delta);
  applyWorkCard(deps.ctx, agent, job, delta);
  applyHandoff(deps.ctx, job.grp_id, rotated, delta);
  const unread = readUnread(deps.ctx, agent, job.grp_id, deps.cfg);
  await applySkills(deps.ctx, agent, job, scope, delta);
  if (unread) delta.unread = unread;
  return delta;
}
