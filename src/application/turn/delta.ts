import { and, asc, count, desc, eq, gt, inArray, isNull, lte, max, sql } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import {
  agent,
  channel as channels,
  cursor as cursors,
  escalation,
  event as events,
  grp,
  job as jobs,
  note as notes,
  project,
  slice as slices,
} from "../../platform/persistence/schema.ts";
import { roleFor, type Ctx } from "../../mech/ctx.ts";
import { say } from "../../platform/text/lang.ts";
import type { Config } from "../../platform/config/load.ts";
import { getFile, type Scope } from "../../mech/sandbox/sandbox.ts";
import { listSkills, projectSkills, readSkillIn } from "../../mech/skills.ts";
import type { Delta } from "../../prompt/assemble.ts";
import type { Job } from "../../platform/scheduling/scheduler.ts";
import { ACTIVE_JOB_STATES } from "../../contracts/states.ts";

/** What counts as backlog worth reading or compressing. One list, three readers. */
const READABLE_KINDS = ["say", "boss_say", "note", "escalation"] as const;

/** Exported because `applySkills` takes one and is called from tests. */
export interface TurnAgent {
  id: number;
  project_id: number | null;
  role: string;
}

type TurnJob = Job<"agent_turn">;
type TurnPayload = TurnJob["payload"];

async function escalationCard(db: DB, payload: TurnPayload): Promise<string | undefined> {
  if (!payload.escalation) return;
  const [esc] = await db
    .select({
      id: escalation.id,
      question: escalation.question,
      severity: escalation.severity,
      agent_id: escalation.agent_id,
    })
    .from(escalation)
    .where(eq(escalation.id, payload.escalation));
  if (!esc) return;
  const asker =
    esc.agent_id === null
      ? "someone"
      : ((await db.select({ role: agent.role }).from(agent).where(eq(agent.id, esc.agent_id)))[0]?.role ?? "someone");
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

async function scribeCard(ctx: Ctx, payload: TurnPayload): Promise<string | undefined> {
  const groupId = payload.scribe;
  if (!groupId) return;
  const [row] = await ctx.db
    .select({ base_branch: project.base_branch })
    .from(grp)
    .innerJoin(project, eq(project.id, grp.project_id))
    .where(eq(grp.id, groupId));
  const base = row?.base_branch;
  // The project's own base, then the configured fallback. `main` was written here,
  // so a project that develops on `develop` was told to diff against a branch its
  // repository does not have.
  const ref = `origin/${base ?? ctx.config.baseBranchFallbacks[0] ?? "main"}`;
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

async function digestCard(db: DB, payload: TurnPayload): Promise<string | undefined> {
  const digest = payload.digest;
  if (!digest) return;
  const rows = await db
    .select({ seq: events.seq, author: events.author, body: events.body })
    .from(events)
    .where(
      and(
        eq(events.channel_id, digest.channel_id),
        gt(events.seq, digest.from),
        lte(events.seq, digest.to),
        inArray(events.kind, [...READABLE_KINDS]),
      ),
    )
    .orderBy(asc(events.seq))
    .limit(400);
  const transcript = rows
    .map((row) => `[${row.seq}] ${row.author}: ${row.body}`)
    .join("\n")
    .slice(0, 20_000);
  return (
    `Compress this channel backlog so nobody has to read it again. ${rows.length} events, ` +
    `seq ${digest.from}..${digest.to}.\n\n` +
    `File ONE note: \`orch journal add --kind journal -\`, at most 6 lines, covering what was ` +
    `decided, what is still open, and anything a later turn must not re-litigate. Names and ` +
    `file paths verbatim; drop the pleasantries.\n\n${transcript}`
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

async function applyPayloadCards(ctx: Ctx, payload: TurnPayload, delta: Delta): Promise<void> {
  for (const card of [
    await escalationCard(ctx.db, payload),
    mailCard(payload),
    boundaryCard(payload),
    auditCard(payload),
    await scribeCard(ctx, payload),
    await digestCard(ctx.db, payload),
    sedimentCard(payload),
    payload.idea ? `The boss wants: ${payload.idea}` : undefined,
  ]) {
    if (card !== undefined) delta.card = card;
  }
  if (payload.respec) delta.rejection = `The boss sent the DRAFT back: ${payload.respec}`;
  if (payload.rejection) delta.rejection = payload.rejection;
}

async function applyWorkCard(ctx: Ctx, agent: TurnAgent, job: TurnJob, delta: Delta): Promise<void> {
  if (job.slice_id) return await applySliceCard(ctx, agent, job.slice_id, delta);
  if (!job.grp_id || job.payload.idea) return;
  // The slice list is the fallback for a turn with no stated reason. A payload
  // card is that reason — a lease result, a digest, a scribe brief — and none of
  // them has another way into the prompt.
  if (delta.card) return;
  const rows = await ctx.db
    .select({ seq: slices.seq, title: slices.title, status: slices.status, difficulty: slices.difficulty })
    .from(slices)
    .where(eq(slices.grp_id, job.grp_id))
    .orderBy(asc(slices.seq));
  if (rows.length) {
    delta.card = rows.map((slice) => `S${slice.seq} [${slice.difficulty}] ${slice.title} — ${slice.status}`).join("\n");
  }
}

async function applySliceCard(ctx: Ctx, agent: TurnAgent, sliceId: number, delta: Delta): Promise<void> {
  const [slice] = await ctx.db
    .select({
      seq: slices.seq,
      title: slices.title,
      accept_spec: slices.accept_spec,
      difficulty: slices.difficulty,
    })
    .from(slices)
    .where(eq(slices.id, sliceId));
  if (!slice) return;
  delta.card = `Slice S${slice.seq} (slice_id ${sliceId}) [${slice.difficulty}]: ${slice.title}\nAccepted when: ${slice.accept_spec}`;
  if (agent.role === roleFor(ctx, "review_slice")) {
    delta.card += `\n\nFile your verdict with exactly:\n  orch review ${sliceId} --verdict pass|fail --note "one line per criterion"`;
  }
}

async function applyHandoff(ctx: Ctx, groupId: number | null, rotated: boolean, delta: Delta): Promise<void> {
  if (!rotated) return;
  // `IS ?` matched a NULL group; `eq` never does, and a group-less agent would
  // silently get no handoff at all.
  const [handoff] = await ctx.db
    .select({ body: notes.body })
    .from(notes)
    .where(and(groupId === null ? isNull(notes.grp_id) : eq(notes.grp_id, groupId), eq(notes.kind, "handoff")))
    .orderBy(desc(notes.at), desc(notes.id))
    .limit(1);
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
  const [row] = job.grp_id
    ? await ctx.db
        .select({ repo_path: project.repo_path, project_id: project.id })
        .from(project)
        .innerJoin(grp, eq(grp.project_id, project.id))
        .where(eq(grp.id, job.grp_id))
    : [];
  const projectId = row?.project_id ?? agent.project_id ?? null;
  const all = listSkills(row?.repo_path, await projectSkills(ctx.db, projectId));
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

async function digestBacklog(
  ctx: Ctx,
  channelId: number,
  groupId: number,
  rows: UnreadRow[],
  limit: number,
): Promise<string> {
  if (rows.length < limit) return "";
  const last = rows.at(-1)!;
  const [behind] = await ctx.db
    .select({ c: count(), hi: max(events.seq) })
    .from(events)
    .where(and(eq(events.channel_id, channelId), gt(events.seq, last.seq), inArray(events.kind, [...READABLE_KINDS])));
  if (!behind || behind.c === 0 || behind.hi === null) return "";
  await enqueueDigestOnce(ctx, channelId, groupId, last.seq, behind.hi);
  await ctx.bus.emit({
    grpId: groupId,
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config.language, "unread.digest", { n: behind.c }),
    meta: { channel_id: channelId, behind: behind.c },
  });
  return `\n\n(${behind.c} 条更早的还没读，Librarian 正在压成一条摘要，别自己去翻)`;
}

async function enqueueDigestOnce(
  ctx: Ctx,
  channelId: number,
  groupId: number,
  from: number,
  to: number,
): Promise<void> {
  // The one query Drizzle has no builder for: reaching into `payload_json` for the
  // channel a queued digest already covers. `#>>` yields text, so the comparison is
  // against the id as text — `=` on a jsonb value and an integer finds nothing.
  const [queued] = await ctx.db
    .select({ c: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, "agent_turn"),
        inArray(jobs.state, [...ACTIVE_JOB_STATES]),
        sql`${jobs.payload_json} #>> '{digest,channel_id}' = ${String(channelId)}`,
      ),
    );
  if (!queued || queued.c !== 0) return;
  await ctx.sched.enqueue("agent_turn", {
    grp_id: groupId,
    priority: 2,
    payload: { role: roleFor(ctx, "compress_context"), digest: { channel_id: channelId, from, to } },
  });
}

async function readUnread(
  ctx: Ctx,
  agent: TurnAgent,
  groupId: number | null,
  cfg: Config,
): Promise<string | undefined> {
  if (!groupId) return;
  const [channel] = await ctx.db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.grp_id, groupId))
    .limit(1);
  if (!channel) return;
  const channelId = channel.id;
  const [seen] = await ctx.db
    .select({ last_seq: cursors.last_seq })
    .from(cursors)
    .where(and(eq(cursors.agent_id, agent.id), eq(cursors.channel_id, channelId)));
  const limit = cfg.unreadDigestThreshold ?? 30;
  const rows = await ctx.db
    .select({ seq: events.seq, author: events.author, intent: events.intent, body: events.body })
    .from(events)
    .where(
      and(
        eq(events.channel_id, channelId),
        gt(events.seq, seen?.last_seq ?? 0),
        inArray(events.kind, [...READABLE_KINDS]),
      ),
    )
    .orderBy(asc(events.seq))
    .limit(limit);
  if (!rows.length) return;
  const tail = await digestBacklog(ctx, channelId, groupId, rows, limit);
  const last_seq = rows.at(-1)!.seq;
  await ctx.db
    .insert(cursors)
    .values({ agent_id: agent.id, channel_id: channelId, last_seq })
    .onConflictDoUpdate({ target: [cursors.agent_id, cursors.channel_id], set: { last_seq } });
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
  await applyPayloadCards(deps.ctx, job.payload, delta);
  await applyWorkCard(deps.ctx, agent, job, delta);
  await applyHandoff(deps.ctx, job.grp_id, rotated, delta);
  const unread = await readUnread(deps.ctx, agent, job.grp_id, deps.cfg);
  await applySkills(deps.ctx, agent, job, scope, delta);
  if (unread) delta.unread = unread;
  return delta;
}
