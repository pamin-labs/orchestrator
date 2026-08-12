import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { DB } from "./db.ts";
import type { Bus } from "./bus.ts";
import type { Scheduler } from "./scheduler.ts";
import type { RepoLock } from "./mech/gitlock.ts";
import { resolveLease, type ResourceDef } from "./mech/lease.ts";
import { createWorktree, type GitRunner } from "./mech/worktree.ts";
import { interrupt, park, pause, resume, unpark } from "./mech/intercept.ts";
import { abstain, answer as chainAnswer, entryPoint, revoke, route, triage, type Triage } from "./mech/chain.ts";
import { canStart, parseOwns } from "./mech/ownership.ts";
import { startNextSlice } from "./mech/review.ts";
import { head, joinQueue, landed, position } from "./mech/mergequeue.ts";
import { costReport } from "./mech/cost.ts";
import { detectGates, detectShared } from "./mech/detect.ts";
import { preflightPr } from "./mech/prwatch.ts";
import { query as ctxQuery, DEFAULT_BUDGET } from "./mech/ctx.ts";
import { validateDraftCard, validateJournal } from "./mech/validate.ts";

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
  config: { language: string; difficultyModel: Record<string, string>; workRoot: string };
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
  ctx.bus.live({ grpId: a.grp_id, agentId: a.id, kind: "status", body: b.text ?? "" });
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

  ctx.bus.emit({
    grpId: a.grp_id,
    author: a.role,
    kind: "say",
    intent: b.intent,
    severity: b.severity ?? null,
    body: b.body,
    target: b.target,
    meta: { in_reply_to: b.in_reply_to ?? null },
  });

  // The recipient is an explicit parameter, not an `@` parsed out of prose:
  // waking someone means enqueueing an agent_turn for them, nothing more.
  if (WAKING.has(b.intent)) {
    const senderProject = ctx.db
      .query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?")
      .get(a.id)?.project_id ?? null;
    const target = resolveTarget(ctx, a.grp_id, b.target, senderProject);
    if (!target) {
      const known = (ctx.knownRoles?.() ?? []).join(", ");
      // Never a silent no-op: an unreachable recipient is exactly how an agent
      // ends up asking a wall twice and then giving up.
      return bad(`no such recipient "${b.target}". Roles that exist: ${known || "none configured"}`);
    }
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
  const b = await body<{ task_id: number; claim?: unknown; already_done?: string }>(req);
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
                spent_tokens, spent_usd FROM grp WHERE status != 'DISSOLVED'`,
      )
      .all(),
    slices: db
      .query(
        `SELECT id, grp_id, seq, title, accept_spec, difficulty, status, gates_json,
                spent_tokens, spent_usd FROM slice ORDER BY grp_id, seq`,
      )
      .all(),
    agents: db
      .query(
        `SELECT id, grp_id, role, model, clearance, state, activity, session_tokens,
                total_tokens, total_usd FROM agent WHERE state != 'retired'`,
      )
      .all(),
    tasks: db.query("SELECT id, grp_id, slice_id, title, status FROM task").all(),
    channels: db.query("SELECT id, project_id, grp_id, kind, status FROM channel").all(),
    // The card each DRAFT group filed. Without this the boss is shown an empty
    // box and asked to approve something they cannot see.
    draftCards: db
      .query(
        `SELECT n.grp_id AS grpId, n.body FROM note n
         JOIN grp g ON g.id = n.grp_id
         WHERE g.status = 'DRAFT' AND json_extract(n.frontmatter_json, '$.draft_card') = 1
         GROUP BY n.grp_id HAVING n.at = max(n.at)`,
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
                e.created_at, a.role AS asker
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
    lastSeq:
      ctx.db.query<{ s: number | null }, []>("SELECT max(seq) AS s FROM event").get()?.s ?? 0,
  };
}

const postAnswer: Handler = async (ctx, req, params) => {
  const b = await body<{ answer: string; answered_by?: string }>(req);
  const id = Number(params.id);
  const esc = ctx.db
    .query<{ grp_id: number | null; severity: string }, [number]>(
      "SELECT grp_id, severity FROM escalation WHERE id = ?",
    )
    .get(id);
  if (!esc) return text("no such escalation", 404);

  // The boss answers through the same path a stand-in would, so unblocking the
  // caller and un-pausing the group cannot drift between the two.
  const r = chainAnswer({ ctx, git: ctx.git }, { escId: id, by: b.answered_by ?? "boss", answer: b.answer });
  return r.ok ? text("ok") : bad(r.error);
};

const postIdea: Handler = async (ctx, req) => {
  const b = await body<{ project_id: number; text: string; name?: string }>(req);
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

  ctx.db.run(
    "INSERT INTO note (project_id, grp_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
    [b.project_id, grp.id, ctx.config.language, b.text],
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
      { id: grp.id, name },
      ...others.filter((o) => parseOwns(o.owns_json).length === 0).map((o) => ({ id: o.id, name: o.name })),
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
  const b = await body<{ card?: string; reason?: string }>(req);
  const grpId = Number(params.id);
  const approve = params.decision === "approve";

  if (!approve) {
    ctx.db.run(
      "INSERT INTO note (grp_id, kind, lang, body, at) VALUES (?, 'fact', ?, ?, unixepoch() * 1000)",
      [grpId, ctx.config.language, `boss sent the DRAFT back: ${b.reason ?? ""}`],
    );
    ctx.bus.emit({ grpId, author: "boss", kind: "boss_say", intent: "request", body: b.reason ?? "respec" });
    ctx.sched.enqueue("agent_turn", { grp_id: grpId, payload: { role: "dispatcher", respec: b.reason } });
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
        payload: { role: "architect", boundary: undeclared },
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
        ctx.bus.emit({ grpId, author: "orchestrator", kind: "state_change", body: `worktree ${wt.branch}` });
      } catch (e: any) {
        // Refuse to start rather than run the group in the main checkout, where
        // it would write straight into the boss's working tree.
        return bad(`could not create a worktree: ${e?.message ?? e}`);
      }
    }
  }

  ctx.db.run("UPDATE grp SET status = 'RUNNING' WHERE id = ?", [grpId]);
  ctx.bus.emit({ grpId, author: "boss", kind: "state_change", body: "DRAFT approved" });
  // Approving a plan that then sits still is the most confusing failure there is:
  // it looks like the system ignored you.
  startNextSlice(ctx, grpId);
  ctx.sched.tick();
  return text("ok");
};

const postGroupControl: Handler = async (ctx, req, params) => {
  const grpId = Number(params.id);
  const action = params.action;
  switch (action) {
    case "pause": {
      // Reports how many turns it is waiting on: PAUSING is honest, PAUSED
      // would not be while something is still in flight.
      const waiting = pause(ctx, grpId);
      return json({ status: waiting ? "PAUSING" : "PAUSED", waiting });
    }
    case "resume":
      resume(ctx, grpId);
      return text("ok");
    case "park":
      park(ctx, grpId, "you parked it");
      return text("ok");
    case "landed": {
      // The boss merged it. Everyone still queued now has a stale base.
      const stale = landed(ctx.db, grpId);
      ctx.bus.emit({ grpId, author: "boss", kind: "state_change", body: "merged into main" });

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
      return json({ staleGroups: stale });
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

const postSliceDecision: Handler = async (ctx, req, params) => {
  const b = await body<{ feedback?: string }>(req);
  const id = Number(params.id);
  const accept = params.decision === "accept";
  const sl = ctx.db
    .query<{ grp_id: number; title: string }, [number]>("SELECT grp_id, title FROM slice WHERE id = ?")
    .get(id);
  if (!sl) return text("no such slice", 404);

  ctx.db.run("UPDATE slice SET status = ? WHERE id = ?", [accept ? "accepted" : "rejected", id]);
  ctx.bus.emit({
    grpId: sl.grp_id,
    author: "boss",
    kind: accept ? "state_change" : "boss_say",
    intent: accept ? undefined : "request",
    body: accept ? `accepted: ${sl.title}` : (b.feedback ?? "rejected"),
    meta: { slice_id: id },
  });
  if (accept) {
    // Accepting one slice is what starts the next.
    startNextSlice(ctx, sl.grp_id);

    // The last acceptance is what starts PR-level review; nothing an agent does
    // can trigger it, because "the boss is satisfied" is not an agent's call.
    const open = ctx.db
      .query<{ c: number }, [number]>(
        "SELECT count(*) AS c FROM slice WHERE grp_id = ? AND status != 'accepted'",
      )
      .get(sl.grp_id)!.c;
    if (open === 0) {
      ctx.sched.enqueue("reconcile", { grp_id: sl.grp_id, priority: 5 });
    }
  }

  if (!accept) {
    ctx.db.run(
      "INSERT INTO note (grp_id, slice_id, kind, lang, body, at) VALUES (?, ?, 'fact', ?, ?, unixepoch() * 1000)",
      [sl.grp_id, id, ctx.config.language, b.feedback ?? "boss rejected the slice"],
    );
    ctx.sched.enqueue("agent_turn", { grp_id: sl.grp_id, slice_id: id, payload: { rejection: b.feedback } });
  }
  ctx.sched.tick();
  return text("ok");
};

const postProject: Handler = async (ctx, req) => {
  const b = await body<{ name: string; repo_path: string; remote?: string; gates?: string[] }>(req);
  if (!b.name || !b.repo_path) return bad("name and repo_path required");

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

const getStream: Handler = async (ctx, req) => {
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
  let unsub = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      const send = (data: unknown) => {
        try {
          c.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          unsub();
        }
      };
      for (const e of ctx.bus.since(since)) send({ type: "event", ...e });
      unsub = ctx.bus.subscribe(send);
      req.signal.addEventListener("abort", () => {
        unsub();
        try {
          c.close();
        } catch {}
      });
    },
    cancel() {
      unsub();
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

  ["GET", /^\/api\/state$/, getState],
  ["GET", /^\/api\/cost$/, getCost],
  ["GET", /^\/api\/stream$/, getStream],
  ["POST", /^\/api\/projects$/, postProject],
  ["POST", /^\/api\/ideas$/, postIdea],
  ["POST", /^\/api\/draft\/(?<id>\d+)\/(?<decision>approve|reject)$/, postDraftDecision],
  ["POST", /^\/api\/groups\/(?<id>\d+)\/(?<action>pause|resume|park|wake|interrupt|landed)$/, postGroupControl],
  ["POST", /^\/api\/slices\/(?<id>\d+)\/(?<decision>accept|reject)$/, postSliceDecision],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/answer$/, postAnswer],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/revoke$/, postRevoke],
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
