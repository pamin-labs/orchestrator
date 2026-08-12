import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { DB } from "./db.ts";
import type { Bus } from "./bus.ts";
import type { Scheduler } from "./scheduler.ts";
import type { RepoLock } from "./mech/gitlock.ts";
import { resolveLease, type ResourceDef } from "./mech/lease.ts";
import { createWorktree, type GitRunner } from "./mech/worktree.ts";
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
  /** Wired by the server: advances the review pipeline on a QA verdict. */
  reviewVerdict?: (sliceId: number, pass: boolean, note: string) => void;
  /** Wired by the server: the Auditor's PR-level verdict. */
  auditVerdict?: (grpId: number, pass: boolean, note: string) => void;
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
  if (WAKING.has(b.intent) && a.grp_id) {
    const t = ctx.db
      .query<{ id: number }, [number, string]>(
        "SELECT id FROM agent WHERE grp_id = ? AND role = ?",
      )
      .get(a.grp_id, b.target);
    if (t) ctx.sched.enqueue("agent_turn", { grp_id: a.grp_id, agent_id: t.id });
  }
  ctx.sched.tick();
  return text("ok");
};

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

const postAudit: Handler = async (ctx, req) => {
  const b = await body<{ group_id: number; verdict: string; note?: string }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  if (a.role !== "auditor") return bad(`${a.role} does not file audit verdicts`);
  if (b.verdict !== "pass" && b.verdict !== "fail") return bad("verdict must be pass or fail");
  // The Auditor is deliberately not a member of the group it reviews, so it is
  // the one role whose group check is inverted.
  if (a.grp_id === b.group_id) return bad("an auditor may not audit its own group");

  ctx.bus.emit({
    grpId: b.group_id,
    author: "auditor",
    kind: "gate_result",
    intent: "decision",
    body: `audit ${b.verdict}${b.note ? `: ${b.note}` : ""}`,
    meta: { verdict: b.verdict },
  });
  ctx.auditVerdict?.(b.group_id, b.verdict === "pass", b.note ?? "");
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
  return text(ctxQuery(ctx, a.grp_id, b.question, b.limit ?? CTX_BUDGET_CHARS));
};

/**
 * Retrieval is deliberately dumb for now: notes and events for this group,
 * keyword-scored, hard-capped. The cap matters more than the ranking — an
 * unbounded answer costs more than the file the agent was going to read.
 */
export const CTX_BUDGET_CHARS = 16_000; // ~4k tokens

export function ctxQuery(ctx: Ctx, grpId: number | null, question: string, budget = CTX_BUDGET_CHARS): string {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 2);
  const score = (s: string) => {
    const low = s.toLowerCase();
    return words.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0);
  };

  const notes = ctx.db
    .query<{ kind: string; body: string; export_path: string | null; at: number }, [number | null]>(
      `SELECT kind, body, export_path, at FROM note
       WHERE grp_id = ? OR grp_id IS NULL ORDER BY at DESC LIMIT 200`,
    )
    .all(grpId);

  const ranked = notes
    .map((n) => ({ n, s: score(n.body) + (n.kind === "lesson" || n.kind === "onboarding" ? 1 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const parts: string[] = [];
  let used = 0;
  for (const { n } of ranked) {
    const chunk = `## ${n.kind}${n.export_path ? ` (${n.export_path})` : ""}\n${n.body}`;
    if (used + chunk.length > budget) break;
    parts.push(chunk);
    used += chunk.length;
  }
  if (parts.length === 0) return "no matching notes. Try `orch ctx query` with different words, or read the code.";
  return parts.join("\n\n");
}

const getTasks: Handler = async (ctx, req) => {
  const grp = Number(new URL(req.url).searchParams.get("grp") ?? 0);
  const rows = ctx.db
    .query<any, [number]>(
      `SELECT t.id, t.title, t.status, t.slice_id, a.role AS owner
       FROM task t LEFT JOIN agent a ON a.id = t.owner_agent_id
       WHERE t.grp_id = ? ORDER BY t.id`,
    )
    .all(grp);
  return json(rows);
};

const postTaskClaim: Handler = async (ctx, req) => {
  const b = await body<{ task_id: number }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  const r = ctx.db.run(
    "UPDATE task SET owner_agent_id = ?, status = 'in_progress' WHERE id = ? AND owner_agent_id IS NULL",
    [a.id, b.task_id],
  );
  return r.changes ? text("ok") : bad("already claimed");
};

const postTaskDone: Handler = async (ctx, req) => {
  const b = await body<{ task_id: number; claim?: unknown }>(req);
  const a = agentOf(ctx, req);
  if (!a) return bad("unknown or missing agent token");
  // Unowned is fine: a group has one writer, so requiring an explicit claim only
  // adds a step that gets forgotten. Someone else's task is not.
  const done = ctx.db.run(
    `UPDATE task SET status = 'done', claim_json = ?, owner_agent_id = ?
     WHERE id = ? AND (owner_agent_id IS NULL OR owner_agent_id = ?)`,
    [JSON.stringify(b.claim ?? {}), a.id, b.task_id, a.id],
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
    escalations: db
      .query(
        `SELECT e.id, e.grp_id, e.severity, e.question, e.chain_state, e.answered_by, e.answer,
                e.created_at, a.role AS asker
         FROM escalation e LEFT JOIN agent a ON a.id = e.agent_id
         WHERE e.chain_state NOT IN ('answered', 'revoked') ORDER BY e.created_at`,
      )
      .all(),
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

  ctx.db.run(
    `UPDATE escalation SET answer = ?, answered_by = ?, chain_state = 'answered',
     answered_at = unixepoch() * 1000 WHERE id = ?`,
    [b.answer, b.answered_by ?? "boss", id],
  );
  ctx.bus.emit({
    grpId: esc.grp_id,
    author: b.answered_by ?? "boss",
    kind: "say",
    intent: "inform",
    body: b.answer,
    meta: { in_reply_to_escalation: id },
  });
  if (esc.severity === "blocker" && esc.grp_id) {
    ctx.db.run("UPDATE grp SET status = 'RUNNING' WHERE id = ? AND status IN ('PAUSED','PAUSING')", [
      esc.grp_id,
    ]);
  }

  const w = ctx.waiters.get(`escalation:${id}`);
  ctx.waiters.delete(`escalation:${id}`);
  w?.(b.answer);
  ctx.sched.tick();
  return text("ok");
};

const postIdea: Handler = async (ctx, req) => {
  const b = await body<{ project_id: number; text: string; name?: string }>(req);
  if (!b.text?.trim()) return bad("empty idea");
  const name = (b.name ?? slug(b.text)).slice(0, 40);
  const grp = ctx.db
    .query<{ id: number }, [number, string]>(
      "INSERT INTO grp (project_id, name, status, created_at) VALUES (?, ?, 'DRAFT', unixepoch() * 1000) RETURNING id",
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
  ctx.sched.enqueue("agent_turn", { grp_id: grp.id, payload: { role: "dispatcher", idea: b.text } });
  ctx.sched.tick();
  return json({ grp_id: grp.id, channel_id: ch.id });
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

  if (b.card) {
    const v = validateDraftCard(b.card);
    if (!v.ok) return bad(v.error);
    ctx.db.run("DELETE FROM slice WHERE grp_id = ?", [grpId]);
    const ins = ctx.db.prepare(
      `INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, created_at)
       VALUES (?, ?, ?, ?, ?, unixepoch() * 1000)`,
    );
    v.slices.forEach((s, i) => ins.run(grpId, i + 1, s.title, s.accept, s.difficulty));
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
  ctx.sched.tick();
  return text("ok");
};

const postGroupControl: Handler = async (ctx, _req, params) => {
  const grpId = Number(params.id);
  const action = params.action;
  if (action === "pause") {
    // PAUSING, not PAUSED: an in-flight turn cannot be stopped mid-flight, so
    // the honest state is "no new turns, waiting for the current one to land".
    ctx.db.run("UPDATE grp SET status = 'PAUSING' WHERE id = ? AND status = 'RUNNING'", [grpId]);
  } else if (action === "resume") {
    ctx.db.run("UPDATE grp SET status = 'RUNNING' WHERE id = ? AND status IN ('PAUSED','PAUSING')", [grpId]);
    ctx.sched.tick();
  } else if (action === "park") {
    ctx.sched.cancelPending(grpId, "parked");
    ctx.db.run("UPDATE grp SET status = 'PARKED' WHERE id = ?", [grpId]);
  } else {
    return bad(`unknown action ${action}`);
  }
  ctx.bus.emit({ grpId, author: "boss", kind: "state_change", body: action });
  return text("ok");
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
  const b = await body<{ name: string; repo_path: string; remote?: string }>(req);
  if (!b.name || !b.repo_path) return bad("name and repo_path required");
  const r = ctx.db
    .query<{ id: number }, [string, string, string | null]>(
      "INSERT INTO project (name, repo_path, remote, created_at) VALUES (?, ?, ?, unixepoch() * 1000) RETURNING id",
    )
    .get(b.name, b.repo_path, b.remote ?? null)!;
  return json({ id: r.id });
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

  ["GET", /^\/api\/state$/, getState],
  ["GET", /^\/api\/stream$/, getStream],
  ["POST", /^\/api\/projects$/, postProject],
  ["POST", /^\/api\/ideas$/, postIdea],
  ["POST", /^\/api\/draft\/(?<id>\d+)\/(?<decision>approve|reject)$/, postDraftDecision],
  ["POST", /^\/api\/groups\/(?<id>\d+)\/(?<action>pause|resume|park)$/, postGroupControl],
  ["POST", /^\/api\/slices\/(?<id>\d+)\/(?<decision>accept|reject)$/, postSliceDecision],
  ["POST", /^\/api\/escalations\/(?<id>\d+)\/answer$/, postAnswer],
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

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "idea"
  );
}
