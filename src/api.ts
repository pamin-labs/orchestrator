import { basename, dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dropSlices, type DB } from "./db.ts";
import type { Bus } from "./bus.ts";
import { poolSizes, type Scheduler } from "./scheduler.ts";
import { resolveLease, type ResourceDef } from "./mech/sandbox/lease.ts";
import { sliceDiffBase } from "./mech/git/worktree.ts";
import { execIn, killSandbox, putFile, relinkSkills, restartServer, runningServer, serverAddr, serverKeyOnDisk, skillMounts, specFor, WORK } from "./mech/sandbox/sandbox.ts";
import { resetServerRestarts } from "./mech/ops/watchdog.ts";
import { clearSandboxLog, sandboxLines } from "./mech/sandbox/sandboxlog.ts";
import { listAuth, loadAuth, SANDBOX_KEY, saveAuth, wrongShape } from "./mech/sandbox/auth.ts";
import { DEVICE_CODE_TTL_MS, PASTE_TTL_MS, startClaudeLogin, startCodexDeviceLogin } from "./mech/sandbox/login.ts";
import { APP_SLUG, githubAccount, listInstallations, listRepos, pollForToken, startDeviceFlow, type Installation } from "./mech/git/ghlogin.ts";
import { preflight } from "./mech/ops/preflight.ts";
import { driftingPaths, ensureServer, inspectServer, ourArgv, serverLogPath, serverLogTail, setServerAddr } from "./mech/sandbox/server.ts";
import { baseBranch, baseRefFor, listBranches, removeMirror, sandboxGit, treeFiles } from "./mech/git/checkout.ts";
import { interrupt, park, pause, resume, unpark } from "./mech/flow/intercept.ts";
import { abstain, answer as chainAnswer, CHAIN, entryPoint, revoke, route, triage, type Triage } from "./mech/flow/chain.ts";
import { canStart, claimsShared, overlaps, parseOwns, sharedFor } from "./mech/flow/ownership.ts";
import { extractClaimedFiles } from "./mech/flow/reconcile.ts";
import { acceptSlice } from "./mech/flow/review.ts";
import { dropGroup, runInstall, startGroup, sweepApproved } from "./mech/flow/start.ts";
import { head, joinQueue, landed, position } from "./mech/flow/mergequeue.ts";
import { costReport } from "./mech/ops/cost.ts";
import { openPr, prBody, pushBlocked } from "./mech/git/prwatch.ts";
import { forgetHolds } from "./mech/git/github.ts";
import { query as ctxQuery, DEFAULT_BUDGET } from "./mech/knowledge/ctx.ts";
import { loadTree, NOTE_PREFIX, render, search, type Ask } from "./mech/knowledge/pageindex.ts";
import { gatesFor, recordGate } from "./mech/flow/gate.ts";
import { forgetProjectSkills, listSkills, projectSkills, projectSkillsPending, restageSkills, setSkillOff, skillNames, skillsOff } from "./mech/util/skills.ts";
import { shq } from "./mech/util/shq.ts";
import { abortJob } from "./runtime/running.ts";
import { sediment } from "./mech/knowledge/lessons.ts";
import { say } from "./lang.ts";
import { criteriaIn, validateDraftCard, validateJournal, validateSelfReview } from "./mech/flow/validate.ts";

/**
 * One API, two clients: the web UI (the boss's main surface) and `orch` (what
 * agents call over Bash). Anything the web can do has an `orch` verb and vice
 * versa — there is deliberately no second implementation anywhere.
 */

export interface Ctx {
  db: DB;
  bus: Bus;
  sched: Scheduler;
  /** Resolves a blocking `ask-boss` / `lease` call. Keyed by "kind:id". */
  waiters: Map<string, (value: string) => void>;
  /** Where turns, gates and leases run. Absent in unit tests that need no container. */
  sandbox?: import("./mech/sandbox/sandbox.ts").SandboxDriver;
  /** Talks to GitHub's REST API. Absent in unit tests that need no GitHub. */
  gh?: import("./mech/git/github.ts").Github;
  /**
   * One cheap model call, for PageIndex navigation. Absent in unit tests.
   *
   * A factory, not a closure, because the call runs **in a sandbox** and which
   * one depends on the project. It used to be a host `Bun.spawn` with the boss's
   * own CLI login — a second credential path nothing in the settings page could
   * see, whose failure mode was a permanently empty index that looked built.
   */
  askIn?: (scope: import("./mech/sandbox/sandbox.ts").Scope) => Ask;
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
    /** difficulty -> token cap written onto each new slice. */
    sliceBudgetTokens?: Record<string, number>;
    dataDir?: string;
    /** Where ticked skills are staged for the sandboxes to mount. */
    skillsDir?: string;
    autoAdvance?: boolean;
    autoAcceptTiers?: string[];
    /** Surfaced to the panel: how many groups may run at once, and lease slots. */
    maxGroups?: number;
    leaseSlots?: number | Record<string, number>;
    /** Same complaint this many times becomes a project rule (PLAN.md §7③). */
    feedbackSediment?: number;
    /** Chars an `orch ctx query` answer may spend. Was a setting that changed nothing. */
    ctxBudgetChars?: number;
    /** How long a gate may run. The lease route waits a minute longer than this. */
    leaseTimeoutMs?: number;
    /** Where the orchestrator listens; the mailbox replays agent calls to it. */
    port?: number;
    /** Wall clock for a dependency install. See config.ts for why it is generous. */
    installTimeoutMs?: number;
    /** Where turns run. See mech/sandbox/sandbox.ts and docs/decisions/005. */
    sandbox?: {
      server: string;
      apiKey: string;
      image: string;
      cpu: string;
      memory: string;
      ttlSeconds: number;
      denyDomains: string[];
      cacheDirs: Record<string, string>;
    };
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
  project_id: number | null;
  role: string;
}

/**
 * May this caller act on that group?
 *
 * The token says who is calling; several routes then take a `group_id` from the
 * body and never compared the two. Any Architect could rewrite any group's
 * `owns_json` — which `canStart` reads to gate dispatch, so one call stalls a
 * whole fleet — and any Dispatcher could flip another group to DRAFT and cancel
 * its queued turns.
 *
 * Not a flat "same group": standing roles have no group and are *supposed* to
 * reach across a project. So the scope is whichever the caller has — its group
 * if it is in one, its project if it is not.
 */
export function mayAct(ctx: Ctx, me: Caller, grpId: number): boolean {
  if (me.grp_id !== null) return me.grp_id === grpId;
  if (me.project_id === null) return false;
  const g = ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId);
  return g?.project_id === me.project_id;
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
      .query<Caller, [string]>("SELECT id, grp_id, project_id, role FROM agent WHERE token = ?")
      .get(token) ?? null
  );
}

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

/** A fresh token for a newly hired agent. */
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
        .query<{ name: string; project_id: number }, [number]>(
          "SELECT name, project_id FROM grp WHERE id = ?",
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
  if ((v.kind === "journal" || v.kind === "retro" || v.kind === "decision") && a.grp_id) {
    const seq = ctx.db
      .query<{ c: number }, [number]>("SELECT count(*) AS c FROM note WHERE grp_id = ?")
      .get(a.grp_id!)!.c;
    exportPath = join("docs", "journal", grp!.name, `${String(seq + 1).padStart(3, "0")}-${v.kind}.md`);
    const fm = Object.entries(frontmatter)
      .map(([k, val]) => `${k}: ${Array.isArray(val) ? `[${val.join(", ")}]` : val}`)
      .join("\n");
    // Into the sandbox's checkout, so it merges with the PR like any other file.
    // Quoted: the path carries `grp.name`, and a group can name its own children
    // (`orch split`). Unquoted this was one `;` away from being a command.
    await execIn(ctx, { grp: a.grp_id }, `mkdir -p ${shq(`${WORK}/${dirname(exportPath)}`)}`);
    await putFile(ctx, { grp: a.grp_id }, `${WORK}/${exportPath}`, `---\n${fm}\n---\n${v.body}\n`);
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

/**
 * The line the queue shows.
 *
 * Asked for with `--brief`, because the agent knows what its question is about
 * and the queue cannot work it out from prose written for another agent. Derived
 * when it is missing rather than rejected: a question that cannot be filed is an
 * agent stuck on a formatting rule, and the fallback is right often enough — the
 * first sentence of a question usually names the problem.
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

const postAskBoss: Handler = async (ctx, req) => {
  const b = await body<{ severity?: string; question: string; brief?: string; kind?: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
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

  route({ ctx, notifyBoss: ctx.notifyBoss }, row.id);

  const answer = await new Promise<string>((resolve) => {
    ctx.waiters.set(`escalation:${row.id}`, resolve);
  });
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ?", [a.id]);
  return text(answer);
};

/**
 * The bootstrap role's one verb: make this checkout buildable.
 *
 * The command comes from the agent because nobody can enumerate them — bun,
 * poetry, uv, mise, a Makefile target — and the repo says which one it is. It
 * used to be checked against a list of package-manager names before running on
 * the host; it runs inside the group's own sandbox now, so what it *is* stopped
 * mattering. What is worth keeping is the answer, so the next group does not pay
 * to read the same repo again.
 */
const postSetup: Handler = async (ctx, req) => {
  const b = await body<{ cmd?: string; none?: boolean }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "bootstrap") return bad(`${a.role} does not set this project up`);
  if (!a.grp_id) return bad("this agent has no group");
  const grp = ctx.db
    .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
    .get(a.grp_id);
  if (!grp) return bad("this agent has no group");

  if (b.none) {
    ctx.db.run(
      "UPDATE project SET config_json = json_set(config_json, '$.install', json('null')) WHERE id = ?",
      [grp.project_id],
    );
    ctx.bus.emit({ grpId: a.grp_id, author: a.role, kind: "state_change", body: "这个仓库不需要装什么" });
    return text("ok");
  }

  const cmd = (b.cmd ?? "").trim();
  if (!cmd) return bad('setup needs --cmd "<command>" or --none');
  // Same streamed install the first turn gets: the boss watches this one too,
  // and an agent's own attempt is the one most likely to need watching.
  const r = await runInstall(ctx, a.grp_id, cmd);
  // Remembered on the project, so the next group does not pay for the same
  // reading — and so the boss can see and correct what its groups run.
  if (r.ok) {
    ctx.db.run("UPDATE project SET config_json = json_set(config_json, '$.install', ?) WHERE id = ?", [
      cmd,
      grp.project_id,
    ]);
  }
  return r.ok ? text("ok") : bad(`install failed:\n${r.tail}`);
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

  // A deadline, because "the agent waits forever" is the worst state in the
  // system and `finishLease` is not the only way to reach it. Every path through
  // `runLease` resolves this now — but a job that is *cancelled* never reaches
  // `runLease` at all (watchdog rule 9 cancels a dropped group's queue), so the
  // waiter would still be there with nothing left to answer it. This is the
  // backstop for the paths nobody has thought of yet, and it is the difference
  // between one failed gate and an agent that never takes another turn.
  //
  // Longer than the lease's own timeout: a gate that is legitimately slow must
  // finish and answer rather than be cut off by the thing waiting for it.
  const deadline = (ctx.config?.leaseTimeoutMs ?? 10_800_000) + 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const digest = await new Promise<string>((resolve) => {
    ctx.waiters.set(`lease:${row.id}`, resolve);
    // `unref`, or this three-hour timer is a reason the process cannot exit —
    // which a test run finds first, and a shutdown finds later.
    timer = setTimeout(
      () => resolve(`lease ${row.id} never reported back within ${Math.round(deadline / 1000)}s — treat it as not run`),
      deadline,
    );
    timer.unref?.();
  });
  clearTimeout(timer);
  ctx.waiters.delete(`lease:${row.id}`);
  ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ?", [a.id]);
  return text(digest);
};

const getLeaseLog: Handler = async (ctx, req, params) => {
  // Whose lease this is. Unchecked, any sandbox could read any group's build log
  // by counting up from 1 — the `/orch/` prefix gate on the mailbox is about
  // which routes are reachable, not about who is reaching them.
  const me = agentOf(ctx, req);
  if (!me) return text("no agent", 401);
  const row = ctx.db
    .query<{ log_path: string | null; grp_id: number | null }, [number]>(
      "SELECT log_path, grp_id FROM lease WHERE id = ?",
    )
    .get(Number(params.id));
  if (!row?.log_path) return text("no log", 404);
  if (row.grp_id !== me.grp_id) return text("not this group's lease", 403);
  const raw = await Bun.file(row.log_path).text();
  // A substring, not a regex. `new RegExp` on an agent-supplied string runs on the
  // host, in the single process everything else is waiting on, and one nested
  // quantifier stalls the whole orchestrator. Nobody greps a build log for
  // anything a substring cannot find.
  const grep = new URL(req.url).searchParams.get("grep");
  if (!grep) return text(raw.split("\n").slice(-200).join("\n"));
  return text(
    raw
      .split("\n")
      .filter((l) => l.includes(grep))
      .slice(0, 200)
      .join("\n"),
  );
};

const postAnswer2: Handler = async (ctx, req) => {
  const b = await body<{ escalation_id: number; answer?: string; abstain?: boolean; why?: string; ref?: number }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
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

const postTriage: Handler = async (ctx, req) => {
  const b = await body<{ group_id: number | string; as: string; note?: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "cos") return bad(`${a.role} does not triage the boss's feedback`);
  if (!["patch", "respec", "reject"].includes(b.as)) return bad("as must be patch, respec or reject");
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
const postEscalationRequirement: Handler = async (ctx, req, params) => {
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

const postRevoke: Handler = async (ctx, _req, params) => {
  const out = await revoke({ ctx }, Number(params.id));
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
  if (!mayAct(ctx, a, grpId)) return text("not your group", 403);
  const grp = ctx.db
    .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
    .get(grpId);
  if (!grp) return bad(`no group ${grpId}`);

  // Paths the card names that are not in the repo.
  //
  // Not a refusal — a card that plans a new file names it, and that is the whole
  // point of planning. But a plan written from memory of a codebase rather than
  // from reading it names files that were never there, and that is the cheapest
  // detectable symptom of the one failure with no deterministic line under it
  // (PLAN.md §13 risk ①): a decomposition pointed the wrong way. The boss gets the
  // list beside the card and decides which it is, in the same 20 seconds.
  //
  // Against the base ref rather than what is on disk: the host checkout sits on
  // whatever branch the boss last had out, so `existsSync` was asking a working
  // tree nobody planned against, and the answer moved when the boss switched
  // branches. `ls-tree` of the base is the same thing the group will be cut from.
  const remote = ctx.db
    .query<{ remote: string | null }, [number]>("SELECT remote FROM project WHERE id = ?")
    .get(grp.project_id)?.remote;
  const claimed = extractClaimedFiles([b.card]);
  let unknown: string[] = [];
  if (remote && claimed.length) {
    // Out of the utility container's mirror, not a checkout on this host: there
    // is none since step 6, and asking one that was not there threw rather than
    // returning a code — which is how this handler used to 500 with the DRAFT
    // card unfiled and nothing saying so.
    const inBase = new Set(await treeFiles(ctx, remote, await baseRefFor(ctx, grp.project_id)));
    if (inBase.size) unknown = claimed.filter((p) => !inBase.has(p)).slice(0, 8);
  }

  ctx.db.run(
    `INSERT INTO note (project_id, grp_id, kind, lang, body, frontmatter_json, at)
     VALUES (?, ?, 'fact', ?, ?, ?, unixepoch() * 1000)`,
    [
      grp.project_id,
      grpId,
      ctx.config.language,
      b.card,
      JSON.stringify({ draft_card: true, ...(unknown.length ? { unknownPaths: unknown } : {}) }),
    ],
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
 * Only before work exists. After a card is approved there is a branch and a checkout,
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
  if (!mayAct(ctx, a, gid)) return text("not your group", 403);
  const grp = ctx.db
    .query<{ project_id: number; name: string; status: string; branch: string | null }, [number]>(
      "SELECT project_id, name, status, branch FROM grp WHERE id = ?",
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
  if (hasWork > 0 || grp.branch) return bad(`${grp.name} already has slices or a branch; split before that`);

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
    // Slugged even when the agent supplied it. A group name becomes a branch
    // (`orch/<name>`), a path under docs/journal and an argument to host git —
    // "whatever 40 characters an agent felt like" is not a shape any of those want.
    const name = slug(item.name?.trim() || item.idea);
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

/**
 * "This is already done." The one thing a planner could not say.
 *
 * A requirement that is a duplicate, or that someone fixed between the boss
 * typing it and the Dispatcher reading the code, has no exit: the Dispatcher digs
 * in, slices it, and files a card for work that does not need doing. The only
 * thing standing between that and a group burning a day on it is the boss's 20
 * seconds on the DRAFT card — PLAN.md §13's risk ①, and the one judgement in the
 * system with no deterministic line under it.
 *
 * This is not the agent dissolving the group. It cannot be: "there is nothing to
 * do here" is the single most attractive thing a tired model can conclude, and no
 * prompt survives being the cheap way out. So it is a proposal, it costs evidence
 * the server checks itself — a commit that is really in the repo, or a group that
 * really exists — and the boss presses the button.
 */
const postDrop: Handler = async (ctx, req) => {
  const b = await body<{ group_id?: number | string; why?: string; commit?: string; duplicate?: number | string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (!["dispatcher", "pm", "architect"].includes(a.role)) return bad(`${a.role} does not propose dropping work`);
  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your group", 403);
  const why = (b.why ?? "").trim();
  if (why.length < 10) return bad("--why has to say what already covers it, in a sentence");

  // Evidence the server can check. A sentence alone is a model's opinion of its
  // own workload, which is exactly what must not be able to close a requirement.
  let evidence: string;
  if (b.duplicate != null) {
    const dup = resolveGroup(ctx, b.duplicate);
    if (!dup) return bad(`no group ${b.duplicate}`);
    if (dup === gid) return bad("a group cannot be a duplicate of itself");
    const d = ctx.db.query<{ name: string }, [number]>("SELECT name FROM grp WHERE id = ?").get(dup)!;
    evidence = `duplicate of ${d.name} (grp ${dup})`;
  } else if (b.commit) {
    const sha = String(b.commit).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return bad("--commit takes a sha, 7 to 40 hex characters");
    // Checked where the agent read it: its own clone. Against the host checkout
    // this asked a repository the caller has never seen — a sha that exists only
    // on the group's branch is not there at all, and the ancestry test below ran
    // against the boss's local `HEAD`, so the verdict changed with whatever branch
    // the boss happened to have checked out.
    const git = sandboxGit(ctx, { grp: gid });
    const r = await git(WORK, ["cat-file", "-t", sha], WORK);
    if (r.code !== 0 || r.out.trim() !== "commit") return bad(`${sha} is not a commit in this repo`);
    // And it has to be on the main line. Any real sha passes cat-file, including
    // one on an abandoned branch or on the group's own unmerged work — "it is
    // already done" means done where everyone can see it.
    const projectId = ctx.db
      .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
      .get(gid)?.project_id;
    if (!projectId) return bad("no such group");
    const base = await baseRefFor(ctx, projectId);
    const merged = await git(WORK, ["merge-base", "--is-ancestor", sha, base], WORK);
    if (merged.code !== 0) return bad(`${sha.slice(0, 8)} is a real commit but is not on ${base} yet`);
    evidence = `already landed in ${sha.slice(0, 8)}`;
  } else {
    return bad("give evidence: --duplicate <group> or --commit <sha>");
  }

  ctx.db.run(
    `INSERT INTO note (project_id, grp_id, kind, lang, body, frontmatter_json, at)
     VALUES ((SELECT project_id FROM grp WHERE id = ?), ?, 'decision', ?, ?, ?, unixepoch() * 1000)`,
    [gid, gid, ctx.config.language, `${why}\n\n证据：${evidence}`, JSON.stringify({ drop_proposal: 1 })],
  );
  // DRAFT, so the group stops being dispatchable and the boss is asked. Left in
  // PLANNING the Dispatcher would be woken again and re-propose the same thing.
  ctx.db.run("UPDATE grp SET status = 'DRAFT' WHERE id = ? AND status = 'PLANNING'", [gid]);
  ctx.bus.emit({
    grpId: gid,
    author: a.role,
    kind: "decision",
    intent: "decision",
    body: `建议作废：${why}（${evidence}）`,
    meta: { drop_proposal: true, evidence },
  });
  return text("ok");
};

/**
 * "I am blocked by something I am not allowed to touch."
 *
 * The gap this closes, seen whole: pm-ai-agent's gate failed on a missing line in
 * `tsconfig.json`. The file is not in its `owns`, so the sandbox refused the write.
 * It could not open a requirement for it — there was no verb. It could not hand it
 * to whoever owns it — `orch mail` is a message, and a message creates no work. So
 * it rewrote its own code three times, hit the retry ceiling, escalated, and
 * stopped. The boss got a blocker with no button on it, and four other groups sat
 * red on the same line.
 *
 * The evidence is the path itself: the server checks the file exists and is
 * genuinely outside this group's boundary. "I cannot reach it" is a fact about the
 * repository, not a claim about how hard the work is — which is the difference
 * between this and a way out of difficult work.
 *
 * Where it goes is decided here, not by the agent: a live group that owns the path
 * gets it as an addition, and if nobody owns it, it becomes a requirement the boss
 * approves like any other. Either way the caller records what it is waiting on and
 * stops, and the watchdog starts it again when that lands.
 */
const postBlocked: Handler = async (ctx, req) => {
  const b = await body<{ group_id?: number | string; path?: string; why?: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your group", 403);
  const path = (b.path ?? "").trim().replace(/^\.\//, "");
  const why = (b.why ?? "").trim();
  if (!path) return bad("--path <file> — which file you cannot change");
  if (why.length < 10) return bad("--why has to say what is wrong with it, in a sentence");

  const me = ctx.db
    .query<{ project_id: number; name: string; owns_json: string }, [number]>(
      "SELECT project_id, name, owns_json FROM grp WHERE id = ?",
    )
    .get(gid);
  if (!me) return bad("no such group");
  // In the group's own checkout, not the host's. The caller named this path from
  // inside `/work`, and the host main checkout sits on whatever the boss last had
  // out — so a file the group created, or one that exists only on its branch,
  // came back as "not a file in this repo", which is both wrong and misleading.
  const seen = await execIn(ctx, { grp: gid }, `test -e ${shq(`${WORK}/${path}`)}`);
  if (seen.code !== 0) return bad(`${path} is not a file in your checkout`);
  // The whole justification. Inside its own boundary the group is expected to fix
  // it, and saying otherwise is the cheap way out of difficult work.
  if (parseOwns(me.owns_json).some((o) => overlaps(o, path))) {
    return bad(`${path} is inside your own boundary — fix it`);
  }

  const owner = ctx.db
    .query<{ id: number; name: string; owns_json: string }, [number, number]>(
      `SELECT id, name, owns_json FROM grp WHERE project_id = ? AND id != ?
         AND status IN ('PLANNING','RUNNING','PAUSING','PAUSED','PARKED','PR_OPEN')`,
    )
    .all(me.project_id, gid)
    .find((o) => parseOwns(o.owns_json).some((glob) => overlaps(glob, path)));

  // Two groups each waiting on the other is two groups that never move again, and
  // nothing downstream would notice: both are PAUSED for a stated reason, and the
  // reason is each other.
  if (owner) {
    for (let at: number | null = owner.id, hops = 0; at && hops < 32; hops++) {
      if (at === gid) return bad(`${owner.name} is already waiting on you — one of you has to go first`);
      at = ctx.db.query<{ blocked_on: number | null }, [number]>("SELECT blocked_on FROM grp WHERE id = ?").get(at)
        ?.blocked_on ?? null;
    }
  }

  let target: number;
  if (owner) {
    // Somebody live already owns it. A second group for the same file would be
    // refused by canStart anyway, so this is an addition to their work.
    target = owner.id;
    ctx.bus.emit({
      grpId: owner.id,
      author: a.role,
      kind: "say",
      intent: "request",
      body: `${me.name} 被 ${path} 挡住了，那是你们的路径：${why}`,
      meta: { from_group: gid, path },
    });
    ctx.sched.enqueue("agent_turn", {
      grp_id: owner.id,
      priority: 6,
      payload: {
        role: "pm",
        rejection: `Another group is blocked on ${path}, which is inside your boundary: ${why}\n\nAdd it to this group's work.`,
      },
    });
  } else {
    const name = slug(`${path} ${why}`).slice(0, 40) || `fix-${gid}`;
    // A shared file — package.json, tsconfig.json, the migrations array — belongs
    // to no group on purpose, and a requirement opened for one could never start:
    // the boundary can only be the file itself, and canStart refuses exactly that.
    // The grant names this one path for this one group, so everybody else is still
    // refused, and the boundary is settled here rather than costing an Architect
    // turn to discover there is only one answer.
    const grant = claimsShared([path], sharedFor(ctx.db, me.project_id));
    const grp = ctx.db
      .query<{ id: number }, [number, string, string | null, string]>(
        `INSERT INTO grp (project_id, name, status, shared_grant, owns_json, created_at)
         VALUES (?, ?, 'PLANNING', ?, ?, unixepoch() * 1000) RETURNING id`,
      )
      .get(me.project_id, name, grant.length ? JSON.stringify(grant) : null, JSON.stringify([path]))!;
    ctx.db.run(
      "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (?, ?, 'group', unixepoch() * 1000)",
      [me.project_id, grp.id],
    );
    const idea = `${why}\n\n（${me.name} 报的：${path} 不在它的边界内，它改不了）`;
    ctx.db.run(
      "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
      [me.project_id, grp.id, ctx.config.language, idea],
    );
    // boss_say, because that is what every planner reads as the requirement, and a
    // second shape for "this is the ask" would be a second thing to remember.
    ctx.bus.emit({ grpId: grp.id, author: a.role, kind: "boss_say", intent: "request", body: idea });
    ctx.sched.enqueue("agent_turn", { grp_id: grp.id, priority: 6, payload: { role: "dispatcher", idea } });
    target = grp.id;
  }

  // Stop, and say what it is waiting for. PAUSED rather than a spin: a group with
  // nothing it can legally do should not hold a concurrency slot.
  ctx.db.run(
    "UPDATE grp SET status = 'PAUSED', paused_at = unixepoch() * 1000, blocked_on = ? WHERE id = ?",
    [target, gid],
  );
  ctx.sched.cancelPending(gid, `blocked on ${path}`);
  ctx.bus.emit({
    grpId: gid,
    author: a.role,
    kind: "state_change",
    body: say(ctx.config?.language, "group.blocked", { path, target: String(target) }),
    meta: { blocked_on: target, path },
  });
  ctx.sched.tick();
  return json({ blocked_on: target, handedTo: owner ? owner.name : "a new requirement" });
};

const postOwns: Handler = async (ctx, req) => {
  const b = await body<{ group_id: number | string; paths: string[] }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "architect") return bad(`${a.role} does not cut boundaries`);
  if (!Array.isArray(b.paths) || b.paths.length === 0) return bad("give at least one path glob");
  const gid = resolveGroup(ctx, b.group_id, a.grp_id);
  if (!gid) return bad("which group? pass its id or name");
  if (!mayAct(ctx, a, gid)) return text("not your group", 403);

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
  // A re-cut can free a group other than the one it touched, so the whole project
  // is swept. Without this the boss's approval sat waiting on a boundary that had
  // already been drawn.
  await sweepApproved(ctx);
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
  // the one role whose group check is inverted. It is still bounded by its
  // project — a pass here opens a PR, which is a host `git push`, and that is not
  // an action to leave addressable by any group id an agent cares to name.
  if (a.grp_id === gid) return bad("an auditor may not audit its own group");
  if (!mayAct(ctx, a, gid)) return text("not your project", 403);

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

const postCtxQuery: Handler = async (ctx, req) => {
  const b = await body<{ question: string; limit?: number }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  const projectId =
    ctx.db
      .query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?")
      .get(a.id)?.project_id ?? null;
  // PageIndex: a model walks the summary tree and can land on a file whose name
  // shares no word with the question. It costs one cheap call, against grep rounds
  // that each re-read the agent's whole transcript. No tree yet, or a navigator
  // that fails, falls through to the lexical map inside ctxQuery.
  let where = "";
  const tree = loadTree(ctx.db, projectId);
  if (tree && ctx.askIn && projectId) {
    try {
      // In the caller's own sandbox, not the project's.
      //
      // The walk reads nothing from a checkout: the menu is built from summaries
      // already in the database and the model answers with ids. So the container
      // it runs in cannot change the answer — and routing every group's query into
      // the one project sandbox would put ten agents' first step through a single
      // container with a single CPU quota, on the step `assemble.ts` tells every
      // role to take FIRST. The index *build* stays project-scoped; it is shared
      // work and there is one of it.
      const scope = a.grp_id ? { grp: a.grp_id } : { project: projectId };
      const hits = await search(tree, b.question, ctx.askIn(scope));
      if (hits.length) {
        where = render(tree, hits);
        // A note the walk landed on is the answer, not a pointer to it: journals and
        // retros are already short, and making the agent go and fetch one costs
        // another round, which is the thing this whole path exists to avoid.
        const noteIds = hits.filter((h) => h.startsWith(NOTE_PREFIX)).map((h) => Number(h.split("/").pop()));
        for (const id of noteIds) {
          const n = ctx.db
            .query<{ kind: string; body: string }, [number]>("SELECT kind, body FROM note WHERE id = ?")
            .get(id);
          if (n) where += `\n\n### ${n.kind} #${id}\n${n.body.slice(0, 1200)}`;
        }
      }
    } catch {}
  }
  return text(
    ctxQuery({
      db: ctx.db,
      grpId: a.grp_id,
      projectId,
      question: b.question,
      where,
      // From config, not the module default: `ctxBudgetChars` was a setting that
      // read back as itself and changed nothing, because nobody ever passed it here.
      budget: b.limit ?? ctx.config.ctxBudgetChars ?? CTX_BUDGET_CHARS,
    }),
  );
};

export const CTX_BUDGET_CHARS = DEFAULT_BUDGET;

const getTasks: Handler = async (ctx, req) => {
  // The caller's own group, not the one it asked for. Every other `/orch` route
  // checks the token; these two never did, and the `/orch/` prefix gate on the
  // mailbox made them look as if they had — so any sandbox could enumerate any
  // group's cards by putting a number in a query string.
  const me = agentOf(ctx, req);
  if (!me?.grp_id) return text("no agent", 401);
  const grp = me.grp_id;
  // Only the slice being worked, plus anything not tied to a slice. Showing the
  // whole plan's tasks let the writer mark future slices done, which pushed
  // slices that had never started into review.
  const rows = ctx.db
    .query<
      {
        id: number;
        title: string;
        status: string;
        slice_id: number | null;
        owner: string | null;
        claim_json: string | null;
      },
      [number]
    >(
      // The owner is only shown when it is someone who can still act. A retired
      // row rendered as `engineer` reads as "another engineer has this", and the
      // writer's own name for itself is `engineer` too — so the list said the card
      // was taken, by nobody, forever.
      `SELECT t.id, t.title, t.status, t.slice_id, t.claim_json,
              (SELECT a.role FROM agent a WHERE a.id = t.owner_agent_id AND a.state != 'retired') AS owner
       FROM task t
       WHERE t.grp_id = ?
         AND (t.slice_id IS NULL
              OR t.slice_id IN (SELECT id FROM slice WHERE grp_id = t.grp_id AND status NOT IN ('pending','accepted')))
       ORDER BY t.id`,
    )
    .all(grp);
  // Why the list is short, in the list itself.
  //
  // Slices run in order, so a later slice sits `pending` and its cards are filtered
  // out above. From inside a turn that is indistinguishable from cards that were
  // never written, and an agent that cannot tell the difference does the reasonable
  // thing: it asks the boss to create them. Measured once and it cost a blocker
  // escalation, a suspended group and 12 minutes of the boss's queue — for a state
  // that was correct the whole time. Prompt wording cannot fix this; the answer has
  // to be where the question is asked.
  const later = ctx.db
    .query<{ seq: number; n: number }, [number]>(
      `SELECT s.seq AS seq, count(t.id) AS n
       FROM slice s JOIN task t ON t.slice_id = s.id
       WHERE s.grp_id = ? AND s.status = 'pending'
       GROUP BY s.id ORDER BY s.seq`,
    )
    .all(grp);
  const gated = later.length
    ? `\n${later.map((l) => `S${l.seq}: ${l.n} cards, not yet open`).join("\n")}\n` +
      "Later slices open one at a time, after the slice before them is accepted. " +
      "Their cards appear here by themselves — do not ask the boss to create or dispatch them."
    : "";
  // A card that was delivered once and sent back for a retry.
  //
  // The work is almost always still on the branch — the retry is usually about one
  // failing criterion, not about the whole slice. A writer that cannot tell a fresh
  // card from a reopened one starts over, and then spends the turn fighting its own
  // earlier commit. `--already-done` is the exit and it exists; it only gets used if
  // it is named here, next to the card, for the same reason the note above exists.
  const reopened = rows.filter((r) => r.status === "pending" && r.claim_json);
  const redo = reopened.length
    ? "\n" +
      reopened
        .map((r) => {
          let claim: unknown = null;
          try { claim = JSON.parse(r.claim_json!); } catch {}
          const files = extractClaimedFiles([claim]).slice(0, 6).join(", ");
          return `task ${r.id} was delivered once already${files ? `, touching ${files}` : ""}`;
        })
        .join("\n") +
      "\nCheck the branch before you rewrite anything — `git log origin/main..HEAD` and " +
      "`git diff origin/main...HEAD`. If the work is still there and still right, claim the card " +
      'and close it with `--already-done "<what is on the branch>"` instead of doing it twice.'
    : "";
  if (rows.length === 0) return text(`no tasks are open in this group right now${gated}`);
  // Lines, not a JSON array. Handing an agent `[{"id":1,"title":"…"}]` invites it
  // to pass the title where an id belongs, which is what happened live.
  return text(
    ["id  status       slice  owner       title", ...rows.map(
      (r) =>
        `${String(r.id).padEnd(4)}${r.status.padEnd(13)}${String(r.slice_id ?? "-").padEnd(7)}` +
        `${(r.owner ?? "-").padEnd(12)}${r.title}`,
    )].join("\n") + redo + gated,
  );
};

const postTaskClaim: Handler = async (ctx, req) => {
  const b = await body<{ task_id: number }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  // A retired owner is not an owner. Ownership is a row id, and a group that
  // rehires its writer — a rotation, a restart, anything that ends one agent row
  // and starts another — leaves its own cards locked to a session that no longer
  // exists. Nothing could ever unlock them, which is how a live group ends up with
  // work it is not allowed to touch.
  const r = ctx.db.run(
    `UPDATE task SET owner_agent_id = ?, status = 'in_progress'
     WHERE id = ? AND (owner_agent_id IS NULL
                       OR owner_agent_id IN (SELECT id FROM agent WHERE state = 'retired'))
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
  // adds a step that gets forgotten. Someone else's task is not — unless that
  // someone else is retired, in which case the card outlived its claimant and the
  // group's current writer is the only one who can finish it. Same reason as claim.
  const claim = b.already_done?.trim()
    ? { already_done: b.already_done.trim(), files: [] }
    : (b.claim as unknown);
  const done = ctx.db.run(
    `UPDATE task SET status = 'done', claim_json = ?, owner_agent_id = ?
     WHERE id = ? AND (owner_agent_id IS NULL OR owner_agent_id = ?
                       OR owner_agent_id IN (SELECT id FROM agent WHERE state = 'retired'))`,
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
    .query<{ id: number; grp_id: number; seq: number; accept_spec: string }, [number]>(
      "SELECT id, grp_id, seq, accept_spec FROM slice WHERE id = ?",
    )
    .get(b.slice_id);
  if (!slice) return bad(`no slice ${b.slice_id}`);
  if (slice.grp_id !== a.grp_id) return bad("that slice belongs to another group");

  // QA's verdict was the one review layer with no floor under it: `--verdict pass`
  // with an empty note was accepted, which makes the independent check a formality
  // and leaves "the acceptance criterion itself was wrong" to surface three slices
  // later. Same validator the Engineer's self-review uses, and the same reason —
  // a verdict per criterion, or it carries no information.
  const need = criteriaIn(slice.accept_spec);
  const v = validateSelfReview(b.note ?? "", need);
  if (!v.ok) {
    return bad(
      `${v.error}\n\nAcceptance for S${slice.seq}: ${slice.accept_spec}\n` +
        `  orch review ${b.slice_id} --verdict ${b.verdict} --note "pass: <criterion> — <what you ran and saw>"`,
    );
  }

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
      {
        name: string; template: string; concurrency: number; arg_schema_json: string;
        error_regex: string | null; cwd: string | null; tags_json: string;
      },
      [string]
    >("SELECT * FROM resource WHERE name = ?")
    .get(name);
  if (!r) return null;
  let tags: string[] = [];
  try {
    tags = JSON.parse(r.tags_json ?? "[]");
  } catch {}
  return {
    name: r.name,
    template: r.template,
    concurrency: r.concurrency,
    argSchema: JSON.parse(r.arg_schema_json),
    errorRegex: r.error_regex ?? undefined,
    cwd: r.cwd ?? undefined,
    tags,
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
    /**
     * Is there a credential at all?
     *
     * The scheduler refuses to dispatch a turn without one, so a fleet in this
     * state is stopped and every view would look idle rather than blocked. One
     * boolean, so the header can carry the mark instead of the boss discovering
     * it in a queue that never moves. The deeper checks — docker, the sandbox
     * server, the sidecar version — cost network and stay in the settings page.
     */
    ready: (db.query<{ n: number }, []>("SELECT count(*) AS n FROM runtime_auth").get()?.n ?? 0) > 0,
    // `base_branch` rides along because it is the one thing add-a-project decided
    // on the boss's behalf, and a decision taken silently has to be visible where
    // its consequence starts — the new project's own page.
    projects: db.query("SELECT id, name, repo_path, remote, base_branch FROM project").all(),
    groups: db
      .query(
        `SELECT id, project_id, name, branch, status, owns_json, budget_tokens,
                spent_tokens, pr_number, approved_at FROM grp WHERE status != 'DISSOLVED'`,
      )
      .all(),
    // Why an approved group has not started. The boss pressed the button; showing
    // the same button again reads as "the click did nothing".
    approvedBlocked: db
      .query<{ id: number }, []>("SELECT id FROM grp WHERE status = 'DRAFT' AND approved_at IS NOT NULL")
      .all()
      .map((g) => ({ grpId: g.id, reason: canStart(db, g.id).reason ?? "" }))
      .filter((b) => b.reason),
    // A planner found this requirement is already covered. The evidence was checked
    // before the row could exist; the boss decides whether it leaves the board.
    dropProposals: db
      .query(
        `SELECT n.grp_id AS grpId, n.body FROM note n
         JOIN grp g ON g.id = n.grp_id
         WHERE g.status NOT IN ('DISSOLVED') AND json_extract(n.frontmatter_json, '$.drop_proposal') = 1
         GROUP BY n.grp_id HAVING n.at = max(n.at)`,
      )
      .all(),
    slices: db
      .query(
        `SELECT id, grp_id, seq, title, accept_spec, difficulty, status, gates_json,
                spent_tokens, awaiting_at FROM slice ORDER BY grp_id, seq`,
      )
      .all(),
    // PLAN.md §8 asks the desk wall for the current slice, the turn count and the
    // live last line. Two of the three are here; the third is the SSE stream,
    // which the client already holds. Turn count is what tells a stuck agent from
    // a busy one — "in_progress" looks identical either way.
    agents: db
      .query(
        `SELECT a.id, a.grp_id, a.role, a.model, a.state, a.activity, a.session_tokens,
                a.total_tokens,
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
        `SELECT n.grp_id AS grpId, n.body, n.at,
                json_extract(n.frontmatter_json, '$.unknownPaths') AS unknownPaths FROM note n
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
        `SELECT e.id, e.grp_id, e.severity, e.question, e.brief, e.kind, e.chain_state, e.answered_by, e.answer,
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
        `SELECT g.id, g.project_id, g.name, g.branch, g.pr_number, g.spent_tokens,
                (SELECT count(*) FROM slice s WHERE s.grp_id = g.id) AS slices,
                (SELECT max(e.at) FROM event e WHERE e.grp_id = g.id) AS at
         FROM grp g WHERE g.status = 'DISSOLVED' ORDER BY at DESC LIMIT 12`,
      )
      .all(),
    // The panel shows "并行 3/3" from this: without the cap, a queued group looks
    // stuck rather than queued, which is the difference between a bug and a setting.
    limits: {
      maxGroups: ctx.config.maxGroups ?? null,
      // Always the map shape for the panel, whatever the config wrote.
      leaseSlots: poolSizes(ctx.config.leaseSlots),
      autoAdvance: !!ctx.config.autoAdvance,
      autoAcceptTiers: ctx.config.autoAcceptTiers ?? [],
    },
    // How much of each subscription is gone. Not spend — spend is attributable and
    // belongs in 成本. This answers "can this still run tonight", which is the one
    // usage question that changes what the boss does next.
    usage: db
      .query<{ runtime: string; json: string; at: number }, []>(
        "SELECT runtime, json, at FROM usage_snapshot",
      )
      .all()
      .map((r) => {
        try {
          return { runtime: r.runtime, at: r.at, ...(JSON.parse(r.json) as object) };
        } catch {
          return { runtime: r.runtime, at: r.at };
        }
      }),
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
const getAnswerDraft: Handler = async (ctx, _req, params) => {
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
  const landed = route({ ctx, notifyBoss: ctx.notifyBoss }, id);
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
  // Each file's path relative to what was dropped. A loose file has none; a file
  // from inside a dropped folder has `<folder>/…/name`, and the folder is what the
  // boss meant to attach — "看这个目录" is one reference, not forty.
  const rels = form.getAll("rel").map((r) => String(r));
  if (!files.length) return bad("no file");
  const root = join(ctx.config.dataDir ?? "data", "attachments");
  const out: { name: string; path: string; type: string; size: number }[] = [];
  const dirs = new Map<string, { path: string; bytes: number }>();
  const stamp = Date.now();

  for (const [i, f] of files.entries()) {
    if (f.size > 25 * 1024 * 1024) return bad(`${f.name} 超过 25MB`);
    // The stamp keeps two screenshots called "Screenshot.png" apart, and the
    // sanitising keeps a crafted filename inside the directory. Every segment of
    // a relative path is sanitised the same way, so `..` cannot survive one.
    const safe = (s: string) => s.replace(/[^\w.\-\u4e00-\u9fff]/g, "_").slice(-80);
    const rel = (rels[i] ?? "").split("/").filter((s) => s && s !== "." && s !== "..").map(safe);
    if (rel.length > 1) {
      const top = rel[0]!;
      const base = dirs.get(top)?.path ?? join(root, `${stamp}-${top}`);
      const path = join(base, ...rel.slice(1));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(await f.arrayBuffer()));
      dirs.set(top, { path: base, bytes: (dirs.get(top)?.bytes ?? 0) + f.size });
      continue;
    }
    await mkdir(root, { recursive: true });
    const path = join(root, `${stamp}-${out.length}-${safe(f.name)}`);
    await writeFile(path, Buffer.from(await f.arrayBuffer()));
    out.push({ name: f.name, path, type: f.type || "application/octet-stream", size: f.size });
  }

  // A directory is one attachment: the path, for an agent to walk.
  for (const [name, d] of dirs) {
    out.push({ name, path: d.path, type: "inode/directory", size: d.bytes });
  }
  return json({ files: out });
};

/**
 * Attach something already on this machine, by path.
 *
 * The upload route exists because a browser cannot hand over a real path — but
 * the boss picking through their own disk in our own picker is not a browser
 * upload, and round-tripping a 400MB folder through a file input to write it back
 * to the same disk is absurd. Copied rather than referenced in place: the file
 * the agent reads has to still be there when it reads it, and the boss's working
 * copy moves.
 */
const postAttachLocal: Handler = async (ctx, req) => {
  const b = await body<{ paths?: string[] }>(req);
  const picked = (b.paths ?? []).filter((s) => typeof s === "string" && s.trim());
  if (!picked.length) return bad("no path");
  const root = join(ctx.config.dataDir ?? "data", "attachments");
  await mkdir(root, { recursive: true });
  const stamp = Date.now();
  const out: { name: string; path: string; type: string; size: number }[] = [];
  for (const raw of picked) {
    const src = resolve(expandHome(raw));
    let st;
    try {
      st = statSync(src);
    } catch {
      return bad(`${raw}: 读不到`);
    }
    const safe = basename(src).replace(/[^\w.\-\u4e00-\u9fff]/g, "_").slice(-80);
    const dest = join(root, `${stamp}-${out.length}-${safe}`);
    await cp(src, dest, { recursive: st.isDirectory() });
    out.push({
      name: basename(src),
      path: dest,
      type: st.isDirectory() ? "inode/directory" : guessType(src),
      size: st.size,
    });
  }
  return json({ files: out });
};

/** Enough to tell an image from everything else, which is all this decides. */
function guessType(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const img: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  };
  return img[ext] ?? "application/octet-stream";
}

export interface Attachment {
  name: string;
  path: string;
  type: string;
  /** 图1 / 附件2 — the marker the boss's own text refers to. */
  label?: string;
}

/**
 * Hand one attachment back to the panel.
 *
 * The files were written to `data/attachments` and referenced by absolute path
 * from the first version, which is what an agent needs — but the panel is a
 * browser, and a browser cannot open a path. So the boss's own screenshot,
 * attached to the question the boss is being asked, rendered as a line of text
 * naming a file they could not see.
 *
 * Basename only: the stored name is already sanitised on the way in, and taking
 * only the last segment means a path that arrives with `..` in it resolves to a
 * file that does not exist rather than to one outside the directory.
 */
const getAttachment: Handler = async (ctx, _req, params) => {
  const name = basename(params.name ?? "");
  const path = join(ctx.config.dataDir ?? "data", "attachments", name);
  if (!name || !existsSync(path)) return text("no such attachment", 404);
  const f = Bun.file(path);
  return new Response(f, {
    headers: {
      "content-type": f.type || "application/octet-stream",
      // Content-addressed by name — every upload carries its own timestamp, so a
      // given URL never changes.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};

/**
 * The boss said something that should stick. One helper, because "record it and see if
 * it is the third time" must not be remembered separately at four call sites.
 */
export function bossFact(ctx: Ctx, grpId: number | null, body: string): void {
  const projectId = grpId
    ? ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
        ?.project_id ?? null
    : null;
  ctx.db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
    [projectId, grpId, ctx.config.language, body],
  );
  sediment(ctx, projectId, ctx.config.feedbackSediment ?? 3);
}

/**
 * Words plus the files that came with them.
 *
 * Paths, never contents: an image inlined into a prompt costs thousands of tokens
 * on every turn that carries it, a path costs a dozen and the agent opens it once
 * when it needs to. Shared by every route the boss can attach to — an idea, a
 * sent-back card, a rejected slice, a remark to the group.
 *
 * The image tag is ASCII and fixed because it is read back by machine: codex has
 * no file tool that opens an image, so those paths have to leave here and come
 * back as `-i` flags (imagePaths below). The wording no longer names a tool —
 * `Read` exists on one of the two CLIs.
 */
const IMAGE_TAG = " (image)";

export function withAttachments(text: string, attachments?: Attachment[]): string {
  const files = (attachments ?? []).filter((f) => f?.path);
  if (!files.length) return text;
  // The label goes on the path, because the words above it use the same marker.
  // Without it, "按 [图2] 改" is a reference into a list of three bare paths.
  return (
    `${text}\n\n附件（路径如下）：\n` +
    files
      .map((f) => `- ${f.label ? `[${f.label}] ` : ""}${f.path}${f.type?.startsWith("image/") ? IMAGE_TAG : ""}`)
      .join("\n")
  );
}

/** The image attachments in an assembled prompt, for CLIs that need them as flags. */
export function imagePaths(prompt: string): string[] {
  const re = new RegExp(`^- (?:\\[[^\\]]+\\] )?(\\S+)${IMAGE_TAG.replace(/[()]/g, "\\$&")}$`, "gm");
  return [...prompt.matchAll(re)].map((m) => m[1]!);
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
    bossFact(ctx, grpId, withAttachments(`boss sent the DRAFT back: ${b.reason ?? ""}`, b.attachments));
    // Back to PLANNING, which is what the group actually is now. Left in DRAFT it
    // still counted as a decision waiting on the boss, still showed the rejected
    // card, and 批准开工 still worked on it — one stray click approves the very
    // plan that was just sent back.
    //
    // Clearing approved_at as well: sending a plan back withdraws the approval, or
    // the next card to reach DRAFT would start itself on the strength of a yes the
    // boss said to a plan that no longer exists.
    ctx.db.run(
      "UPDATE grp SET status = 'PLANNING', approved_at = NULL WHERE id = ? AND status = 'DRAFT'",
      [grpId],
    );
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
    // Four tables point at a slice, not one. Clearing only `task` left `job`,
    // `note` and `slice.depends_on` holding references, so re-approving a group
    // that had already run died on `FOREIGN KEY constraint failed` — see
    // `SLICE_REFS`.
    dropSlices(ctx.db, grpId);
    // A cap, per difficulty, written at birth. Until this, `budget_tokens` was
    // never INSERTed anywhere, so it was NULL on every row and both admission
    // checks in scheduler.ts had never stopped a single turn. It matters more now
    // that reviewers run on a CLI with no tool whitelist: the whitelist used to be
    // what bounded how much of the repo a review could read, and this is what
    // replaces it. The boss can raise any of them from the requirement page.
    const ins = ctx.db.prepare(
      `INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, budget_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    );
    // One task per slice, up front. Without something to claim the writer
    // improvises an id, `task done` never lands, and the whole review pipeline
    // silently never fires — which is exactly what the live run showed.
    const insTask = ctx.db.prepare(
      "INSERT INTO task (grp_id, slice_id, title, created_at) VALUES (?, ?, ?, unixepoch() * 1000)",
    );
    v.slices.forEach((sl, i) => {
      const row = ins.get(
        grpId,
        i + 1,
        sl.title,
        sl.accept,
        sl.difficulty,
        ctx.config.sliceBudgetTokens?.[sl.difficulty] ?? ctx.config.sliceBudgetTokens?.normal ?? null,
      ) as { id: number };
      insTask.run(grpId, row.id, sl.title);
    });
  }
  // Boundaries before work. Two groups discovering at merge time that they were
  // both editing one file have already paid for the work twice.
  //
  // The slices above are written either way: without them there is nothing for the
  // automatic start to run once the boundary clears, and an edited card would be
  // lost between the two clicks.
  const start = canStart(ctx.db, grpId);
  if (!start.ok) {
    // A refusal used to end here, and the click was gone: the group sat in DRAFT
    // with nothing recording that the boss had said yes, and nobody re-ran it when
    // the group holding the paths merged. One click has to be final.
    ctx.db.run("UPDATE grp SET approved_at = unixepoch() * 1000 WHERE id = ?", [grpId]);
    // Put the Architect back on it — the boundary is its job, and it was observed
    // cutting one group's paths and forgetting the other's.
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
      body: say(ctx.config?.language, "group.approve_held", { why: start.reason ?? "" }),
    });
    // 200, not 422: the boss did decide, and a red error toast says the opposite.
    return text(say(ctx.config?.language, "group.approve_held", { why: start.reason ?? "" }));
  }

  const err = await startGroup(ctx, grpId);
  return err ? bad(err) : text("ok");
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
        rejection: "main moved: `git fetch origin main` and `git rebase origin/main` before doing anything else.",
        rotate: true,
      },
    });
  }
  ctx.sched.tick();
  return stale;
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
    case "newpr": {
      // A closed PR normally comes back by being reopened on GitHub, and the
      // watchdog picks that up. But a PR cannot be reopened once its branch has
      // been force-pushed or deleted, and sometimes the boss simply wants a clean
      // one — without this the group is stuck holding a pr_number that openPr
      // treats as "already done", so it could never get another.
      const g = ctx.db
        .query<{ name: string; repo: string; pr_number: number | null }, [number]>(
          "SELECT g.name, p.repo_path AS repo, g.pr_number FROM grp g JOIN project p ON p.id = g.project_id WHERE g.id = ?",
        )
        .get(grpId);
      if (!g) return text("no such group", 404);
      if (!ctx.gh) return bad("no GitHub client on this server");
      ctx.db.run("UPDATE grp SET pr_number = NULL WHERE id = ?", [grpId]);
      const r = await openPr({
        ctx,
        gh: ctx.gh,
                grpId,
        title: `orch: ${g.name}`,
        body: prBody(ctx, grpId),
      });
      if ("error" in r) {
        // Put the old number back: a group with no PR and no way to open one is
        // worse off than one whose PR is closed.
        ctx.db.run("UPDATE grp SET pr_number = ? WHERE id = ?", [g.pr_number, grpId]);
        return bad(r.error);
      }
      ctx.db.run("UPDATE grp SET status = 'PR_OPEN', paused_at = NULL WHERE id = ?", [grpId]);
      joinQueue(ctx.db, grpId);
      ctx.db.run(
        `UPDATE escalation SET chain_state = 'answered', answered_by = 'boss', answer = ?
         WHERE grp_id = ? AND answer IS NULL AND question LIKE 'PR #%被关掉了%'`,
        [`opened #${r.number} instead`, grpId],
      );
      ctx.bus.emit({
        grpId,
        author: "boss",
        kind: "state_change",
        body: `opened PR #${r.number} to replace the closed one`,
        meta: { pr: r.number },
      });
      return json({ number: r.number });
    }
    case "drop": {
      // 不做了. A requirement that turned out to be a duplicate, or that someone
      // else already fixed, had no way off the board: 退回重拆 sends it back to the
      // Dispatcher, which writes another card for work nobody wants. The paths it
      // held stayed held, so a group waiting on them waited forever.
      const b = await body<{ why?: string }>(req);
      const g = ctx.db
        .query<{ status: string; name: string }, [number]>("SELECT status, name FROM grp WHERE id = ?")
        .get(grpId);
      if (!g) return text("no such group", 404);
      if (g.status === "DISSOLVED") return text("ok");
      dropGroup(ctx, grpId, b.why ?? "");
      // Its paths are free the moment it leaves ACTIVE, so anything the boss
      // already approved behind it can start now.
      return json({ started: await sweepApproved(ctx) });
    }
    case "wake":
      await unpark(ctx, grpId);
      return text("ok");
    // Throw the container away; the next turn builds a fresh one and
    // `restoreWorkspace` puts the checkout and the dependencies back (the branch
    // itself lives in the boss's repo, so nothing on it is at risk). The way out
    // of a container that is wedged, is missing a mount the boss has just
    // allowed, or is holding a credential that has since been replaced.
    case "rebuild": {
      await killSandbox(ctx, { grp: grpId });
      // The old lines described a container that no longer exists.
      clearSandboxLog(grpId);
      ctx.bus.emit({
        grpId,
        author: "boss",
        kind: "state_change",
        body: say(ctx.config?.language, "sandbox.rebuild"),
      });
      ctx.sched.tick();
      return text("ok");
    }
    case "interrupt": {
      const b = await body<{ mode?: string }>(req);
      const mode = b.mode === "rollback" ? "rollback" : "keep";
      const out = await interrupt(ctx, grpId, mode);
      return json(out);
    }
    default:
      return bad(`unknown action ${action}`);
  }
};

/** Roughly a screenful of diff. Beyond this the boss wants the editor, not a panel. */
// 400k. The old 80k was sized for a page that pasted the whole diff into one
// <pre>: past that it was unreadable anyway, so truncating cost nothing. The
// viewer now renders one file at a time from a parsed diff, so the ceiling that
// matters is the browser's, not the reader's — and a slice that touched thirty
// files was being cut off mid-review, which is the one moment the boss needs all
// of it.
const DIFF_CAP = 400_000;

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


  let stat = "";
  let diff = "";
  let truncated = false;
  // Never `git diff <base_sha>` straight: after a rebase that base is a commit on
  // old main and the diff picks up every other group's landed work. See
  // `sliceDiffBase`.
  let scope: "slice" | "branch" = "slice";
  {
    const git = sandboxGit(ctx, { grp: sl.grp_id });
    // The project's base branch, not whatever the sandbox's clone thinks the
    // default is: the boss is reading this diff against the branch this work
    // will land on, and a project that develops on `develop` says so once.
    const projectId = ctx.db
      .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
      .get(sl.grp_id)?.project_id;
    const from = await sliceDiffBase(
      git,
      WORK,
      WORK,
      sl.base_sha,
      projectId ? await baseRefFor(ctx, projectId) : undefined,
    );
    if (from) {
      scope = from.scope;
      const [s, d] = await Promise.all([
        git(WORK, ["diff", "--stat", from.base, "--"], WORK),
        git(WORK, ["diff", from.base, "--"], WORK),
      ]);
      stat = s.code === 0 ? s.out.trim() : "";
      diff = d.code === 0 ? d.out : "";
      truncated = diff.length > DIFF_CAP;
      if (truncated) diff = diff.slice(0, DIFF_CAP);
    }
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
  const projectId =
    ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(sl.grp_id)
      ?.project_id ?? 0;
  const gates = gatesFor(ctx.db, projectId).flatMap((name) => {
    const path = join(ctx.config.dataDir ?? "data", "gates", `${id}-${name}.log`);
    if (!existsSync(path)) return [];
    const raw = Bun.file(path);
    return [{ name, path, size: raw.size }];
  });

  return json({ ...sl, stat, diff, truncated, scope, verdicts, gates });
};

/** Tail of one gate's log, on demand: it is only opened when a verdict is doubted. */
const getGateLog: Handler = async (ctx, req, params) => {
  const name = (params.name ?? "").replace(/[^\w.-]/g, "");
  const path = join(ctx.config.dataDir ?? "data", "gates", `${Number(params.id)}-${name}.log`);
  if (!existsSync(path)) return text("no log", 404);
  const raw = await Bun.file(path).text();
  const grep = new URL(req.url).searchParams.get("grep");
  const lines = raw.split("\n");
  // The panel scrolls this locally, so the tail is about not shipping a 200MB
  // build log, not about what is worth reading. 400 lines was the latter, and it
  // cut a `bun test` run in half.
  //
  // A substring, not a regex — the same rule as `getLeaseLog`, which was fixed
  // and never generalised. `new RegExp` on a caller-supplied string runs on the
  // host, in the single process that is also the SSE fan-out, the scheduler, the
  // mailbox poller and every blocked `orch lease`; one nested quantifier stalls
  // all of it. This route takes no token either.
  return text(grep ? lines.filter((l) => l.includes(grep)).slice(0, 4000).join("\n") : lines.slice(-4000).join("\n"));
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
    bossFact(ctx, sl.grp_id, b.feedback ?? "boss rejected the slice");
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
 * `~` as the person typing it means it.
 *
 * Only the two host-browsing paths use this now — the attachment picker and the
 * directory listing behind it. A project is a repository, not a directory.
 */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Register a repository this login can reach. There is no other kind of project.
 *
 * A project used to be a directory on this host, and everything that made it one
 * — `expandHome`, `checkRepoPath`, the `origin` lookup, gate/install detection,
 * the PR preflight — read a checkout at registration time. None of that can run
 * before a clone exists, and 007 §2 already decided where it goes instead:
 * after the first group's clone, writing its guess into project config. What is
 * left here is what GitHub can answer in one request.
 */
const postProject: Handler = async (ctx, req) => {
  const b = await body<{ name?: string; repo?: string; gates?: string[] }>(req);
  const want = (b.repo ?? "").trim();
  if (!want) return bad("which repository? (owner/name)");
  if (!ctx.gh) return bad("this server has no GitHub client");

  // Asked of GitHub rather than trusted from the browser: the default branch is
  // written into the row, and a wrong one is a group that branches off nothing.
  const r = await ctx.gh.request<{
    full_name: string;
    default_branch: string;
    clone_url: string;
    permissions?: Record<string, boolean>;
  }>("GET", `/repos/${want}`);
  if (!r.ok) return bad(r.message);
  const repoPath = r.data.full_name;
  const remote = r.data.clone_url;
  const baseBranch = r.data.default_branch || null;
  const name = (b.name ?? "").trim() || repoPath.split("/")[1] || repoPath;

  const dup = ctx.db.query<{ name: string }, [string]>("SELECT name FROM project WHERE repo_path = ?").get(repoPath);
  if (dup) return bad(`${repoPath} is already registered as "${dup.name}"`);

  const gates = b.gates ?? [];
  const row = ctx.db
    .query<{ id: number }, [string, string, string, string, string | null]>(
      `INSERT INTO project (name, repo_path, remote, config_json, base_branch, created_at)
       VALUES (?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    )
    .get(name, repoPath, remote, JSON.stringify({ gates }), baseBranch)!;

  // Said rather than silently guessed at: nothing was looked at, because there is
  // nothing to look at until a group clones (007 §2).
  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body:
      `${name}（${repoPath} · ${baseBranch ?? "默认分支"}）加好了。闸门和安装命令等第一个组克隆完再猜，` +
      `现在填也行：设置 → 闸门。`,
  });
  // Registered, and then told the truth about it. Read access is enough to clone
  // and work, so this does not refuse the repository — it refuses to let the boss
  // find out at the end, when a group has done everything and the push is the
  // only step left. No extra request: the answer above carries it.
  const blocked = pushBlocked(r.data.permissions, repoPath);
  if (blocked) {
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body: `${repoPath} 加好了，但这个登录推不上去：${blocked}。现在处理，别等第一个切片做完。`,
    });
  }

  ctx.sched.tick();
  return json({ id: row.id, gates });
};

/** Idle SSE connections get dropped by proxies and by browsers' own timeouts. */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Rows to clear for one project, in an order SQLite will accept.
 *
 * Nothing declares `ON DELETE CASCADE` (`PRAGMA foreign_key_list` says NO ACTION
 * on every one), so the order is the whole correctness of this: children before
 * parents, and the two that are easy to miss are `escalation` → `note` and
 * `note` → `task`, which put those three in an order that reads backwards.
 *
 * Written as a list rather than one long function because the next table with a
 * `grp_id` has to appear here, and a list makes that a one-line change with a
 * visible place to put it.
 */
const G = "SELECT id FROM grp WHERE project_id = ?1";
const A = `SELECT id FROM agent WHERE project_id = ?1 OR grp_id IN (${G})`;
const C = `SELECT id FROM channel WHERE project_id = ?1 OR grp_id IN (${G})`;
const S = `SELECT id FROM slice WHERE grp_id IN (${G})`;
const PROJECT_ROWS: string[] = [
  `DELETE FROM cursor WHERE channel_id IN (${C}) OR agent_id IN (${A})`,
  `DELETE FROM member WHERE channel_id IN (${C}) OR agent_id IN (${A})`,
  `DELETE FROM lease WHERE grp_id IN (${G}) OR agent_id IN (${A})`,
  `DELETE FROM job WHERE grp_id IN (${G}) OR agent_id IN (${A}) OR slice_id IN (${S})`,
  `DELETE FROM escalation WHERE grp_id IN (${G}) OR agent_id IN (${A})`,
  `DELETE FROM event WHERE grp_id IN (${G}) OR channel_id IN (${C})`,
  `DELETE FROM note WHERE project_id = ?1 OR grp_id IN (${G}) OR slice_id IN (${S})`,
  `DELETE FROM task WHERE grp_id IN (${G}) OR slice_id IN (${S})`,
  `DELETE FROM slice WHERE grp_id IN (${G})`,
  `DELETE FROM channel WHERE id IN (${C})`,
  `DELETE FROM agent WHERE id IN (${A})`,
  // `grp.blocked_on` points at another grp. Clearing it first is what lets the
  // whole set go in one statement.
  `UPDATE grp SET blocked_on = NULL WHERE blocked_on IN (${G})`,
  `DELETE FROM grp WHERE project_id = ?1`,
  `DELETE FROM project WHERE id = ?1`,
];

/**
 * Remove a project: everything of ours, nothing of GitHub's.
 *
 * **This is the one place in this codebase where deleting is right, and it
 * contradicts the rule everywhere else.** `dropGroup`'s comment — "archiving
 * must never mean deleting" — is correct for a group: what a group did is the
 * record, and a dropped one keeps every event. A project being removed is the
 * boss saying they do not want the record either. Two different acts, and the
 * panel must never let one be mistaken for the other: 不做了 archives, this
 * erases.
 *
 * **The remote is never touched.** No branch is deleted, no PR is closed, no
 * GitHub call that writes anything is made from here — the only GitHub state
 * this drops is a hold in our own memory. Removing a project removes our copy
 * of the work; a boss who found their branches gone from GitHub afterwards
 * would have been robbed by a cleanup button.
 *
 * Order matters twice over: containers before rows, because a killed row takes
 * the sandbox id with it and an unnamed container lives until its TTL; and jobs
 * before containers, so nothing starts a turn against a project that is going
 * away.
 */
const deleteProject: Handler = async (ctx, _req, params) => {
  const id = Number(params.id);
  const p = ctx.db
    .query<{ name: string; repo_path: string; remote: string | null }, [number]>(
      "SELECT name, repo_path, remote FROM project WHERE id = ?",
    )
    .get(id);
  if (!p) return text("no such project", 404);
  const grps = ctx.db.query<{ id: number }, [number]>("SELECT id FROM grp WHERE project_id = ?").all(id);

  // 1. Nothing new starts, and what is running is actually stopped.
  //
  // Marking the row cancelled is not stopping it. The stream reader stays
  // attached, the CLI keeps running until the container dies on the next line,
  // and its writes then land on rows that are gone — a foreign key failure
  // inside a turn whose group no longer exists, which surfaces as an unhandled
  // rejection with nothing in the message about a project having been removed.
  // `abortJob` is what the offline hold already uses for the same shape.
  //
  // Both scopes: a project's standing agents (Architect, CoS, Dispatcher) have
  // `grp_id` NULL and `project_id` set, so a `grp_id IN (…)` filter left every
  // one of their turns running against a project that was being erased.
  const doomed = ctx.db
    .query<{ id: number }, [number]>(
      `SELECT id FROM job
        WHERE state IN ('pending', 'running')
          AND (grp_id IN (SELECT id FROM grp WHERE project_id = ?1)
               OR agent_id IN (SELECT id FROM agent WHERE project_id = ?1))`,
    )
    .all(id);
  let stopped = 0;
  for (const j of doomed) if (abortJob(j.id)) stopped++;
  ctx.db.run(
    `UPDATE job SET state = 'cancelled', ended_at = unixepoch() * 1000, error = 'project removed'
      WHERE state IN ('pending', 'running')
        AND (grp_id IN (SELECT id FROM grp WHERE project_id = ?1)
             OR agent_id IN (SELECT id FROM agent WHERE project_id = ?1))`,
    [id],
  );
  if (stopped) {
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: `${p.name}：${stopped} 个在跑的 turn 先掐掉了，再删数据`,
    });
  }

  // 2. Containers, while their ids are still readable.
  const failed: string[] = [];
  for (const g of grps) {
    try {
      await killSandbox(ctx, { grp: g.id });
    } catch (e: any) {
      failed.push(`grp ${g.id}: ${e?.message ?? e}`);
    }
    clearSandboxLog(g.id);
  }
  try {
    await killSandbox(ctx, { project: id });
  } catch (e: any) {
    failed.push(`project sandbox: ${e?.message ?? e}`);
  }
  // The bare mirror in the utility container. Its own file owns the path, so
  // that convention has one home; failing is disk, not data — everything in it
  // is on the remote or in a container.
  if (p.remote && !(await removeMirror(ctx, p.remote))) failed.push("mirror");

  // 3. Files, read out of the bodies that name them before those bodies go.
  const root = resolve(join(ctx.config.dataDir ?? "data", "attachments"));
  const said = ctx.db
    .query<{ body: string }, [number]>(
      `SELECT body FROM note WHERE project_id = ?1 OR grp_id IN (${G})
       UNION ALL SELECT body FROM event WHERE grp_id IN (${G})`,
    )
    .all(id)
    .map((r) => r.body)
    .join("\n");
  for (const m of said.matchAll(/^- (?:\[[^\]]+\] )?(\S+?)(?: \(image\))?$/gm)) {
    const path = resolve(m[1]!);
    // Only inside the attachments directory: these strings come out of prose an
    // agent wrote, and `rm -rf` on whatever one of them happens to say is not a
    // cleanup button.
    if (path.startsWith(`${root}/`)) await rm(path, { recursive: true, force: true }).catch(() => {});
  }

  // 4. Rows, in one transaction: a half-removed project is worse than either end.
  ctx.db.transaction(() => {
    for (const sql of PROJECT_ROWS) ctx.db.run(sql, [id]);
  })();

  // 5. State that outlives the row. `holds` is keyed by `owner/repo` and would
  // hold a repository nobody has any more; clearing all of them costs at most
  // one extra failed turn on another held project, which is what re-arms it.
  // The skills cache is keyed by project id, and ids are reused by SQLite —
  // leaving it would hand the next project this one's skill list.
  forgetHolds("github");
  forgetProjectSkills(ctx.db, id);

  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body: `移除了项目 ${p.name}（${p.repo_path}）：${grps.length} 个需求、容器和记录都清掉了。GitHub 上什么都没动。`,
  });
  ctx.sched.tick();
  return json({ ok: true, groups: grps.length, failed });
};

/**
 * This machine's directories, for the **attachment** picker and nothing else.
 *
 * It used to be how a project was added, which is why it reports `.git` on each
 * entry — a project is a GitHub repository now and comes from the repo list. It
 * stays because attaching a file or a folder to a message is genuinely about
 * this machine: a browser cannot hand over a real path.
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
  // Nor are the index's own rows notes: `pageindex` is a serialised tree and
  // `map` is a rendered directory listing, both stored here because `note` was
  // the table that already existed. Neither is anything the boss reads.
  where.push("n.kind NOT IN ('pageindex', 'map')");

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
 * Every skill on this machine, and whether agents can see it.
 *
 * `on` is what the boss ticked: those get staged into the directory every sandbox
 * mounts, so an agent discovers and invokes them itself. Unticked ones are still
 * listed — naming one in a requirement injects it into that single turn — which is
 * why the composer offers all of them and asks before using an unticked one.
 */
const getSkills: Handler = async (ctx, req) => {
  const id = Number(new URL(req.url).searchParams.get("project"));
  const repo = ctx.db
    .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
    .get(id)?.repo_path;
  projectSkillsPending(ctx, id, repo);
  const off = new Set(skillsOff(ctx.db));
  return json({
    skills: listSkills(repo, projectSkills(ctx.db, id)).map(({ name, rel, description, scope }) => ({
      name,
      path: rel,
      description,
      scope,
      // A project skill ships with the repository the group is working on, so it
      // is always delivered and there is nothing to tick.
      on: scope === "project" || !off.has(name),
    })),
  });
};

/**
 * Tick or untick one skill, then rebuild the staging directory.
 *
 * Rebuilt now rather than at the next sandbox: the mount is a directory, so what
 * changes here is visible to every running container as soon as the next turn's CLI
 * process starts. No sandbox is rebuilt for a tick box.
 */
const postSkill: Handler = async (ctx, req) => {
  const b = (await req.json().catch(() => ({}))) as { name?: string; on?: boolean };
  // No name is a rescan: the boss installed or removed a skill outside this
  // process, and the staged copy is the only thing that does not know yet.
  if (b.name) setSkillOff(ctx.db, b.name, b.on === false);
  const { staged, failed } = restageSkills(ctx.db, ctx.config?.skillsDir ?? "/var/tmp/orch-cache/skills");
  // The mount is a staging path now, not either CLI's own directory, so a
  // changed set is not visible until the links are rebuilt. Every live
  // container, because a standing agent's container has no checkout and so no
  // other moment that would ever redo them.
  await relinkSkills();
  return json({ staged: staged.length, failed });
};

const getDirs: Handler = async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const asked = q.get("path") ?? homedir();
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
  // Files only when someone is picking files. The repo picker asking for them
  // would list a thousand entries in a source directory to choose one folder.
  const files = q.get("files")
    ? entries
        .filter((d) => d.isFile() && !d.name.startsWith("."))
        .map((d) => {
          const full = join(path, d.name);
          let size = 0;
          try {
            size = statSync(full).size;
          } catch {}
          return { name: d.name, path: full, size };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  // A repo can be picked at any level, including the one being listed.
  return json({
    path,
    parent: path === "/" ? null : dirname(path),
    repo: existsSync(join(path, ".git")),
    dirs,
    files,
  });
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

/**
 * Which runtime is configured, and how. Never the secret.
 *
 * The value only ever leaves this process into an egress sidecar's vault, so
 * even the page that sets it reads back a masked tail — enough to tell two
 * tokens apart, which is the only question anyone asks of one they pasted.
 */
const getAuth: Handler = async (ctx) => json({ runtimes: listAuth(ctx.db) });

const postAuth: Handler = async (ctx, req) => {
  const b = await body<{
    runtime?: string; mode?: string; secret?: string; baseUrl?: string; clear?: boolean; adopt?: boolean;
  }>(req);
  const runtime = (b.runtime ?? "").trim();
  let secret = (b.secret ?? "").trim();
  if (!runtime) return bad("which runtime?");
  // Read the sandbox server's key out of the server's own config rather than
  // asking the boss to copy one across. Generating a key here and trusting a
  // human to mirror it is how the fleet spent a night 401ing: the panel had one
  // value, the server had another, and nothing on either side could see both.
  // The value never reaches the browser — it goes config file to store.
  if (b.adopt) {
    if (runtime !== SANDBOX_KEY) return bad("adopt is only for the sandbox server");
    const found = serverKeyOnDisk();
    if (!found)
      return bad(
        "没找到沙盒服务器的配置。它是用 --config 启动的，把那个文件的路径放进 OPENSANDBOX_CONFIG，或者放在 ./sandbox.toml、~/.sandbox.toml。",
      );
    secret = found.key;
  }
  // Something wrong got stored — a login URL pasted into the token box, an old
  // account. Removing it is the only way back to "not configured", which is a
  // state the scheduler and the panel both understand.
  if (b.clear) {
    ctx.db.run("DELETE FROM runtime_auth WHERE runtime = ?", [runtime]);
    for (const g of ctx.db.query<{ id: number }, []>("SELECT id FROM grp WHERE sandbox_id IS NOT NULL").all()) {
      await killSandbox(ctx, { grp: g.id });
    }
    return text("ok");
  }
  if (!secret) return bad("paste the token or key");
  if (b.mode !== "oauth_token" && b.mode !== "api_key" && b.mode !== "chatgpt")
    return bad("mode is oauth_token, api_key or chatgpt");
  // The sandbox key is ours, not a provider's, so it has no shape to check.
  if (runtime !== SANDBOX_KEY) {
    const wrong = wrongShape(runtime, b.mode, secret);
    if (wrong) return bad(wrong);
  }
  if (b.baseUrl) {
    try {
      new URL(b.baseUrl);
    } catch {
      return bad(`${b.baseUrl} is not a URL`);
    }
  }
  // The sandbox key is the one credential whose owner we can ask, and the one
  // where a wrong value is silent and total: it overrides the environment, so
  // generating one here and not telling the server made every turn, every gate
  // and every diff 401 — reported as "Authentication credentials are invalid",
  // which reads as a model problem. Refused rather than stored.
  if (runtime === SANDBOX_KEY) {
    const said = await sandboxKeyWorks(ctx.config.sandbox?.server ?? "127.0.0.1:8080", secret);
    if (said === "invalid") return bad("沙盒服务器不认这个密钥。它自己的配置里写的是哪个，这里就得填哪个。");
  }
  saveAuth(ctx.db, { runtime, mode: b.mode, secret, baseUrl: b.baseUrl || undefined });
  await credentialChanged(ctx, runtime);
  return text("ok");
};

/**
 * Ask the sandbox server whether it would accept this key.
 *
 * `unknown` when it cannot be reached: a server that is down is a preflight
 * finding, not a reason to refuse a key that may well be right.
 */
async function sandboxKeyWorks(server: string, key: string): Promise<"ok" | "invalid" | "unknown"> {
  try {
    const r = await fetch(`http://${server}/v1/sandboxes`, {
      headers: { "OPEN-SANDBOX-API-KEY": key },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok ? "ok" : r.status === 401 ? "invalid" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * What has to happen after a credential is stored, wherever it was stored.
 *
 * Existing sandboxes hold the old value in their sidecars. Killing them is the
 * cheap half of the fix — the next turn makes a new one and binds the new
 * credential — and leaving them would mean "I changed it and nothing happened".
 *
 * It lives here rather than inline because there are two ways in and only one of
 * them used to do this: a login from the panel stored the token and stopped,
 * so every running group kept a sidecar bound to the credential that was missing
 * and every turn came back `Authentication credentials are invalid`.
 */
async function credentialChanged(ctx: Ctx, runtime: string): Promise<void> {
  for (const g of ctx.db
    .query<{ id: number }, []>("SELECT id FROM grp WHERE sandbox_id IS NOT NULL")
    .all()) {
    await killSandbox(ctx, { grp: g.id });
  }
  ctx.db.run(
    `UPDATE escalation SET chain_state = 'answered', answered_by = 'boss', answer = 'reconfigured',
       answered_at = unixepoch() * 1000
     WHERE answer IS NULL AND question LIKE ?`,
    [`${runtime} 的凭据%`],
  );
  ctx.db.run("UPDATE grp SET status = 'RUNNING', paused_at = NULL WHERE status = 'PAUSED' AND paused_at IS NOT NULL");
  ctx.sched.tick();
}

/**
 * Sign in to a Claude account, from the utility container.
 *
 * Three routes for one thing, because the interaction has three moments and
 * they are minutes apart: the POST returns the link the moment the CLI prints
 * it, the code route carries what the boss pastes back from that page, and
 * cancel exists because a login nobody finished should not sit there holding
 * the one slot.
 *
 * The CLI is `claude setup-token` itself, under a pty, in the container. Nothing
 * here builds a URL or calls a token endpoint — see `startClaudeLogin`.
 *
 * No completion route: `run.done` writes `runtime_auth` itself, so the
 * credential row the panel already polls **is** the confirmation.
 */
interface ClaudeFlow {
  url: string;
  expiresAt: number;
}
let claudeFlow: ClaudeFlow | null = null;

const postClaudeLogin: Handler = async (ctx) => {
  if (claudeFlow && claudeFlow.expiresAt > Date.now()) return json(claudeFlow);
  const run = startClaudeLogin(ctx);
  const startedAt = Date.now();
  // A pty plus a TUI's first paint: the link is a second or two out, and a
  // button that returns before it has one has nothing to show.
  for (let i = 0; i < 150 && !run.url; i++) await Bun.sleep(100);
  if (!run.url) {
    run.cancel();
    return bad(
      "容器里的 claude 没打印出登录链接 —— 镜像里跑一下 `claude setup-token` 看看（它需要一个 pty，没有 pty 时它什么都不打印就退出 0）。",
    );
  }
  claudeFlow = { url: run.url, expiresAt: startedAt + PASTE_TTL_MS };
  void run.done.then(async (r) => {
    claudeFlow = null;
    if (r.ok) await credentialChanged(ctx, "claude");
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: r.ok ? "claude 登录好了" : `claude 登录没成：${r.detail}`,
    });
  });
  return json(claudeFlow);
};

/** The code off that page, handed to the prompt the CLI is sitting at. */
const postClaudeCode: Handler = async (ctx, req) => {
  const b = await body<{ code?: string }>(req);
  const code = (b.code ?? "").trim();
  if (!code) return bad("没有码");
  if (!claudeFlow) return bad("没有在等码的登录 —— 先点登录");
  await startClaudeLogin(ctx).submit(code);
  return text("ok");
};

const postClaudeCancel: Handler = async (ctx) => {
  startClaudeLogin(ctx).cancel();
  claudeFlow = null;
  return text("ok");
};

/**
 * Connect GitHub, device flow, no token pasted and no `gh` on this machine.
 *
 * Two routes for one thing, because the flow has two halves that arrive minutes
 * apart: the POST returns the code the moment GitHub mints it — that code *is*
 * the interaction, and a button that waits for the browser has nothing to show —
 * and the GET is what the panel asks while the boss is off in the other tab.
 *
 * The poll runs here rather than in the browser: it holds the device code, which
 * is the half that trades for a token, and it has to finish even if the settings
 * dialog is closed halfway through.
 */
interface GhFlow {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}
let ghFlow: GhFlow | null = null;
/** Why the last attempt did not land. Shown next to the button that retries it. */
let ghError: string | null = null;

const postGithubLogin: Handler = async (ctx) => {
  // A second click while one code is still good hands back the same code rather
  // than starting a second poll: two loops racing for one login is two ways to
  // store a token and one of them wins silently.
  if (ghFlow && ghFlow.expiresAt > Date.now()) {
    return json({ userCode: ghFlow.userCode, verificationUri: ghFlow.verificationUri, expiresIn: Math.round((ghFlow.expiresAt - Date.now()) / 1000) });
  }
  let d: Awaited<ReturnType<typeof startDeviceFlow>>;
  try {
    d = await startDeviceFlow();
  } catch (e: any) {
    return bad(e?.message ?? "GitHub 没给出登录码");
  }
  ghFlow = { userCode: d.userCode, verificationUri: d.verificationUri, expiresAt: Date.now() + d.expiresIn * 1000 };
  ghError = null;

  void (async () => {
    try {
      const token = await pollForToken(d);
      saveAuth(ctx.db, { runtime: "github", mode: "api_key", secret: token });
      // Every running sandbox holds the old (absent) credential in its sidecar.
      await credentialChanged(ctx, "github");
      ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: "GitHub 连上了" });
    } catch (e: any) {
      ghError = e?.message ?? String(e);
      ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: `GitHub 没连上：${ghError}` });
    } finally {
      ghFlow = null;
    }
  })();

  return json({ userCode: d.userCode, verificationUri: d.verificationUri, expiresIn: d.expiresIn });
};

/**
 * Sign in to a ChatGPT account, from the utility container.
 *
 * Same shape as the GitHub flow above and deliberately so: a code, a link, and
 * a pending state that dies with the code. A second shape for the same
 * interaction is how a panel stops being learnable.
 *
 * No completion route. `run.done` writes `runtime_auth` itself, so the
 * credential row the panel already polls **is** the confirmation, and the
 * progress lines are already on the live feed.
 */
interface CodexFlow {
  code: string;
  url: string;
  expiresAt: number;
}
let codexFlow: CodexFlow | null = null;

const postCodexDevice: Handler = async (ctx) => {
  if (codexFlow && codexFlow.expiresAt > Date.now()) return json(codexFlow);
  const run = startCodexDeviceLogin(ctx);
  const startedAt = Date.now();
  // Both, or neither: the link alone opens a page asking for a code the boss
  // does not have. codex prints them on two lines, so this waits for the second.
  for (let i = 0; i < 100 && !(run.url && run.code); i++) await Bun.sleep(100);
  if (!run.url || !run.code) {
    run.cancel();
    return bad("容器里的 codex 没打印出登录码 —— 镜像里跑一下 `codex login --device-auth` 看看。");
  }
  codexFlow = { code: run.code, url: run.url, expiresAt: startedAt + DEVICE_CODE_TTL_MS };
  void run.done.then((r) => {
    codexFlow = null;
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: r.ok ? "codex 登录好了" : `codex 登录没成：${r.detail}`,
    });
  });
  return json(codexFlow);
};

const postCodexDeviceCancel: Handler = async (ctx) => {
  startCodexDeviceLogin(ctx).cancel();
  codexFlow = null;
  return text("ok");
};

/**
 * Each installation, with how many repositories it can see.
 *
 * One extra request per account, asking for a single item — only `total_count` is
 * wanted, and page one of a hundred repositories to count them is the sort of
 * thing that eats a 5000/hour budget quietly. Repeats come back 304 from the
 * client's ETag cache, which does not count against the limit at all.
 */
async function withCounts(ctx: Ctx, list: Installation[]): Promise<Array<Installation & { repos: number | null }>> {
  return await Promise.all(
    list.map(async (i) => {
      const r = await ctx.gh!.request<{ total_count?: number }>(
        "GET",
        `/user/installations/${i.id}/repositories?per_page=1`,
      );
      return { ...i, repos: r.ok ? (Number(r.data?.total_count) || 0) : null };
    }),
  );
}

/** Where the boss installs the app. One app, so one address. */
const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

const getGithubLogin: Handler = async (ctx) => {
  const a = loadAuth(ctx.db, "github");
  // Asked of GitHub rather than read from a stored name: a name in the database
  // keeps saying "connected" for a token that was revoked last week, and an
  // expired GitHub token is the failure where every group breaks at once with a
  // different error each (决策 007 §6). No row, no request.
  const account = a && ctx.gh ? await githubAccount(ctx.gh) : null;
  // Authorized is not installed. A GitHub App's user token reaches exactly the
  // repositories the app is installed on, so zero installations is the state
  // that looks like success and is not: a green 已连接 over a repo list that
  // can never fill.
  const installs = a && account && ctx.gh ? await listInstallations(ctx.gh) : null;
  return json({
    connected: !!a,
    account,
    /** The token is stored and GitHub no longer answers for it. */
    stale: !!a && !account,
    /** Authorized, but the app is not installed anywhere it could read. */
    installed: installs?.ok ? installs.data.length > 0 : null,
    /** Where to fix that. One app, so one address. */
    installUrl: INSTALL_URL,
    /** Which accounts it is installed on, and how many repositories each can see. */
    accounts: installs?.ok ? await withCounts(ctx, installs.data) : [],
    pending: ghFlow && ghFlow.expiresAt > Date.now() ? { userCode: ghFlow.userCode, verificationUri: ghFlow.verificationUri } : null,
    error: ghError,
  });
};

/**
 * What this login can actually open a project on.
 *
 * One route for both halves because they are one question: which account, and
 * which of its repositories. Switching org is picking another installation, not
 * logging in again — so the switcher's options and the list it drives arrive
 * together rather than as two round trips that can disagree.
 */
const getGithubRepos: Handler = async (ctx, req) => {
  if (!ctx.gh) return bad("this server has no GitHub client");
  if (!loadAuth(ctx.db, "github")) return bad("还没连 GitHub，先去设置里连一下");
  // Both at once when the caller names an installation, which it does on every
  // open after the first: measured, a round trip to api.github.com is 260-630ms,
  // so doing these in series is a second of blank dialog for no reason. The
  // first open of a session still has to learn the id before it can ask.
  const asked = Number(new URL(req.url).searchParams.get("installation")) || 0;
  const [inst, guess] = await Promise.all([
    listInstallations(ctx.gh),
    asked ? listRepos(ctx.gh, asked) : Promise.resolve(null),
  ]);
  if (!inst.ok) return bad(inst.message);

  const selected = inst.data.find((i) => i.id === asked)?.id ?? inst.data[0]?.id ?? null;
  const repos = selected === asked ? guess : selected ? await listRepos(ctx.gh, selected) : null;
  if (repos && !repos.ok) return bad(repos.message);

  // Seam (007 step 6): a project's identity is still `repo_path`, which for a
  // repository added here is `owner/name`.
  // Which project, not whether. A greyed-out row saying 已添加 is a dead end: the
  // boss came here to reach that repository and the answer is "it exists
  // somewhere else". Naming it makes the row a route instead.
  const taken = new Map(
    ctx.db
      .query<{ id: number; name: string; repo_path: string }, []>("SELECT id, name, repo_path FROM project")
      .all()
      .map((r) => [r.repo_path, { id: r.id, name: r.name }] as const),
  );
  return json({
    installations: inst.data,
    selected,
    installUrl: INSTALL_URL,
    repos: (repos?.data ?? []).map((r) => ({ ...r, taken: taken.get(r.fullName) ?? null })),
  });
};

/**
 * A project's own knobs: what it gates on, how it installs, what its sandboxes
 * look like. Merged into `config_json` key by key, so a page that only knows
 * about gates cannot blank the sandbox block on save.
 */
const patchProjectConfig: Handler = async (ctx, req, params) => {
  const id = Number(params.id);
  const row = ctx.db.query<{ config_json: string }, [number]>("SELECT config_json FROM project WHERE id = ?").get(id);
  if (!row) return text("no such project", 404);
  const patch = await body<Record<string, unknown>>(req);
  // A column, not a config_json key: it is read on every clone, rebase and diff,
  // and it is re-detected and written back when the remote renames it. Empty
  // means "ask the remote", which is what a fresh project starts as.
  if ("baseBranch" in patch) {
    const want = String(patch.baseBranch ?? "").trim();
    ctx.db.run("UPDATE project SET base_branch = ? WHERE id = ?", [want || null, id]);
    delete patch.baseBranch;
  }
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(row.config_json || "{}");
  } catch {
    current = {};
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete current[k];
    else current[k] = v;
  }
  ctx.db.run("UPDATE project SET config_json = ? WHERE id = ?", [JSON.stringify(current), id]);
  return json(current);
};

const getProjectConfig: Handler = async (ctx, _req, params) => {
  const row = ctx.db
    .query<{ config_json: string; repo_path: string; base_branch: string | null }, [number]>(
      "SELECT config_json, repo_path, base_branch FROM project WHERE id = ?",
    )
    .get(Number(params.id));
  if (!row) return text("no such project", 404);
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config_json || "{}");
  } catch {
    config = {};
  }
  const resources = ctx.db
    .query<{ name: string; template: string }, []>("SELECT name, template FROM resource ORDER BY name")
    .all();
  return json({
    repoPath: row.repo_path,
    config,
    resources,
    baseBranch: row.base_branch,
    // What it resolves to right now, so an empty box is not a mystery.
    baseBranchNow: await baseBranch(ctx, Number(params.id)),
    // What the remote has, so the box is a choice rather than a memory test.
    branches: await listBranches(ctx, Number(params.id)),
  });
};

/**
 * One group's container: what it is, and what it has been saying.
 *
 * The lines are in memory and capped (`sandboxlog.ts`) — this is the machine
 * setting itself up, which is worth watching and scrolling back through, not
 * worth a table. The panel says so rather than pretending the log is durable.
 */
const getSandbox: Handler = async (ctx, req) => {
  const grpId = Number(new URL(req.url).searchParams.get("grp") ?? 0);
  const grp = ctx.db
    .query<
      { id: number; name: string; status: string; project_id: number; sandbox_id: string | null; sandbox_at: number | null; branch: string | null },
      [number]
    >("SELECT id, name, status, project_id, sandbox_id, sandbox_at, branch FROM grp WHERE id = ?")
    .get(grpId);
  if (!grp) return text("no such group", 404);
  const spec = specFor(ctx, grp.project_id);
  return json({
    group: { id: grp.id, name: grp.name, status: grp.status, branch: grp.branch },
    sandbox: {
      id: grp.sandbox_id,
      at: grp.sandbox_at,
      image: spec.image,
      cpu: spec.cpu,
      memory: spec.memory,
      ttlSeconds: spec.ttlSeconds,
      mounts: [
        ...Object.entries(spec.cacheDirs).map(([mountPath, hostPath]) => ({ mountPath, hostPath, readOnly: false })),
        ...skillMounts(ctx).map((m) => ({ mountPath: m.mountPath, hostPath: m.host?.path ?? "", readOnly: true })),
      ],
    },
    lines: sandboxLines(grpId),
  });
};

const getPreflight: Handler = async (ctx) =>
  json({
    checks: await preflight({
      db: ctx.db,
      sandbox: ctx.config.sandbox ?? { server: "127.0.0.1:8080", apiKey: "", image: "" },
      skillsDir: ctx.config.skillsDir,
    }),
  });

/**
 * The process that hands out containers, and what a restart of it would cost.
 *
 * Whether it is *healthy* is preflight's answer and stays preflight's answer —
 * two things saying "is it up" that can disagree is worse than one that is
 * occasionally stale. This is only what preflight cannot know: the pid, the
 * argv it was started with, and therefore whether there is anything to restart
 * it *with*. `runningServer` learns the argv by seeing the process, so an
 * orchestrator that booted while the server was already down has never seen one
 * and the button has to be dead rather than hopeful.
 *
 * The two counts are the evidence for that button (硬约束 5): a restart kills
 * every container and every turn inside them.
 */
const getSandboxServer: Handler = async (ctx) => {
  const live = runningServer();
  const count = (sql: string) => ctx.db.query<{ c: number }, []>(sql).get()!.c;
  // Inspect, never ensure. Which of the cases this is decides which button the
  // panel may show — and a GET that starts a process is a page that changes the
  // machine by being looked at.
  const state = await inspectServer(ctx);
  const drift = driftingPaths(ctx);
  return json({
    running: state.kind !== "down",
    addr: serverAddr(ctx),
    state: state.kind,
    why: "why" in state ? state.why : null,
    pid: "pid" in state ? state.pid : (live?.pid ?? null),
    config: state.kind === "started" ? state.config : (live?.config ?? null),
    argv: live?.argv ?? [],
    // Ours only. Restarting a server we did not start takes down whatever else
    // on this machine was using it, and nothing here can see what that was.
    restartable: !!ourArgv(ctx),
    // The silent one: a mount of a path missing from `allowed_host_paths`
    // succeeds and delivers an empty directory.
    drift,
    // Its own last words, when there are any. Shown rather than summarised: the
    // reason a start fails is almost always in here verbatim.
    log: state.kind === "down" ? serverLogTail(ctx, 8) : "",
    containers: count("SELECT count(*) AS c FROM grp WHERE sandbox_id IS NOT NULL"),
    runningTurns: count("SELECT count(*) AS c FROM job WHERE state = 'running'"),
  });
};

const postSandboxServerRestart: Handler = async (ctx) => {
  // `ourArgv`, not `runningServer().argv`. The panel only offers this when the
  // server is one we started; this is the same rule enforced where it matters,
  // because a request can arrive from anywhere and "restart" here means killing
  // a machine-wide process that may be somebody's own.
  const argv = ourArgv(ctx);
  if (!argv) {
    return bad(
      "这个沙盒服务器不是我们起的，不会去动它 —— 它可能是你自己起的，配的是别的东西。要重启就自己重启，之后这里会认得它。",
    );
  }
  const err = await restartServer(argv, serverLogPath(ctx));
  // A deliberate restart clears the automatic counter, or the boss restarts by
  // hand, it does not take, and the watchdog has already spent its three tries
  // on the same problem.
  resetServerRestarts();
  if (err) return bad(err);
  ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: "沙盒服务器重启了，容器都没了" });
  return json({ ok: true });
};

/** Point us at another server. The way out of "that one is not ours". */
const postSandboxServerAddr: Handler = async (ctx, req) => {
  const b = await body<{ addr?: string }>(req);
  const addr = (b.addr ?? "").trim();
  // `host:port`, or empty to fall back to the yaml. Checked because a bad value
  // here makes every container call fail somewhere far away from this box.
  if (addr && !/^[\w.-]+:\d{2,5}$/.test(addr)) return bad("填 host:port，比如 127.0.0.1:8081");
  setServerAddr(ctx, addr);
  return json({ ok: true, addr: serverAddr(ctx) });
};

/** Start one when there is none. The panel's way out of the `down` state. */
const postSandboxServerStart: Handler = async (ctx) => {
  const st = await ensureServer(ctx);
  if (st.kind === "down") return bad(st.why);
  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body: st.kind === "started" ? `沙盒服务器起好了（pid ${st.pid}）` : "沙盒服务器本来就在跑，直接用了",
  });
  return json({ ok: true, state: st.kind });
};

const ROUTES: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/api\/auth$/, getAuth],
  ["POST", /^\/api\/auth$/, postAuth],
  ["POST", /^\/api\/auth\/claude\/login$/, postClaudeLogin],
  ["POST", /^\/api\/auth\/claude\/login\/code$/, postClaudeCode],
  ["POST", /^\/api\/auth\/claude\/login\/cancel$/, postClaudeCancel],
  ["GET", /^\/api\/auth\/github$/, getGithubLogin],
  ["GET", /^\/api\/github\/repos$/, getGithubRepos],
  ["POST", /^\/api\/auth\/github$/, postGithubLogin],
  ["POST", /^\/api\/auth\/codex\/device$/, postCodexDevice],
  ["POST", /^\/api\/auth\/codex\/device\/cancel$/, postCodexDeviceCancel],
  ["GET", /^\/api\/preflight$/, getPreflight],
  ["GET", /^\/api\/sandbox-server$/, getSandboxServer],
  ["POST", /^\/api\/sandbox-server\/restart$/, postSandboxServerRestart],
  ["POST", /^\/api\/sandbox-server\/start$/, postSandboxServerStart],
  ["POST", /^\/api\/sandbox-server\/addr$/, postSandboxServerAddr],
  ["GET", /^\/api\/sandbox$/, getSandbox],
  ["GET", /^\/api\/project\/(?<id>\d+)\/config$/, getProjectConfig],
  ["POST", /^\/api\/project\/(?<id>\d+)\/config$/, patchProjectConfig],
  ["POST", /^\/orch\/status$/, postStatus],
  ["POST", /^\/orch\/journal$/, postJournal],
  ["POST", /^\/orch\/mail$/, postMail],
  ["POST", /^\/orch\/ask-boss$/, postAskBoss],
  ["POST", /^\/orch\/setup$/, postSetup],
  ["POST", /^\/orch\/lease$/, postLease],
  ["GET", /^\/orch\/lease\/(?<id>\d+)\/log$/, getLeaseLog],
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
  ["POST", /^\/orch\/drop$/, postDrop],
  ["POST", /^\/orch\/blocked$/, postBlocked],
  ["POST", /^\/orch\/split$/, postSplit],

  ["GET", /^\/api\/state$/, getState],
  ["GET", /^\/api\/cost$/, getCost],
  ["GET", /^\/api\/stream$/, getStream],
  ["GET", /^\/api\/dirs$/, getDirs],
  ["GET", /^\/api\/notes$/, getNotes],
  ["GET", /^\/api\/skills$/, getSkills],
  ["POST", /^\/api\/skills$/, postSkill],
  ["POST", /^\/api\/projects$/, postProject],
  ["DELETE", /^\/api\/projects\/(?<id>\d+)$/, deleteProject],
  ["POST", /^\/api\/ideas$/, postIdea],
  ["POST", /^\/api\/attach$/, postAttach],
  ["POST", /^\/api\/attach\/local$/, postAttachLocal],
  ["POST", /^\/api\/say$/, postSay],
  ["POST", /^\/api\/draft\/(?<id>\d+)\/(?<decision>approve|reject)$/, postDraftDecision],
  // No `landed`: whether a PR is merged is GitHub's answer, and `pollPrs` asks it
  // every tick. A button for it was a boss confirming by hand what the server
  // already knew — and one mis-click dissolved a group whose PR was still open.
  ["POST", /^\/api\/groups\/(?<id>\d+)\/(?<action>pause|resume|park|wake|interrupt|budget|drop|newpr|rebuild)$/, postGroupControl],
  ["GET", /^\/api\/slices\/(?<id>\d+)\/evidence$/, getEvidence],
  ["GET", /^\/api\/slices\/(?<id>\d+)\/gate\/(?<name>[\w.-]+)$/, getGateLog],
  ["POST", /^\/api\/slices\/(?<id>\d+)\/(?<decision>accept|reject)$/, postSliceDecision],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/answer$/, postAnswer],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/revoke$/, postRevoke],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/requirement$/, postEscalationRequirement],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/delegate$/, postDelegate],
  ["GET", /^\/api\/escalations\/(?<id>\d+)\/draft$/, getAnswerDraft],
  ["GET", /^\/api\/attach\/(?<name>[^/]+)$/, getAttachment],
];

/**
 * Is this write coming from somewhere other than the panel?
 *
 * `/api/*` takes no token — its caller is a browser on 127.0.0.1 and the port is
 * the whole authentication story. That stops the network and does not stop a web
 * page: `body<T>()` never checks `content-type`, so a POST with the default
 * `text/plain` is a *simple* request, no preflight, delivered. The attacker
 * cannot read the reply and does not need to — wiping the boss's credentials,
 * approving a DRAFT and dropping a group are all one-way.
 *
 * A deny-list, not an allow-list, because the legitimate non-browser callers —
 * `curl`, `bun test`, the mailbox replay — send neither header, and refusing
 * those would be refusing everything except the panel. Every browser that can
 * mount this attack sends `Sec-Fetch-Site`.
 */
export function crossSiteWrite(req: Request, port: number): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  const site = req.headers.get("sec-fetch-site");
  // Present on every modern browser request, and it says `same-origin` however
  // the boss spelled the host — `localhost` and `127.0.0.1` are the same page to
  // it and different strings to `Origin`.
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    return !loopback || u.port !== String(port);
  } catch {
    return true;
  }
}

export function makeApp(ctx: Ctx): (req: Request) => Promise<Response> {
  return async (req) => {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/api/") && crossSiteWrite(req, ctx.config.port ?? 47821)) {
      return text("cross-site writes are refused", 403);
    }
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
