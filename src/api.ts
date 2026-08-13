import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import type { DB } from "./db.ts";
import type { Bus } from "./bus.ts";
import type { Scheduler } from "./scheduler.ts";
import type { RepoLock } from "./mech/gitlock.ts";
import { resolveLease, type ResourceDef } from "./mech/lease.ts";
import { createWorktree, type GitRunner } from "./mech/worktree.ts";
import { interrupt, park, pause, resume, unpark } from "./mech/intercept.ts";
import { abstain, answer as chainAnswer, CHAIN, entryPoint, revoke, route, triage, type Triage } from "./mech/chain.ts";
import { canStart, parseOwns } from "./mech/ownership.ts";
import { acceptSlice, startNextSlice } from "./mech/review.ts";
import { head, joinQueue, landed, position } from "./mech/mergequeue.ts";
import { costReport } from "./mech/cost.ts";
import { detectGates, detectShared } from "./mech/detect.ts";
import { preflightPr } from "./mech/prwatch.ts";
import { query as ctxQuery, DEFAULT_BUDGET } from "./mech/ctx.ts";
import { gatesFor, recordGate } from "./mech/gate.ts";
import { listSkills, skillNames } from "./mech/skills.ts";
import { say } from "./lang.ts";
import { validateDraftCard, validateJournal, validateSelfReview } from "./mech/validate.ts";

/**
 * One API, two clients: the web UI (the boss's main surface) and `orch` (what
 * agents call over Bash). Anything the web can do has an `orch` verb and vice
 * versa — there is deliberately no second implementation anywhere.
 */

export interface Ctx {
  db: DB;
  bus: Bus;
  sched: Scheduler;
  gitLock: RepoLock;
  /** Resolves a blocking `ask-boss` / `lease` call. Keyed by "kind:id". */
  waiters: Map<string, (value: string) => void>;
  /** Runs git under the repo write lock. Absent in unit tests that need no repo. */
  git?: GitRunner;
  /** Runs `gh`. Absent in unit tests that need no GitHub. */
  gh?: (argv: string[], cwd: string) => Promise<{ code: number; out: string }>;
  /** Wired by the server: advances the review pipeline on a QA verdict. */
  reviewVerdict?: (sliceId: number, pass: boolean, note: string) => void;
  /** Wired by the server: the Auditor's PR-level verdict. */
  auditVerdict?: (grpId: number, pass: boolean, note: string) => void;
  /** Wired by the server: a watchdog finding worth telling the boss about. */
  onFinding?: (rule: string, severity: string, body: string, grpId: number | null) => void;
  /** Wired by the server: a question that reached the top of the answer chain. */
  notifyBoss?: (escId: number, question: string, severity: string) => void;
  /**
   * Wired by the server: hire an agent for a role that has none yet.
   *
   * Standing roles are event-triggered, and the first message addressed to one IS
   * the event — otherwise mailing the Architect before an Architect exists is a
   * silent no-op, and the sender waits on a reply that can never come.
   */
  hire?: (grpId: number | null, role: string, projectId?: number | null) => number | null;
  /** Wired by the server: role names that exist in roles/*.yaml. */
  knownRoles?: () => string[];
  config: {
    language: string;
    difficultyModel: Record<string, string>;
    workRoot: string;
    dataDir?: string;
    autoAdvance?: boolean;
    autoAcceptTiers?: string[];
    /** Surfaced to the panel: how many groups may run at once, and lease slots. */
    maxGroups?: number;
    leaseSlots?: number;
  };
}

type Handler = (ctx: Ctx, req: Request, params: Record<string, string>) => Promise<Response>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const text = (s: string, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const bad = (msg: string) => text(msg, 422);

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export interface Caller {
  id: number;
  grp_id: number | null;
  role: string;
}

/**
 * Who is calling.
 *
 * The token comes from the environment the spawner injected, never from the
 * request body — the server listens on localhost TCP, so anything else on
 * 127.0.0.1 could otherwise claim to be any agent by sending an id.
 */
export function agentOf(ctx: Ctx, req: Request): Caller | null {
  const token = req.headers.get("x-orch-token");
  if (!token) return null;
  return (
    ctx.db
      .query<Caller, [string]>("SELECT id, grp_id, role FROM agent WHERE token = ?")
      .get(token) ?? null
  );
}

/** A fresh token for a newly hired agent. */
/** What the boss first asked for, for this group. */
function firstIdea(ctx: Ctx, grpId: number): string {
  return (
    ctx.db
      .query<{ body: string }, [number]>(
        "SELECT body FROM event WHERE grp_id = ? AND kind = 'boss_say' ORDER BY seq LIMIT 1",
      )
      .get(grpId)?.body ?? ""
  );
}

export function mintToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * A group, by id or by name.
 *
 * Agents reach for the name they can see — one was observed running
 * `orch draft greet -` — and refusing that teaches nothing. Accepting both costs
 * one query and removes a whole class of confusion.
 */
export function resolveGroup(ctx: Ctx, ref: unknown, fallbackGrp?: number | null): number | null {
  if (typeof ref === "number" && Number.isInteger(ref)) return ref;
  if (typeof ref === "string" && ref.trim()) {
    const n = Number(ref);
    if (Number.isInteger(n)) return n;
    const row = ctx.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM grp WHERE name = ? AND status != 'DISSOLVED' ORDER BY id DESC LIMIT 1",
      )
      .get(ref.trim());
    if (row) return row.id;
  }
  return fallbackGrp ?? null;
}

// ---------------------------------------------------------------- agent verbs

const postStatus: Handler = async (ctx, req) => {
  const b = await body<{ text: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  ctx.db.run("UPDATE agent SET activity = ? WHERE id = ?", [b.text ?? "", a.id]);
  ctx.bus.live({ grpId: a.grp_id, agentId: a.id, role: a.role, kind: "status", body: b.text ?? "" });
  return text("ok");
};

const postJournal: Handler = async (ctx, req) => {
  const b = await body<{ kind: string; body: string; files?: string[]; slice_id?: number }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");

  const v = validateJournal({ kind: b.kind, body: b.body, files: b.files });
  if (!v.ok) return bad(v.error);

  const grp = a.grp_id
    ? ctx.db
        .query<{ name: string; project_id: number; worktree: string | null }, [number]>(
          "SELECT name, project_id, worktree FROM grp WHERE id = ?",
        )
        .get(a.grp_id)
    : null;

  const frontmatter = {
    group: grp?.name ?? null,
    role: a.role,
    slice: b.slice_id ?? null,
    kind: v.kind,
    files: b.files ?? [],
  };

  // journal/retro live in the repo so they merge with the PR and the next group
  // can grep them; the rest stay on the blackboard only.
  let exportPath: string | null = null;
  if ((v.kind === "journal" || v.kind === "retro" || v.kind === "decision") && grp?.worktree) {
    const seq = ctx.db
      .query<{ c: number }, [number]>("SELECT count(*) AS c FROM note WHERE grp_id = ?")
      .get(a.grp_id!)!.c;
    exportPath = join("docs", "journal", grp.name, `${String(seq + 1).padStart(3, "0")}-${v.kind}.md`);
    const abs = join(grp.worktree, exportPath);
    const fm = Object.entries(frontmatter)
      .map(([k, val]) => `${k}: ${Array.isArray(val) ? `[${val.join(", ")}]` : val}`)
      .join("\n");
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `---\n${fm}\n---\n${v.body}\n`, "utf8");
  }

  ctx.db.run(
    `INSERT INTO note (project_id, grp_id, slice_id, kind, lang, body, frontmatter_json, export_path, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      grp?.project_id ?? null,
      a.grp_id,
      b.slice_id ?? null,
      v.kind,
      ctx.config.language,
      v.body,
      JSON.stringify(frontmatter),
      exportPath,
      Date.now(),
    ],
  );
  // The lessons list is capped where it is written, not where it is read: an
  // ever-growing list becomes the very context cost it exists to prevent.
  if (v.kind === "lesson") evictOldestLessons(ctx, grp?.project_id ?? null);

  // A retro is what PR-level review was waiting for. Without this the flow
  // dead-ends: the PM writes the retro nobody asked for again, and the branch sits
  // finished and unreviewed until someone nudges it by hand.
  if (v.kind === "retro" && a.grp_id) {
    const open = ctx.db
      .query<{ c: number }, [number]>(
        "SELECT count(*) AS c FROM slice WHERE grp_id = ? AND status != 'accepted'",
      )
      .get(a.grp_id)!.c;
    if (open === 0) {
      ctx.sched.enqueue("reconcile", { grp_id: a.grp_id, priority: 5 });
      ctx.sched.tick();
    }
  }

  ctx.bus.emit({
    grpId: a.grp_id,
    author: a.role,
    kind: "note",
    intent: v.kind === "decision" ? "decision" : "note",
    body: v.body,
    meta: { kind: v.kind, exportPath },
  });
  return text(exportPath ? `ok ${exportPath}` : "ok");
};

export const LESSON_CAP = 20;

/** Keep only the newest LESSON_CAP lessons for a project. */
export function evictOldestLessons(ctx: Ctx, projectId: number | null): number {
  const r = ctx.db.run(
    `DELETE FROM note WHERE kind = 'lesson' AND (project_id IS ? OR (? IS NULL AND project_id IS NULL))
       AND id NOT IN (
         SELECT id FROM note WHERE kind = 'lesson' AND (project_id IS ? OR (? IS NULL AND project_id IS NULL))
         ORDER BY at DESC, id DESC LIMIT ?
       )`,
    [projectId, projectId, projectId, projectId, LESSON_CAP],
  );
  return r.changes;
}

const WAKING = new Set(["ask", "request", "inform"]);

const postMail: Handler = async (ctx, req) => {
  const b = await body<{
    target: string;
    intent: string;
    body: string;
    severity?: string;
    in_reply_to?: number;
  }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (!["ask", "request", "inform", "note", "decision"].includes(b.intent)) {
    return bad("intent must be one of: ask, request, inform, note, decision");
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
    const senderProject = ctx.db
      .query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?")
      .get(a.id)?.project_id ?? null;
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
const postSay: Handler = async (ctx, req) => {
  const b = await body<{
    group_id?: number | string; target?: string; body: string; as?: string; attachments?: Attachment[];
  }>(req);
  if (!b.body?.trim()) return bad("nothing to send");
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
  // A skill the boss pointed at is read on the host and inlined into that turn — for
  // triage too, since "do it this way instead" is exactly when it matters.
  const skills = skillNames(said, repo);

  if (b.as) {
    if (!["patch", "respec", "reject"].includes(b.as)) return bad("as must be patch, respec or reject");
    if (!grpId) return bad("triage needs a requirement");
    ctx.bus.emit({ grpId, author: "boss", kind: "boss_say", intent: "request", body: said });
    triage({ ctx, git: ctx.git }, grpId, b.as as Triage, said, skills);
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
    .query<{ id: number; grp_id: number | null }, [string, number | null]>(
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

const postAskBoss: Handler = async (ctx, req) => {
  const b = await body<{ severity?: string; question: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  const severity = b.severity === "blocker" ? "blocker" : "advisory";

  const row = ctx.db
    .query<{ id: number }, [number | null, number, string, string]>(
      `INSERT INTO escalation (grp_id, agent_id, severity, question, created_at)
       VALUES (?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    )
    .get(a.grp_id, a.id, severity, b.question)!;

  // The commit the question was asked at, so a stand-in's answer can be undone.
  if (ctx.git && a.grp_id) {
    const grp = ctx.db
      .query<{ worktree: string | null; project_id: number }, [number]>(
        "SELECT worktree, project_id FROM grp WHERE id = ?",
      )
      .get(a.grp_id);
    const repo = grp
      ? ctx.db.query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?").get(grp.project_id)
          ?.repo_path
      : undefined;
    if (repo && grp?.worktree) {
      const head = await ctx.git(repo, ["rev-parse", "HEAD"], grp.worktree);
      if (head.code === 0) {
        ctx.db.run("UPDATE escalation SET checkpoint_sha = ? WHERE id = ?", [head.out.trim(), row.id]);
      }
    }
  }
  ctx.db.run("UPDATE escalation SET chain_state = ? WHERE id = ?", [entryPoint(b.question), row.id]);

  ctx.db.run("UPDATE agent SET state = 'blocked' WHERE id = ?", [a.id]);
  // A blocker is the one intent that stops the whole group: the answer changes
  // the premise everyone else is reasoning from.
  if (severity === "blocker" && a.grp_id) {
    ctx.db.run("UPDATE grp SET status = 'PAUSING' WHERE id = ? AND status = 'RUNNING'", [a.grp_id]);
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

  route({ ctx, git: ctx.git, notifyBoss: ctx.notifyBoss }, row.id);

  const answer = await new Promise<string>((resolve) => {
    ctx.waiters.set(`escalation:${row.id}`, resolve);
  });
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ?", [a.id]);
  return text(answer);
};

const postLease: Handler = async (ctx, req) => {
  const b = await body<{ resource: string; args?: Record<string, unknown> }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");

  const def = loadResource(ctx, b.resource);
  if (!def) return bad(`unknown resource ${b.resource}. Ask the boss to add a template.`);

  const r = resolveLease(def, b.args ?? {});
  if (!r.ok) return bad(r.error);

  const row = ctx.db
    .query<{ id: number }, [string, number | null, number, string, string]>(
      `INSERT INTO lease (resource, grp_id, agent_id, args_json, resolved_cmd, enqueued_at)
       VALUES (?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    )
    .get(b.resource, a.grp_id, a.id, JSON.stringify(b.args ?? {}), r.argv.join(" "))!;

  ctx.db.run("UPDATE agent SET state = 'waiting_lease' WHERE id = ?", [a.id]);
  ctx.sched.enqueue("lease", { grp_id: a.grp_id, agent_id: a.id, payload: { lease_id: row.id } });
  ctx.sched.tick();

  const digest = await new Promise<string>((resolve) => {
    ctx.waiters.set(`lease:${row.id}`, resolve);
  });
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ?", [a.id]);
  return text(digest);
};

const getLeaseLog: Handler = async (ctx, req, params) => {
  const row = ctx.db
    .query<{ log_path: string | null }, [number]>("SELECT log_path FROM lease WHERE id = ?")
    .get(Number(params.id));
  if (!row?.log_path) return text("no log", 404);
  const raw = await Bun.file(row.log_path).text();
  const grep = new URL(req.url).searchParams.get("grep");
  if (!grep) return text(raw.split("\n").slice(-200).join("\n"));
  const re = new RegExp(grep);
  return text(
    raw
      .split("\n")
      .filter((l) => re.test(l))
      .slice(0, 200)
      .join("\n"),
  );
};

const postAnswer2: Handler = async (ctx, req) => {
  const b = await body<{ escalation_id: number; answer?: string; abstain?: boolean; why?: string; ref?: number }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  const deps = { ctx, git: ctx.git, notifyBoss: ctx.notifyBoss };

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

const postTriage: Handler = async (ctx, req) => {
  const b = await body<{ group_id: number | string; as: string; note?: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "cos") return bad(`${a.role} does not triage the boss's feedback`);
  if (!["patch", "respec", "reject"].includes(b.as)) return bad("as must be patch, respec or reject");
  const gid = resolveGroup(ctx, b.group_id);
  if (!gid) return bad("which group? pass its id or name");
  triage({ ctx, git: ctx.git }, gid, b.as as Triage, b.note ?? "");
  return text("ok");
};

const postRevoke: Handler = async (ctx, _req, params) => {
  const out = await revoke({ ctx, git: ctx.git }, Number(params.id));
  return json(out);
};

/**
 * The Dispatcher files its DRAFT card.
 *
 * Validated here rather than trusted, and the group only becomes DRAFT once a
 * card exists — the boss should never be asked to approve nothing.
 */
const postDraft: Handler = async (ctx, req) => {
  const b = await body<{ group_id: number | string; card: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "dispatcher" && a.role !== "pm") return bad(`${a.role} does not file DRAFT cards`);

  const v = validateDraftCard(b.card ?? "");
  if (!v.ok) return bad(v.error);

  const grpId = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!grpId) return bad("which group? pass its id or name");
  const grp = ctx.db
    .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
    .get(grpId);
  if (!grp) return bad(`no group ${grpId}`);

  ctx.db.run(
    `INSERT INTO note (project_id, grp_id, kind, lang, body, frontmatter_json, at)
     VALUES (?, ?, 'fact', ?, ?, ?, unixepoch() * 1000)`,
    [grp.project_id, grpId, ctx.config.language, b.card, JSON.stringify({ draft_card: true })],
  );
  ctx.db.run("UPDATE grp SET status = 'DRAFT' WHERE id = ?", [grpId]);
  // Planning is over, so anything still queued for this group is moot — and DRAFT
  // is not dispatchable, so it would otherwise sit pending forever and then fire
  // after approval against a plan it never saw.
  const dropped = ctx.sched.cancelPending(grpId, "planning finished");
  ctx.bus.emit({
    grpId,
    author: a.role,
    kind: "state_change",
    body: `DRAFT card filed: ${v.goal}${dropped ? ` (${dropped} planning turn(s) dropped)` : ""}`,
    meta: { slices: v.slices.length, objection: v.objection },
  });
  ctx.notifyBoss?.(0, `DRAFT ready: ${v.goal}`, "advisory");
  return text("ok");
};

/** The Architect cuts a group's boundary before work is planned inside it. */
/**
 * One idea, several requirements.
 *
 * The boss types into one box, and what lands there is often not one thing: a dozen
 * questions and three unrelated asks in one paragraph. Until this existed the shape
 * of the system forced all of it into ONE requirement — one DRAFT card with one 目标
 * line and at most five slices, one branch, one Engineer working serially, and one PR
 * at the end. The Dispatcher's only options were to drop most of it or to write a 目标
 * that was not true ("多项改进"), and `checkSplit` would not object, because four
 * unrelated slices genuinely do have four different acceptance criteria.
 *
 * A requirement is the unit of a PR and of acceptance (PLAN.md §7), so unrelated work
 * must be unrelated requirements: separate branches, separate boundaries, separately
 * mergeable, separately rejectable. Splitting IS decomposition, which makes it the
 * Dispatcher's job — so it gets a verb rather than a prompt telling it to cope.
 *
 * Only before work exists. After a card is approved there is a branch and a worktree,
 * and re-cutting then is `respec`, not a split.
 */
const MAX_SPLIT = 6;

const postSplit: Handler = async (ctx, req) => {
  const b = await body<{ group_id: number | string; requirements?: { name?: string; idea: string }[]; why?: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "dispatcher" && a.role !== "pm") return bad(`${a.role} does not split requirements`);

  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");
  const grp = ctx.db
    .query<{ project_id: number; name: string; status: string; worktree: string | null }, [number]>(
      "SELECT project_id, name, status, worktree FROM grp WHERE id = ?",
    )
    .get(gid);
  if (!grp) return text("no such group", 404);
  if (grp.status !== "PLANNING") {
    return bad(
      `${grp.name} is ${grp.status}, not PLANNING. A split only makes sense before a card is approved; ` +
        `after that the branch exists and re-cutting the work is the boss's respec, not yours.`,
    );
  }
  const hasWork = ctx.db
    .query<{ c: number }, [number]>("SELECT count(*) AS c FROM slice WHERE grp_id = ?")
    .get(gid)!.c;
  if (hasWork > 0 || grp.worktree) return bad(`${grp.name} already has slices or a worktree; split before that`);

  const items = (b.requirements ?? []).filter((r) => r?.idea?.trim());
  if (items.length < 2) {
    return bad(
      "a split needs at least 2 requirements. If it is one thing, just file the card with `orch draft`.",
    );
  }
  if (items.length > MAX_SPLIT) {
    return bad(
      `${items.length} is too many for one split (max ${MAX_SPLIT}). Group what shares an acceptance path, ` +
        `and ask the boss which of the rest matters first.`,
    );
  }

  // What the boss originally said, so nothing typed in that box is lost — including
  // the attachment paths, which live in the first note.
  const original = ctx.db
    .query<{ id: number; body: string }, [number]>(
      "SELECT id, body FROM note WHERE grp_id = ? AND kind = 'fact' ORDER BY at LIMIT 1",
    )
    .get(gid);

  const made: { id: number; name: string }[] = [];
  for (const item of items) {
    const name = (item.name?.trim() || slug(item.idea)).slice(0, 40);
    const child = ctx.db
      .query<{ id: number }, [number, string]>(
        "INSERT INTO grp (project_id, name, status, created_at) VALUES (?, ?, 'PLANNING', unixepoch() * 1000) RETURNING id",
      )
      .get(grp.project_id, name)!;
    const ch = ctx.db
      .query<{ id: number }, [number, number]>(
        "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (?, ?, 'group', unixepoch() * 1000) RETURNING id",
      )
      .get(grp.project_id, child.id)!;
    ctx.db.run(
      "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
      [
        grp.project_id,
        child.id,
        ctx.config.language,
        `${item.idea.trim()}\n\n（从「${grp.name}」拆出来的一条${original ? `，原始整段见 note #${original.id}` : ""}）`,
      ],
    );
    ctx.bus.emit({
      channelId: ch.id,
      grpId: child.id,
      author: "boss",
      kind: "boss_say",
      intent: "request",
      body: item.idea.trim(),
    });
    ctx.sched.enqueue("agent_turn", { grp_id: child.id, priority: 5, payload: { role: "dispatcher", idea: item.idea.trim() } });
    made.push({ id: child.id, name });
  }

  // The container is done: its pending turns would re-plan work that has moved. No
  // retro — it never did any work, and demanding one for a bookkeeping group would
  // teach the agents that retros are paperwork.
  ctx.sched.cancelPending(gid, "split into separate requirements");
  ctx.db.run("UPDATE grp SET status = 'DISSOLVED' WHERE id = ?", [gid]);
  ctx.db.run("UPDATE channel SET status = 'archived' WHERE grp_id = ?", [gid]);
  ctx.bus.emit({
    grpId: gid,
    author: a.role,
    kind: "state_change",
    body: `拆成 ${made.length} 个独立需求：${made.map((m) => m.name).join("、")}${b.why ? ` —— ${b.why}` : ""}`,
    meta: { split: made.map((m) => m.id) },
  });
  ctx.sched.tick();
  return json({ requirements: made });
};

const postOwns: Handler = async (ctx, req) => {
  const b = await body<{ group_id: number | string; paths: string[] }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "architect") return bad(`${a.role} does not cut boundaries`);
  if (!Array.isArray(b.paths) || b.paths.length === 0) return bad("give at least one path glob");
  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");

  ctx.db.run("UPDATE grp SET owns_json = ? WHERE id = ?", [JSON.stringify(b.paths), gid]);
  const check = canStart(ctx.db, gid);
  ctx.bus.emit({
    grpId: gid,
    author: "architect",
    kind: "decision",
    intent: "decision",
    body: `owns ${b.paths.join(", ")}${check.ok ? "" : ` — still blocked: ${check.reason}`}`,
    meta: { paths: b.paths, ok: check.ok },
  });
  return check.ok ? text("ok") : bad(check.reason ?? "boundary still overlaps");
};

const postAudit: Handler = async (ctx, req) => {
  const b = await body<{ group_id: number | string; verdict: string; note?: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "auditor") return bad(`${a.role} does not file audit verdicts`);
  if (b.verdict !== "pass" && b.verdict !== "fail") return bad("verdict must be pass or fail");
  const gid = resolveGroup(ctx, b.group_id);
  if (!gid) return bad("which group? pass its id or name");
  // The Auditor is deliberately not a member of the group it reviews, so it is
  // the one role whose group check is inverted.
  if (a.grp_id === gid) return bad("an auditor may not audit its own group");

  ctx.bus.emit({
    grpId: gid,
    author: "auditor",
    kind: "gate_result",
    intent: "decision",
    body: `audit ${b.verdict}${b.note ? `: ${b.note}` : ""}`,
    meta: { verdict: b.verdict },
  });
  ctx.auditVerdict?.(gid, b.verdict === "pass", b.note ?? "");
  return text("ok");
};

/**
 * Actions no agent may take, whatever its clearance and whoever asked it to.
 *
 * Written as a list in code rather than a line in a prompt, because a prompt
 * rule is a suggestion by turn 20. These four are the git-shaped members of the
 * six reserved actions in PLAN.md §7; secrets are handled by the sandbox and
 * spending has no mechanism to abuse yet.
 */
export function reservedGitAction(argv: string[]): string | null {
  const sub = argv.find((a) => !a.startsWith("-"));
  if (sub === "push") return "pushing is the boss's call — open a PR instead";
  if (sub === "merge" || sub === "rebase") {
    const ontoMain = argv.some((a) => /^(origin\/)?(main|master)$/.test(a));
    if (sub === "merge") return "merging is reserved for the boss";
    if (ontoMain) return null; // rebasing your own branch onto main is fine
  }
  if (argv.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease")) {
    return "force is never allowed: it destroys history someone else may hold";
  }
  if (sub === "reset" && argv.includes("--hard")) {
    return "hard reset discards work — ask the boss to interrupt-and-roll-back instead";
  }
  return null;
}

const postGit: Handler = async (ctx, req) => {
  const b = await body<{ argv: string[] }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");

  const reserved = reservedGitAction(b.argv ?? []);
  if (reserved) {
    ctx.bus.emit({
      grpId: a.grp_id,
      author: a.role,
      kind: "escalation",
      intent: "ask",
      severity: "advisory",
      body: `blocked: git ${(b.argv ?? []).join(" ")} — ${reserved}`,
    });
    return bad(`refused: ${reserved}`);
  }
  const grp = a.grp_id
    ? ctx.db
        .query<{ worktree: string | null; project_id: number }, [number]>(
          "SELECT worktree, project_id FROM grp WHERE id = ?",
        )
        .get(a.grp_id)
    : null;
  const repo =
    (grp &&
      ctx.db
        .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
        .get(grp.project_id)?.repo_path) ||
    process.cwd();
  const cwd = grp?.worktree ?? repo;

  const out = await ctx.gitLock.run(repo, b.argv, async () => {
    const p = Bun.spawn(["git", ...b.argv], { cwd, stdout: "pipe", stderr: "pipe" });
    const [so, se] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { code, out: (so + se).trimEnd() };
  });
  return text(`exit ${out.code}\n${out.out}`, out.code === 0 ? 200 : 200);
};

const postCtxQuery: Handler = async (ctx, req) => {
  const b = await body<{ question: string; limit?: number }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  const projectId =
    ctx.db
      .query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?")
      .get(a.id)?.project_id ?? null;
  return text(
    ctxQuery({
      db: ctx.db,
      grpId: a.grp_id,
      projectId,
      question: b.question,
      budget: b.limit ?? CTX_BUDGET_CHARS,
    }),
  );
};

export const CTX_BUDGET_CHARS = DEFAULT_BUDGET;

const getTasks: Handler = async (ctx, req) => {
  const grp = Number(new URL(req.url).searchParams.get("grp") ?? 0);
  // Only the slice being worked, plus anything not tied to a slice. Showing the
  // whole plan's tasks let the writer mark future slices done, which pushed
  // slices that had never started into review.
  const rows = ctx.db
    .query<{ id: number; title: string; status: string; slice_id: number | null; owner: string | null }, [number]>(
      `SELECT t.id, t.title, t.status, t.slice_id, a.role AS owner
       FROM task t LEFT JOIN agent a ON a.id = t.owner_agent_id
       WHERE t.grp_id = ?
         AND (t.slice_id IS NULL
              OR t.slice_id IN (SELECT id FROM slice WHERE grp_id = t.grp_id AND status NOT IN ('pending','accepted')))
       ORDER BY t.id`,
    )
    .all(grp);
  if (rows.length === 0) return text("no tasks are open in this group right now");
  // Lines, not a JSON array. Handing an agent `[{"id":1,"title":"…"}]` invites it
  // to pass the title where an id belongs, which is what happened live.
  return text(
    ["id  status       slice  owner       title", ...rows.map(
      (r) =>
        `${String(r.id).padEnd(4)}${r.status.padEnd(13)}${String(r.slice_id ?? "-").padEnd(7)}` +
        `${(r.owner ?? "-").padEnd(12)}${r.title}`,
    )].join("\n"),
  );
};

const postTaskClaim: Handler = async (ctx, req) => {
  const b = await body<{ task_id: number }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  const r = ctx.db.run(
    `UPDATE task SET owner_agent_id = ?, status = 'in_progress'
     WHERE id = ? AND owner_agent_id IS NULL
       AND (slice_id IS NULL
            OR slice_id IN (SELECT id FROM slice WHERE id = task.slice_id AND status NOT IN ('pending','accepted')))`,
    [a.id, b.task_id],
  );
  return r.changes ? text("ok") : bad("already claimed, or its slice is not being worked yet");
};

const postTaskDone: Handler = async (ctx, req) => {
  const b = await body<{ task_id: number; claim?: unknown; already_done?: string; review?: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");

  // An empty claim makes reconcile vacuous: "claimed vs actual" degenerates into
  // "did anything change at all". Observed live — every claim arrived as {}.
  const claimText = JSON.stringify(b.claim ?? null);
  const hasClaim = Boolean(b.claim) && claimText !== "{}" && claimText !== "null" && claimText !== '""';
  if (!hasClaim && !b.already_done?.trim()) {
    return bad(
      "task done needs --claim (what you actually changed: files and a one-line summary), " +
        'or --already-done "<why>" if an earlier slice already covered it.',
    );
  }
  // A task belonging to a slice that has not started cannot be completed: the
  // writer works one slice at a time, and letting it close future tasks pushed
  // unstarted slices into review.
  const owning = ctx.db
    .query<{ status: string | null }, [number]>(
      "SELECT (SELECT status FROM slice WHERE id = t.slice_id) AS status FROM task t WHERE t.id = ?",
    )
    .get(b.task_id);
  if (owning?.status && ["pending", "accepted"].includes(owning.status)) {
    return bad(
      `task ${b.task_id} belongs to a slice that is not being worked (${owning.status}). ` +
        `Finish the slice you are on; the next one starts when the boss accepts this one.`,
    );
  }

  /**
   * Self-review: layer 1 of the slice review, and the only layer that was written
   * down and never enforced.
   *
   * The Engineer's role prompt already told it a content-free self-review would be
   * rejected, and nothing rejected anything — `validateSelfReview` existed, had a
   * test, and no caller. A prompt that promises a check nobody runs is worse than no
   * check: it reads as done. PLAN.md §7 is explicit that self-review needs a
   * deterministic anchor (the acceptance criteria and the agent's own diff lines) or
   * it is self-congratulation.
   *
   * Demanded only on the task that closes the slice: that is where the work is
   * finished, and asking per task would make it a formality four times over.
   */
  const closing = ctx.db
    .query<{ slice_id: number | null; open: number }, [number]>(
      `SELECT t.slice_id AS slice_id,
              (SELECT count(*) FROM task o WHERE o.slice_id = t.slice_id AND o.status != 'done' AND o.id != t.id) AS open
       FROM task t WHERE t.id = ?`,
    )
    .get(b.task_id);
  const lastOfSlice = closing?.slice_id != null && closing.open === 0;
  if (lastOfSlice) {
    const spec = ctx.db
      .query<{ accept_spec: string; seq: number }, [number]>("SELECT accept_spec, seq FROM slice WHERE id = ?")
      .get(closing!.slice_id!);
    const v = validateSelfReview(b.review ?? "", 1);
    if (!v.ok) {
      return bad(
        `${v.error}\n\nThis task closes S${spec?.seq ?? "?"}, so it needs a self-review:\n` +
          `  orch task done ${b.task_id} --claim '{…}' --review "pass: <criterion> — <the diff line that satisfies it>"\n` +
          `Acceptance criterion: ${spec?.accept_spec ?? "(none recorded)"}`,
      );
    }
  }

  // Unowned is fine: a group has one writer, so requiring an explicit claim only
  // adds a step that gets forgotten. Someone else's task is not.
  const claim = b.already_done?.trim()
    ? { already_done: b.already_done.trim(), files: [] }
    : (b.claim as unknown);
  const done = ctx.db.run(
    `UPDATE task SET status = 'done', claim_json = ?, owner_agent_id = ?
     WHERE id = ? AND (owner_agent_id IS NULL OR owner_agent_id = ?)`,
    [JSON.stringify(claim), a.id, b.task_id, a.id],
  );
  if (done.changes === 0) return bad(`task ${b.task_id} is not yours, or does not exist`);
  ctx.bus.emit({
    grpId: a.grp_id,
    author: a.role,
    kind: "state_change",
    body: `task ${b.task_id} done`,
    meta: { task_id: b.task_id, claim: b.claim ?? {} },
  });

  // A slice enters review only when nothing is left open in it. Reviewing a
  // half-finished slice burns the reviewer on work that is about to change.
  const slice = ctx.db
    .query<{ slice_id: number | null }, [number]>("SELECT slice_id FROM task WHERE id = ?")
    .get(b.task_id);
  if (lastOfSlice && b.review?.trim()) {
    recordGate(ctx.db, closing!.slice_id!, "self", "pass");
    ctx.bus.emit({
      grpId: a.grp_id,
      author: a.role,
      kind: "gate_result",
      intent: "decision",
      body: b.review.trim().slice(0, 1200),
      meta: { slice_id: closing!.slice_id, layer: "self" },
    });
  }

  if (slice?.slice_id) {
    const open = ctx.db
      .query<{ c: number }, [number]>(
        "SELECT count(*) AS c FROM task WHERE slice_id = ? AND status != 'done'",
      )
      .get(slice.slice_id)!.c;
    if (open === 0) {
      ctx.db.run("UPDATE slice SET status = 'gate' WHERE id = ?", [slice.slice_id]);
      ctx.sched.enqueue("gate", { grp_id: a.grp_id, slice_id: slice.slice_id });
      ctx.sched.tick();
    }
  }
  return text("ok");
};

/**
 * QA's verdict, as a value rather than as prose.
 *
 * Parsing a review out of natural language means occasionally mis-reading a
 * "fail" as a "pass", which is the one error this whole pipeline exists to
 * prevent. So the verdict is an explicit verb.
 */
const postReview: Handler = async (ctx, req) => {
  const b = await body<{ slice_id: number; verdict: string; note?: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "qa" && a.role !== "auditor") return bad(`${a.role} does not file review verdicts`);
  if (b.verdict !== "pass" && b.verdict !== "fail") return bad("verdict must be pass or fail");

  const slice = ctx.db
    .query<{ id: number; grp_id: number; seq: number }, [number]>(
      "SELECT id, grp_id, seq FROM slice WHERE id = ?",
    )
    .get(b.slice_id);
  if (!slice) return bad(`no slice ${b.slice_id}`);
  if (slice.grp_id !== a.grp_id) return bad("that slice belongs to another group");

  ctx.bus.emit({
    grpId: slice.grp_id,
    author: a.role,
    kind: "gate_result",
    intent: "decision",
    body: `S${slice.seq} ${b.verdict}${b.note ? `: ${b.note}` : ""}`,
    meta: { slice_id: slice.id, verdict: b.verdict },
  });
  ctx.reviewVerdict?.(slice.id, b.verdict === "pass", b.note ?? "");
  return text("ok");
};

function loadResource(ctx: Ctx, name: string): ResourceDef | null {
  const r = ctx.db
    .query<
      { name: string; template: string; concurrency: number; arg_schema_json: string; error_regex: string | null; cwd: string | null },
      [string]
    >("SELECT * FROM resource WHERE name = ?")
    .get(name);
  if (!r) return null;
  return {
    name: r.name,
    template: r.template,
    concurrency: r.concurrency,
    argSchema: JSON.parse(r.arg_schema_json),
    errorRegex: r.error_regex ?? undefined,
    cwd: r.cwd ?? undefined,
  };
}

// ------------------------------------------------------------------ boss verbs

const getState: Handler = async (ctx) => json(snapshot(ctx));

const getCost: Handler = async (ctx, req) => {
  const p = new URL(req.url).searchParams.get("project");
  return json(costReport(ctx.db, p ? Number(p) : undefined));
};

export function snapshot(ctx: Ctx) {
  const db = ctx.db;
  return {
    projects: db.query("SELECT id, name, repo_path, remote FROM project").all(),
    groups: db
      .query(
        `SELECT id, project_id, name, branch, worktree, status, owns_json, budget_tokens,
                spent_tokens, spent_usd, pr_number FROM grp WHERE status != 'DISSOLVED'`,
      )
      .all(),
    slices: db
      .query(
        `SELECT id, grp_id, seq, title, accept_spec, difficulty, status, gates_json,
                spent_tokens, spent_usd, awaiting_at FROM slice ORDER BY grp_id, seq`,
      )
      .all(),
    // PLAN.md §8 asks the desk wall for the current slice, the turn count and the
    // live last line. Two of the three are here; the third is the SSE stream,
    // which the client already holds. Turn count is what tells a stuck agent from
    // a busy one — "in_progress" looks identical either way.
    agents: db
      .query(
        `SELECT a.id, a.grp_id, a.role, a.model, a.clearance, a.state, a.activity, a.session_tokens,
                a.total_tokens, a.total_usd,
                (SELECT count(*) FROM job j WHERE j.agent_id = a.id AND j.kind = 'agent_turn'
                  AND j.state IN ('done','failed')) AS turns,
                (SELECT j.slice_id FROM job j WHERE j.agent_id = a.id AND j.slice_id IS NOT NULL
                  ORDER BY j.id DESC LIMIT 1) AS slice_id
         FROM agent a WHERE a.state != 'retired'`,
      )
      .all(),
    tasks: db.query("SELECT id, grp_id, slice_id, title, status FROM task").all(),
    channels: db.query("SELECT id, project_id, grp_id, kind, status FROM channel").all(),
    // The card each DRAFT group filed. Without this the boss is shown an empty
    // box and asked to approve something they cannot see.
    draftCards: db
      .query(
        `SELECT n.grp_id AS grpId, n.body, n.at FROM note n
         JOIN grp g ON g.id = n.grp_id
         WHERE g.status = 'DRAFT' AND json_extract(n.frontmatter_json, '$.draft_card') = 1
         GROUP BY n.grp_id HAVING n.at = max(n.at)`,
      )
      .all(),
    // An objection that arrived after the card was filed. The Dispatcher does not
    // wait for the Architect — a card nobody filed is worth less than a card with
    // no objection on it — so a real objection can land a minute later, while the
    // card still reads 反对 : 无. Approving that is approving something the boss
    // was never shown. Measured: the late objection was "the locale-inference
    // slice contradicts the acceptance criterion that says behaviour is unchanged".
    lateObjections: db
      .query(
        `SELECT e.grp_id AS grpId, e.author, e.body FROM event e
         JOIN grp g ON g.id = e.grp_id
         WHERE g.status = 'DRAFT' AND e.kind = 'say' AND e.author != 'dispatcher'
           AND e.at > (SELECT max(n.at) FROM note n
                       WHERE n.grp_id = e.grp_id
                         AND json_extract(n.frontmatter_json, '$.draft_card') = 1)
         ORDER BY e.seq`,
      )
      .all(),
    // What the boss originally said, verbatim. Those 20 seconds on the card are
    // the only guard against a plan that is well-formed but aimed at the wrong
    // thing, and that comparison is impossible without the original next to it.
    ideas: db
      .query(
        `SELECT grp_id AS grpId, body FROM event
         WHERE kind = 'boss_say' AND grp_id IS NOT NULL
         GROUP BY grp_id HAVING seq = min(seq)`,
      )
      .all(),
    // Recently answered by a stand-in, so the boss can take one back. Without a
    // visible undo, delegated answers are a bet nobody would take.
    answered: db
      .query(
        `SELECT id, grp_id, question, answer, answered_by, ref_note_id, answered_at
         FROM escalation
         WHERE chain_state = 'answered' AND answered_by IS NOT NULL AND answered_by != 'boss'
         ORDER BY answered_at DESC LIMIT 10`,
      )
      .all(),
    escalations: db
      .query(
        `SELECT e.id, e.grp_id, e.severity, e.question, e.chain_state, e.answered_by, e.answer,
                e.created_at, a.role AS asker, a.project_id AS asker_project
         FROM escalation e LEFT JOIN agent a ON a.id = e.agent_id
         WHERE e.chain_state NOT IN ('answered', 'revoked') ORDER BY e.created_at`,
      )
      .all(),
    // Only the queue head is offered for merging; the rest carry their place in
    // line so the boss can see why they are waiting.
    mergeQueue: db
      .query<{ id: number }, []>("SELECT id FROM project")
      .all()
      .flatMap((p) => {
        const h = head(db, p.id);
        return h ? [{ projectId: p.id, ...h, place: position(db, h.grpId) }] : [];
      }),
    // Delivered work, so 收尾 stops meaning "vanished". A group that merged is the
    // only proof the system did what it was asked, and it was leaving no trace
    // anywhere in the panel.
    archived: db
      .query(
        `SELECT g.id, g.project_id, g.name, g.branch, g.pr_number, g.spent_usd,
                (SELECT count(*) FROM slice s WHERE s.grp_id = g.id) AS slices,
                (SELECT max(e.at) FROM event e WHERE e.grp_id = g.id) AS at
         FROM grp g WHERE g.status = 'DISSOLVED' ORDER BY at DESC LIMIT 12`,
      )
      .all(),
    // The panel shows "并行 3/3" from this: without the cap, a queued group looks
    // stuck rather than queued, which is the difference between a bug and a setting.
    limits: {
      maxGroups: ctx.config.maxGroups ?? null,
      leaseSlots: ctx.config.leaseSlots ?? null,
      autoAdvance: !!ctx.config.autoAdvance,
      autoAcceptTiers: ctx.config.autoAcceptTiers ?? [],
    },
    lastSeq:
      ctx.db.query<{ s: number | null }, []>("SELECT max(seq) AS s FROM event").get()?.s ?? 0,
  };
}

const postAnswer: Handler = async (ctx, req, params) => {
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
    { ctx, git: ctx.git },
    { escId: id, by: b.answered_by ?? "boss", answer: withAttachments(b.answer ?? "", b.attachments) },
  );
  return r.ok ? text("ok") : bad(r.error);
};

/**
 * Hand a question back down the chain instead of answering it.
 *
 * PLAN.md §8 puts `[回答] [转 Architect]` on the same line for a reason: plenty of
 * what reaches the boss is a technical call somebody else should make, and
 * without this the only ways out are answering it or leaving it to rot.
 */
const postDelegate: Handler = async (ctx, req, params) => {
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
  const landed = route({ ctx, git: ctx.git, notifyBoss: ctx.notifyBoss }, id);
  return text(landed);
};

/**
 * Files that come with an idea: a screenshot of the bug, a mock, a spec.
 *
 * Saved on disk and referenced by absolute path, never inlined: an image in a
 * prompt is worth thousands of tokens on every turn that carries it, while a path
 * costs a dozen and the agent can open it with Read exactly once, when it needs to.
 */
const postAttach: Handler = async (ctx, req) => {
  const form = await req.formData();
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) return bad("no file");
  const dir = join(ctx.config.dataDir ?? "data", "attachments");
  await mkdir(dir, { recursive: true });
  const out: { name: string; path: string; type: string; size: number }[] = [];
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) return bad(`${f.name} 超过 25MB`);
    // The stamp keeps two screenshots called "Screenshot.png" apart, and the
    // sanitising keeps a crafted filename inside the directory.
    const safe = f.name.replace(/[^\w.\-\u4e00-\u9fff]/g, "_").slice(-80);
    const path = join(dir, `${Date.now()}-${out.length}-${safe}`);
    await writeFile(path, Buffer.from(await f.arrayBuffer()));
    out.push({ name: f.name, path, type: f.type || "application/octet-stream", size: f.size });
  }
  return json({ files: out });
};

export interface Attachment { name: string; path: string; type: string }

/**
 * Words plus the files that came with them.
 *
 * Paths, never contents: an image inlined into a prompt costs thousands of tokens
 * on every turn that carries it, a path costs a dozen and the agent opens it once
 * with Read when it needs to. Shared by every route the boss can attach to —
 * an idea, a sent-back card, a rejected slice, a remark to the group.
 */
export function withAttachments(text: string, attachments?: Attachment[]): string {
  const files = (attachments ?? []).filter((f) => f?.path);
  if (!files.length) return text;
  return (
    `${text}\n\n附件（用 Read 打开）：\n` +
    files.map((f) => `- ${f.path}${f.type?.startsWith("image/") ? "（图片）" : ""}`).join("\n")
  );
}

const postIdea: Handler = async (ctx, req) => {
  const b = await body<{
    project_id: number;
    text: string;
    name?: string;
    attachments?: { name: string; path: string; type: string }[];
  }>(req);
  if (!b.text?.trim()) return bad("empty idea");
  const name = (b.name ?? slug(b.text)).slice(0, 40);
  const grp = ctx.db
    .query<{ id: number }, [number, string]>(
      "INSERT INTO grp (project_id, name, status, created_at) VALUES (?, ?, 'PLANNING', unixepoch() * 1000) RETURNING id",
    )
    .get(b.project_id, name)!;
  // `channel.grp_id` is the only link between the two; a reverse pointer on grp
  // would be a second source of truth for the same edge.
  const ch = ctx.db
    .query<{ id: number }, [number, number]>(
      "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (?, ?, 'group', unixepoch() * 1000) RETURNING id",
    )
    .get(b.project_id, grp.id)!;

  // Attachments go on the blackboard as paths next to the words they came with, so
  // whoever plans this reads them in the same breath as the idea.
  const noteBody = withAttachments(b.text, b.attachments);
  ctx.db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
    [b.project_id, grp.id, ctx.config.language, noteBody],
  );
  ctx.bus.emit({ channelId: ch.id, grpId: grp.id, author: "boss", kind: "boss_say", intent: "request", body: b.text });
  // With another group already holding paths, the boundary has to be cut before
  // anyone plans work inside it — otherwise the plan is written against paths the
  // group turns out not to own.
  const others = ctx.db
    .query<{ id: number; name: string; owns_json: string }, [number, number]>(
      `SELECT id, name, owns_json FROM grp WHERE project_id = ? AND id != ?
         AND status IN ('PLANNING','RUNNING','PAUSING','PAUSED','PARKED','PR_OPEN')`,
    )
    .all(b.project_id, grp.id);
  if (others.length > 0) {
    // Every undeclared active group, not just the new one. The first group in a
    // project needs no boundary — but the moment a second appears, an undeclared
    // group beside a declared one is the exact situation the rule exists to
    // prevent, reached from the other direction.
    const needBoundary = [
      { id: grp.id, name, idea: b.text },
      ...others
        .filter((o) => parseOwns(o.owns_json).length === 0)
        .map((o) => ({ id: o.id, name: o.name, idea: firstIdea(ctx, o.id) })),
    ];
    ctx.sched.enqueue("agent_turn", {
      grp_id: grp.id,
      priority: 6,
      payload: { role: "architect", boundary: needBoundary, idea: b.text },
    });
  }

  ctx.sched.enqueue("agent_turn", { grp_id: grp.id, payload: { role: "dispatcher", idea: b.text } });
  ctx.sched.tick();
  return json({ grp_id: grp.id, channel_id: ch.id, boundaryNeeded: others.length > 0 });
};

const postDraftDecision: Handler = async (ctx, req, params) => {
  const b = await body<{ card?: string; reason?: string; attachments?: Attachment[] }>(req);
  const grpId = Number(params.id);
  const approve = params.decision === "approve";

  if (!approve) {
    ctx.db.run(
      "INSERT INTO note (grp_id, kind, lang, body, at) VALUES (?, 'fact', ?, ?, unixepoch() * 1000)",
      [grpId, ctx.config.language, withAttachments(`boss sent the DRAFT back: ${b.reason ?? ""}`, b.attachments)],
    );
    // Back to PLANNING, which is what the group actually is now. Left in DRAFT it
    // still counted as a decision waiting on the boss, still showed the rejected
    // card, and 批准开工 still worked on it — one stray click approves the very
    // plan that was just sent back.
    ctx.db.run("UPDATE grp SET status = 'PLANNING' WHERE id = ? AND status = 'DRAFT'", [grpId]);
    const why = withAttachments(b.reason ?? "respec", b.attachments);
    ctx.bus.emit({ grpId, author: "boss", kind: "boss_say", intent: "request", body: why });
    ctx.sched.enqueue("agent_turn", { grp_id: grpId, payload: { role: "dispatcher", respec: why } });
    ctx.sched.tick();
    return text("sent back");
  }

  // The boss usually approves what the Dispatcher filed; an edited card in the
  // request body is the "改完批准" path.
  const filed = ctx.db
    .query<{ body: string }, [number]>(
      `SELECT body FROM note WHERE grp_id = ? AND json_extract(frontmatter_json, '$.draft_card') = 1
       ORDER BY at DESC LIMIT 1`,
    )
    .get(grpId)?.body;
  const card = b.card ?? filed;

  if (card) {
    const v = validateDraftCard(card);
    if (!v.ok) return bad(v.error);
    ctx.db.run("DELETE FROM slice WHERE grp_id = ?", [grpId]);
    const ins = ctx.db.prepare(
      `INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, created_at)
       VALUES (?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    );
    // One task per slice, up front. Without something to claim the writer
    // improvises an id, `task done` never lands, and the whole review pipeline
    // silently never fires — which is exactly what the live run showed.
    const insTask = ctx.db.prepare(
      "INSERT INTO task (grp_id, slice_id, title, created_at) VALUES (?, ?, ?, unixepoch() * 1000)",
    );
    v.slices.forEach((sl, i) => {
      const row = ins.get(grpId, i + 1, sl.title, sl.accept, sl.difficulty) as { id: number };
      insTask.run(grpId, row.id, sl.title);
    });
  }
  // Boundaries before work. Two groups discovering at merge time that they were
  // both editing one file have already paid for the work twice.
  const start = canStart(ctx.db, grpId);
  if (!start.ok) {
    // Refusing with no path forward leaves the boss holding an error. Put the
    // Architect back on it — the boundary is its job, and it was observed cutting
    // one group's paths and forgetting the other's.
    const undeclared = ctx.db
      .query<{ id: number; name: string }, [number]>(
        `SELECT id, name FROM grp
         WHERE project_id = (SELECT project_id FROM grp WHERE id = ?)
           AND status IN ('PLANNING','DRAFT','RUNNING','PAUSING','PAUSED','PARKED','PR_OPEN')
           AND (owns_json IS NULL OR owns_json = '[]')`,
      )
      .all(grpId);
    if (undeclared.length) {
      ctx.sched.enqueue("agent_turn", {
        grp_id: grpId,
        priority: 7,
        payload: {
          role: "architect",
          boundary: undeclared.map((g) => ({ ...g, idea: firstIdea(ctx, g.id) })),
        },
      });
      ctx.sched.tick();
    }
    ctx.bus.emit({
      grpId,
      author: "orchestrator",
      kind: "state_change",
      body: `cannot start yet: ${start.reason}${undeclared.length ? " — asked the Architect to cut it" : ""}`,
    });
    return bad(
      `cannot start: ${start.reason}` +
        (undeclared.length ? ". The Architect has been asked to cut the boundary; approve again after that." : ""),
    );
  }

  // Approval is where the group gets a place to work. The worktree lives under
  // workRoot (outside $HOME) because the sandbox is deny-only: denying $HOME is
  // how writes get confined at all.
  const grp = ctx.db
    .query<{ name: string; project_id: number; worktree: string | null }, [number]>(
      "SELECT name, project_id, worktree FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (grp && !grp.worktree && ctx.git) {
    const repo = ctx.db
      .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
      .get(grp.project_id);
    if (repo) {
      try {
        const wt = await createWorktree(ctx.git, {
          repoPath: repo.repo_path,
          workRoot: ctx.config.workRoot,
          group: grp.name,
        });
        ctx.db.run("UPDATE grp SET worktree = ?, branch = ? WHERE id = ?", [
          wt.worktree,
          wt.branch,
          grpId,
        ]);
        ctx.bus.emit({
          grpId,
          author: "orchestrator",
          kind: "state_change",
          body: say(ctx.config?.language, "group.worktree", { branch: wt.branch }),
        });
      } catch (e: any) {
        // Refuse to start rather than run the group in the main checkout, where
        // it would write straight into the boss's working tree.
        return bad(`could not create a worktree: ${e?.message ?? e}`);
      }
    }
  }

  ctx.db.run("UPDATE grp SET status = 'RUNNING' WHERE id = ?", [grpId]);
  ctx.bus.emit({ grpId, author: "boss", kind: "state_change", body: say(ctx.config?.language, "group.approved") });
  // Approving a plan that then sits still is the most confusing failure there is:
  // it looks like the system ignored you.
  startNextSlice(ctx, grpId);
  ctx.sched.tick();
  return text("ok");
};

/**
 * Wind a merged group up. One path, whether the boss said so or `gh` did.
 *
 * Dissolving is the most irreversible thing on the panel — the group leaves every
 * view — so it must never rest on a guess about whether the branch is in main.
 */
export function landGroup(ctx: Ctx, grpId: number, by: string): number[] {
  const stale = landed(ctx.db, grpId);
  ctx.bus.emit({ grpId, author: by, kind: "state_change", body: say(ctx.config?.language, "group.merged") });

  // Turn this group's retro into lessons while the branch is fresh. This is
  // the only mechanism by which the twentieth group is smarter than the
  // first, so it runs on the way out, not "later".
  ctx.sched.enqueue("agent_turn", {
    grp_id: grpId,
    payload: {
      role: "librarian",
      rejection:
        "This group just merged. Read its retro and journals, then update the project's " +
        "lesson list (`orch journal add --kind lesson`) with anything that would have changed " +
        "a decision. Refresh the onboarding pack if this changed how the project is built or tested.",
    },
  });
  for (const id of stale) {
    ctx.sched.enqueue("agent_turn", {
      grp_id: id,
      payload: {
        role: "engineer",
        rejection: "main moved: rebase onto it with `orch git -- rebase` before doing anything else.",
        rotate: true,
      },
    });
  }
  ctx.sched.tick();
  return stale;
}

/**
 * Ask GitHub, not the boss, whether the PR is merged.
 *
 * Returns the state string, or null when it cannot be established (no `gh`, no PR
 * number, no worktree) — which is a different answer from "not merged" and has to
 * stay distinguishable, or a project without `gh` could never wind a group up.
 */
export async function prState(ctx: Ctx, grpId: number): Promise<string | null> {
  const g = ctx.db
    .query<{ pr_number: number | null; worktree: string | null }, [number]>(
      "SELECT pr_number, worktree FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!ctx.gh || !g?.pr_number || !g.worktree) return null;
  const r = await ctx.gh(["pr", "view", String(g.pr_number), "--json", "state,mergedAt"], g.worktree);
  if (r.code !== 0) return null;
  try {
    return String(JSON.parse(r.out).state ?? "").toUpperCase() || null;
  } catch {
    return null;
  }
}

const postGroupControl: Handler = async (ctx, req, params) => {
  const grpId = Number(params.id);
  const action = params.action;
  switch (action) {
    case "budget": {
      // Budget exhaustion suspends the group, and until this existed there was no
      // route out of it: 继续 un-paused a group the scheduler refused to admit,
      // so the next tick suspended it again. A limit needs a way to be raised.
      const b = await body<{ tokens?: number | null }>(req);
      const t = b.tokens == null ? null : Math.round(Number(b.tokens));
      if (t !== null && !(t > 0)) return bad("tokens must be a positive number, or null to lift the cap");
      const spent = ctx.db
        .query<{ spent_tokens: number; status: string }, [number]>("SELECT spent_tokens, status FROM grp WHERE id = ?")
        .get(grpId);
      if (!spent) return text("no such group", 404);
      if (t !== null && t <= spent.spent_tokens) {
        return bad(`already spent ${spent.spent_tokens} tokens — a cap at ${t} would stop it again immediately`);
      }
      ctx.db.run("UPDATE grp SET budget_tokens = ? WHERE id = ?", [t, grpId]);
      ctx.bus.emit({
        grpId,
        author: "boss",
        kind: "state_change",
        body: t === null ? "budget cap lifted" : `budget raised to ${t} tokens`,
      });
      // Raising the cap is the answer to the question the watchdog asked, so it
      // also closes it: a stale "out of budget" row in 等你 is worse than none.
      ctx.db.run(
        `UPDATE escalation SET chain_state = 'answered', answered_by = 'boss', answer = ?, answered_at = unixepoch() * 1000
         WHERE grp_id = ? AND chain_state = 'boss' AND answer IS NULL AND question LIKE 'budget:%'`,
        [t === null ? "cap lifted" : `raised to ${t}`, grpId],
      );
      if (spent.status === "PAUSED") resume(ctx, grpId);
      ctx.sched.tick();
      return json({ budget: t });
    }
    case "pause": {
      // Reports how many turns it is waiting on: PAUSING is honest, PAUSED
      // would not be while something is still in flight.
      const waiting = pause(ctx, grpId);
      return json({ status: waiting ? "PAUSING" : "PAUSED", waiting });
    }
    case "resume": {
      // Un-pausing an over-budget group is a no-op the boss cannot see: the
      // scheduler refuses to admit it, so it sits in RUNNING doing nothing.
      const g = ctx.db
        .query<{ budget_tokens: number | null; spent_tokens: number }, [number]>(
          "SELECT budget_tokens, spent_tokens FROM grp WHERE id = ?",
        )
        .get(grpId);
      if (g?.budget_tokens != null && g.spent_tokens >= g.budget_tokens) {
        return bad(
          `out of budget (${g.spent_tokens}/${g.budget_tokens} tokens). Raise the cap first, ` +
            `or it stops again on the next tick.`,
        );
      }
      resume(ctx, grpId);
      return text("ok");
    }
    case "park":
      park(ctx, grpId, "you parked it");
      return text("ok");
    case "landed": {
      // "Confirm merged" used to be taken on trust, and it dissolves the group:
      // one mis-click archived a branch that was still open, with no way back.
      // GitHub already knows the answer, and prwatch is already asking it.
      const b = await body<{ force?: boolean }>(req);
      const state = await prState(ctx, grpId);
      if (state && state !== "MERGED" && !b.force) {
        return bad(
          `GitHub says this PR is ${state}, not MERGED. Merge it there first — 收尾 dissolves the group.`,
        );
      }
      return json({ staleGroups: landGroup(ctx, grpId, "boss"), verified: state === "MERGED" });
    }
    case "wake":
      if (!ctx.git) return bad("no git runner");
      await unpark(ctx, ctx.git, grpId);
      return text("ok");
    case "interrupt": {
      const b = await body<{ mode?: string }>(req);
      const mode = b.mode === "rollback" ? "rollback" : "keep";
      if (!ctx.git) return bad("no git runner");
      const out = await interrupt(ctx, ctx.git, grpId, mode);
      return json(out);
    }
    default:
      return bad(`unknown action ${action}`);
  }
};

/** Roughly a screenful of diff. Beyond this the boss wants the editor, not a panel. */
const DIFF_CAP = 80_000;

/**
 * What actually happened in one slice: the diff, QA's verdict, the gate output.
 *
 * Accepting is one of the boss's three approval points, and it was being asked
 * for on a title and an acceptance line — the same information the boss already
 * approved on the DRAFT card. Nothing new to judge means the button is a rubber
 * stamp, which makes the three gates in front of it decorative.
 */
const getEvidence: Handler = async (ctx, _req, params) => {
  const id = Number(params.id);
  const sl = ctx.db
    .query<
      { grp_id: number; seq: number; title: string; accept_spec: string; base_sha: string | null; retries: number },
      [number]
    >("SELECT grp_id, seq, title, accept_spec, base_sha, retries FROM slice WHERE id = ?")
    .get(id);
  if (!sl) return text("no such slice", 404);

  const grp = ctx.db
    .query<{ project_id: number; worktree: string | null }, [number]>(
      "SELECT project_id, worktree FROM grp WHERE id = ?",
    )
    .get(sl.grp_id);
  const repo = grp
    ? ctx.db.query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?").get(grp.project_id)
        ?.repo_path
    : undefined;

  let stat = "";
  let diff = "";
  let truncated = false;
  if (ctx.git && repo && grp?.worktree && sl.base_sha) {
    const [s, d] = await Promise.all([
      ctx.git(repo, ["diff", "--stat", sl.base_sha, "--"], grp.worktree),
      ctx.git(repo, ["diff", sl.base_sha, "--"], grp.worktree),
    ]);
    stat = s.code === 0 ? s.out.trim() : "";
    diff = d.code === 0 ? d.out : "";
    truncated = diff.length > DIFF_CAP;
    if (truncated) diff = diff.slice(0, DIFF_CAP);
  }

  // Both reviewers file through the same route, so this is QA's verdict on a
  // slice and the Auditor's on a branch, in the order they were given.
  const verdicts = ctx.db
    .query<{ author: string; body: string; at: number }, [number]>(
      `SELECT author, body, at FROM event
       WHERE kind = 'gate_result' AND json_extract(meta_json, '$.slice_id') = ?
       ORDER BY seq`,
    )
    .all(id);

  // The gate wrote these itself (gate.ts logPath). Tail only: a build log is
  // megabytes and the useful part is at the end.
  const gates = gatesFor(ctx.db, grp?.project_id ?? 0).flatMap((name) => {
    const path = join(ctx.config.dataDir ?? "data", "gates", `${id}-${name}.log`);
    if (!existsSync(path)) return [];
    const raw = Bun.file(path);
    return [{ name, path, size: raw.size }];
  });

  return json({ ...sl, stat, diff, truncated, verdicts, gates });
};

/** Tail of one gate's log, on demand: it is only opened when a verdict is doubted. */
const getGateLog: Handler = async (ctx, req, params) => {
  const name = (params.name ?? "").replace(/[^\w.-]/g, "");
  const path = join(ctx.config.dataDir ?? "data", "gates", `${Number(params.id)}-${name}.log`);
  if (!existsSync(path)) return text("no log", 404);
  const raw = await Bun.file(path).text();
  const grep = new URL(req.url).searchParams.get("grep");
  const lines = raw.split("\n");
  return text(grep ? lines.filter((l) => new RegExp(grep).test(l)).slice(0, 400).join("\n") : lines.slice(-400).join("\n"));
};

const postSliceDecision: Handler = async (ctx, req, params) => {
  const raw = await body<{ feedback?: string; attachments?: Attachment[] }>(req);
  const b = { feedback: raw.feedback ? withAttachments(raw.feedback, raw.attachments) : raw.feedback };
  const id = Number(params.id);
  const accept = params.decision === "accept";
  const sl = ctx.db
    .query<{ grp_id: number; seq: number; title: string }, [number]>(
      "SELECT grp_id, seq, title FROM slice WHERE id = ?",
    )
    .get(id);
  if (!sl) return text("no such slice", 404);

  // One acceptance path, whoever accepted: see acceptSlice.
  if (accept) acceptSlice(ctx, id, "boss");

  if (!accept) {
    ctx.db.run("UPDATE slice SET status = 'rejected' WHERE id = ?", [id]);
    ctx.bus.emit({
      grpId: sl.grp_id,
      author: "boss",
      kind: "boss_say",
      intent: "request",
      body: b.feedback ?? "rejected",
      meta: { slice_id: id },
    });
    ctx.db.run(
      "INSERT INTO note (grp_id, slice_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
      [sl.grp_id, id, ctx.config.language, b.feedback ?? "boss rejected the slice"],
    );
    // With autoAdvance on, later slices were built on the one just rejected. Fixing
    // it underneath work that assumed it is how two problems become four, so the
    // group stops and says so instead.
    const ahead = ctx.db
      .query<{ c: number }, [number, number]>(
        "SELECT count(*) AS c FROM slice WHERE grp_id = ? AND seq > (SELECT seq FROM slice WHERE id = ?) AND status != 'pending'",
      )
      .get(sl.grp_id, id)!.c;
    if (ctx.config.autoAdvance && ahead > 0) {
      ctx.db.run("UPDATE grp SET status = 'PAUSING' WHERE id = ? AND status = 'RUNNING'", [sl.grp_id]);
      ctx.bus.emit({
        grpId: sl.grp_id,
        author: "orchestrator",
        kind: "escalation",
        intent: "ask",
        severity: "blocker",
        body:
          `你退回了 S${sl.seq}，但 autoAdvance 已经让后面 ${ahead} 片开工了 —— 它们是在这一片的基础上做的。` +
          `全组先停下：要么让它先修这一片，要么把后面几片一起退回。`,
      });
    }
    ctx.sched.enqueue("agent_turn", { grp_id: sl.grp_id, slice_id: id, payload: { rejection: b.feedback } });
  }
  ctx.sched.tick();
  return text("ok");
};

/**
 * Why a path cannot be a project, in words the boss can act on. Null when fine.
 *
 * Every group needs a worktree, and `git worktree add` needs a real repo. A
 * relative path is refused rather than resolved: it would resolve against
 * whatever directory the server happens to be running in, which is not what the
 * person typing it means.
 */
export function expandHome(p: string): string {
  // Typed by hand, so `~` is what people actually write.
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function checkRepoPath(p: string): string | null {
  if (!p.startsWith("/")) return `${p} must be an absolute path (start with /)`;
  if (!existsSync(p)) return `${p} does not exist`;
  if (!statSync(p).isDirectory()) return `${p} is not a directory`;
  // A worktree has `.git` as a file, not a directory, so check for either.
  if (!existsSync(join(p, ".git"))) {
    return `${p} is not a git repo (no .git). Run \`git init\` there first — every group needs a branch.`;
  }
  return null;
}

const postProject: Handler = async (ctx, req) => {
  const b = await body<{ name: string; repo_path: string; remote?: string; gates?: string[] }>(req);
  if (!b.name || !b.repo_path) return bad("name and repo_path required");

  // The web form is a typed path — a browser cannot hand over a real filesystem
  // path — so a typo is the expected mistake, not an exotic one. Checked here
  // rather than discovered when the first group tries to create a worktree.
  b.repo_path = expandHome(b.repo_path);
  const pathProblem = checkRepoPath(b.repo_path);
  if (pathProblem) return bad(pathProblem);

  const dup = ctx.db
    .query<{ name: string }, [string]>("SELECT name FROM project WHERE repo_path = ?")
    .get(b.repo_path);
  if (dup) return bad(`${b.repo_path} is already registered as "${dup.name}"`);

  // A project with no gates fails every slice by design, so guessing them here
  // is the difference between "works out of the box" and "looks broken on day
  // one". The guess is written into config where it can be corrected.
  const detected = detectGates(b.repo_path);
  const insRes = ctx.db.prepare(
    `INSERT INTO resource (name, template, arg_schema_json, error_regex, concurrency)
     VALUES (?, ?, '{}', ?, 1)
     ON CONFLICT (name) DO UPDATE SET template = excluded.template, error_regex = excluded.error_regex`,
  );
  for (const g of detected) insRes.run(g.name, g.template, g.errorRegex);

  const gates = b.gates ?? detected.map((g) => g.name);
  const config = { gates, shared: detectShared(b.repo_path) };

  const r = ctx.db
    .query<{ id: number }, [string, string, string | null, string]>(
      `INSERT INTO project (name, repo_path, remote, config_json, created_at)
       VALUES (?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    )
    .get(b.name, b.repo_path, b.remote ?? null, JSON.stringify(config))!;

  if (gates.length === 0) {
    // Say it plainly rather than letting the first slice fail with a puzzle.
    ctx.bus.emit({
      author: "orchestrator",
      kind: "escalation",
      intent: "ask",
      severity: "advisory",
      body:
        `no gates detected in ${b.repo_path}. Every slice will fail review until this project ` +
        `has at least one: add a resource template and list its name in the project's gates.`,
    });
  } else {
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: `project ${b.name}: gates ${gates.join(", ")}`,
      meta: { gates, detected },
    });
  }
  // Say now whether a PR can ever be opened. A group that finishes its work and
  // then has nowhere to put it is the worst moment to learn this, and the fix is
  // the boss's to make.
  if (ctx.git && ctx.gh) {
    const pre = await preflightPr(b.repo_path, (argv, cwd) => ctx.git!(cwd, argv, cwd), ctx.gh);
    if (!pre.ok) {
      ctx.bus.emit({
        author: "orchestrator",
        kind: "escalation",
        intent: "ask",
        severity: "advisory",
        body: `PR flow will not work for ${b.name}: ${pre.reason}. Work can still proceed; only the PR step is blocked.`,
        meta: { remote: pre.remote },
      });
    } else {
      ctx.bus.emit({
        author: "orchestrator",
        kind: "state_change",
        body: `PR flow ready (${pre.remote})`,
      });
    }
  }

  // Write the onboarding pack before any group exists, so the first group does
  // not pay to explore the repo. Cheap role, cheap model, once per project.
  ctx.sched.enqueue("agent_turn", {
    priority: 4,
    payload: {
      role: "librarian",
      project_id: r.id,
      onboarding: b.repo_path,
      idea:
        `New project registered at ${b.repo_path}. Write its onboarding pack now ` +
        `(\`orch journal add --kind onboarding\`): how to build, how to test, the conventions ` +
        `actually in use, the known traps, and a short directory map. Six lines max — every ` +
        `future agent reads this on its first turn, so it is the highest-leverage six lines ` +
        `in the project.`,
    },
  });
  ctx.sched.tick();
  return json({ id: r.id, gates, detected });
};

/** Idle SSE connections get dropped by proxies and by browsers' own timeouts. */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Directories, so the boss can pick a repo instead of typing a path.
 *
 * A browser cannot hand over a real filesystem path, and typing one is both ugly
 * and the most likely place to make a mistake. The server can read the disk, so
 * it lists directories and says which are git repos.
 *
 * Names only, never contents: this endpoint has no business reading files, and
 * the page it serves only needs to know what to offer.
 */
/**
 * The blackboard's static half, readable.
 *
 * `note` holds every journal, decision, retro, risk, handoff, onboarding pack and
 * lesson — PLAN.md §7 calls the lesson list "the only mechanism by which the
 * twentieth group is smarter than the first" — and none of it was reachable from
 * the panel at all. Agents could `orch ctx query` it; the boss could not read it.
 */
const getNotes: Handler = async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const project = q.get("project");
  const group = q.get("group");
  const kind = q.get("kind");
  const where: string[] = [];
  const args: any[] = [];
  if (group) {
    where.push("n.grp_id = ?");
    args.push(Number(group));
  } else if (project) {
    // Project scope includes the standing notes (onboarding, lessons) that belong
    // to no group, which is exactly where they matter.
    where.push("(n.project_id = ? OR g.project_id = ?)");
    args.push(Number(project), Number(project));
  }
  if (kind) {
    where.push("n.kind = ?");
    args.push(kind);
  }
  // The draft card is a note too, and it already has its own screen.
  where.push("coalesce(json_extract(n.frontmatter_json, '$.draft_card'), 0) != 1");

  const rows = ctx.db
    .query<unknown, any[]>(
      `SELECT n.id, n.grp_id AS grpId, n.kind, n.body, n.at, n.export_path AS exportPath,
              n.frontmatter_json AS frontmatter, g.name AS "group"
       FROM note n LEFT JOIN grp g ON g.id = n.grp_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY n.at DESC LIMIT 300`,
    )
    .all(...args);
  return json({ notes: rows });
};

/**
 * Skills the project carries, by path.
 *
 * Agents run with `--disable-slash-commands` and `--setting-sources project,local`
 * on purpose: the skill catalogue is ~46k cached tokens of prefix on every turn, and
 * inheriting the boss's user-level skills measured at ~195k on a trivial haiku turn.
 * So "/impeccable" typed into a requirement would do exactly nothing.
 *
 * What does work is the path: every role has Read, so naming the SKILL.md costs a
 * dozen tokens now and one read later, only in the turn that needs it. This route
 * exists so the composer can offer those paths instead of the boss remembering them.
 */
const getSkills: Handler = async (ctx, req) => {
  const id = Number(new URL(req.url).searchParams.get("project"));
  const repo = ctx.db
    .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
    .get(id)?.repo_path;
  return json({
    skills: listSkills(repo).map(({ name, rel, description, scope }) => ({ name, path: rel, description, scope })),
  });
};

const getDirs: Handler = async (ctx, req) => {
  const asked = new URL(req.url).searchParams.get("path") ?? homedir();
  const path = resolve(expandHome(asked));
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (e) {
    return bad(`${path}: ${(e as Error).message}`);
  }
  const taken = new Set(
    ctx.db.query<{ repo_path: string }, []>("SELECT repo_path FROM project").all().map((r) => r.repo_path),
  );
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const full = join(path, d.name);
      return { name: d.name, path: full, repo: existsSync(join(full, ".git")), taken: taken.has(full) };
    })
    .sort((a, b) => (a.repo === b.repo ? a.name.localeCompare(b.name) : a.repo ? -1 : 1));
  // A repo can be picked at any level, including the one being listed.
  return json({ path, parent: path === "/" ? null : dirname(path), repo: existsSync(join(path, ".git")), dirs });
};

const getStream: Handler = async (ctx, req) => {
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
  let unsub = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      const raw = (s: string) => {
        try {
          c.enqueue(enc.encode(s));
          return true;
        } catch {
          unsub();
          if (beat) clearInterval(beat);
          return false;
        }
      };
      // Which project a frame belongs to, so the feed can be scoped. grp -> project
      // is immutable, so it is cached rather than queried per frame — live frames
      // arrive per token.
      const ofGrp = new Map<number, number | null>();
      const projectOf = (grpId: number | null | undefined): number | null => {
        if (grpId == null) return null;
        if (!ofGrp.has(grpId)) {
          ofGrp.set(
            grpId,
            ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
              ?.project_id ?? null,
          );
        }
        return ofGrp.get(grpId) ?? null;
      };
      const send = (data: any) =>
        raw(`data: ${JSON.stringify({ ...data, projectId: data.projectId ?? projectOf(data.grpId) })}\n\n`);

      // A stream that sends nothing has sent no bytes, and a browser does not
      // report a byteless response as open — the UI sat on "connecting…" forever
      // on a fresh database with no events to replay. The comment also defeats
      // proxy buffering, and `retry` sets the reconnect delay.
      raw(`retry: 3000\n: connected\n\n`);

      for (const e of ctx.bus.since(since)) send({ type: "event", ...e });
      unsub = ctx.bus.subscribe(send);
      beat = setInterval(() => raw(`: ping\n\n`), SSE_HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => {
        unsub();
        if (beat) clearInterval(beat);
        try {
          c.close();
        } catch {}
      });
    },
    cancel() {
      unsub();
      if (beat) clearInterval(beat);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
};

// ---------------------------------------------------------------------- router

const ROUTES: Array<[string, RegExp, Handler]> = [
  ["POST", /^\/orch\/status$/, postStatus],
  ["POST", /^\/orch\/journal$/, postJournal],
  ["POST", /^\/orch\/mail$/, postMail],
  ["POST", /^\/orch\/ask-boss$/, postAskBoss],
  ["POST", /^\/orch\/lease$/, postLease],
  ["GET", /^\/orch\/lease\/(?<id>\d+)\/log$/, getLeaseLog],
  ["POST", /^\/orch\/git$/, postGit],
  ["POST", /^\/orch\/ctx\/query$/, postCtxQuery],
  ["GET", /^\/orch\/task$/, getTasks],
  ["POST", /^\/orch\/task\/claim$/, postTaskClaim],
  ["POST", /^\/orch\/task\/done$/, postTaskDone],
  ["POST", /^\/orch\/review$/, postReview],
  ["POST", /^\/orch\/audit$/, postAudit],
  ["POST", /^\/orch\/answer$/, postAnswer2],
  ["POST", /^\/orch\/triage$/, postTriage],
  ["POST", /^\/orch\/draft$/, postDraft],
  ["POST", /^\/orch\/owns$/, postOwns],
  ["POST", /^\/orch\/split$/, postSplit],

  ["GET", /^\/api\/state$/, getState],
  ["GET", /^\/api\/cost$/, getCost],
  ["GET", /^\/api\/stream$/, getStream],
  ["GET", /^\/api\/dirs$/, getDirs],
  ["GET", /^\/api\/notes$/, getNotes],
  ["GET", /^\/api\/skills$/, getSkills],
  ["POST", /^\/api\/projects$/, postProject],
  ["POST", /^\/api\/ideas$/, postIdea],
  ["POST", /^\/api\/attach$/, postAttach],
  ["POST", /^\/api\/say$/, postSay],
  ["POST", /^\/api\/draft\/(?<id>\d+)\/(?<decision>approve|reject)$/, postDraftDecision],
  ["POST", /^\/api\/groups\/(?<id>\d+)\/(?<action>pause|resume|park|wake|interrupt|landed|budget)$/, postGroupControl],
  ["GET", /^\/api\/slices\/(?<id>\d+)\/evidence$/, getEvidence],
  ["GET", /^\/api\/slices\/(?<id>\d+)\/gate\/(?<name>[\w.-]+)$/, getGateLog],
  ["POST", /^\/api\/slices\/(?<id>\d+)\/(?<decision>accept|reject)$/, postSliceDecision],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/answer$/, postAnswer],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/revoke$/, postRevoke],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/delegate$/, postDelegate],
];

export function makeApp(ctx: Ctx): (req: Request) => Promise<Response> {
  return async (req) => {
    const path = new URL(req.url).pathname;
    for (const [method, re, h] of ROUTES) {
      if (req.method !== method) continue;
      const m = re.exec(path);
      if (!m) continue;
      try {
        return await h(ctx, req, (m.groups ?? {}) as Record<string, string>);
      } catch (e: any) {
        return text(`error: ${e?.message ?? e}`, 500);
      }
    }
    return text("not found", 404);
  };
}

/**
 * A short, branch-shaped name.
 *
 * This ends up in `orch/<name>`, a worktree path and every log line, so a
 * slugified 40-character sentence is a nuisance forever. Prefer the ASCII words
 * (usually the identifiers the idea is about) and fall back to a trimmed slug.
 */
function slug(text: string): string {
  const ascii = (text.toLowerCase().match(/[a-z][a-z0-9._-]{1,}/g) ?? [])
    .filter((w) => !STOP.has(w))
    .slice(0, 3)
    .join("-")
    .replace(/[._]+/g, "-");
  if (ascii.length >= 3) return ascii.slice(0, 28);
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "idea"
  );
}

const STOP = new Set(["the", "a", "an", "and", "for", "with", "add", "to", "of", "in", "on"]);
