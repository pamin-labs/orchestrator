import { join } from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import type { Ctx } from "../api.ts";
import { mintToken } from "../api.ts";
import type { Config, RoleDef } from "../config.ts";
import { modelFor } from "../config.ts";
import type { Executor, Job } from "../scheduler.ts";
import { assemble, buildStable, needsRotation, type Delta } from "../prompt/assemble.ts";
import { allowedToolsFor, writeProfile, type Clearance } from "../mech/clearance.ts";
import { say } from "../lang.ts";
import { listSkills, readSkill } from "../mech/skills.ts";
import { denyOutsideOwns, parseOwns } from "../mech/ownership.ts";
import { digestOutput, resolveLease, runResource, type ResourceDef } from "../mech/lease.ts";
import { checkpoint, changedSince, type GitRunner } from "../mech/worktree.ts";
import { recordTurnOutcome, runWatchdog } from "../mech/watchdog.ts";
import { runStandup } from "../mech/standup.ts";
import { route } from "../mech/chain.ts";
import {
  auditVerdict,
  handToBoss,
  handToQa,
  runDeterministicReview,
  runPrReview,
  sendBack,
} from "../mech/review.ts";
import { runTurn, type TurnResult } from "./claude.ts";
import { runTurn as runCodexTurn } from "./codex.ts";

/**
 * Turns a queued `job` into work that actually happens.
 *
 * Everything expensive or irreversible is decided here rather than in a prompt:
 * which model runs, whether the session must rotate, what the turn is told, and
 * what happens when the CLI reports a permission denial or a rate limit.
 */

export interface ExecDeps {
  ctx: Ctx;
  cfg: Config;
  roles: Map<string, RoleDef>;
  git: GitRunner;
  /** Wired by the server: opens the PR when a branch passes its audit. */
  onAuditPass?: (grpId: number) => void;
  /** Injectable for tests; defaults to the real `claude -p` adapter. */
  runTurn?: typeof runTurn;
}

interface AgentRow {
  id: number;
  grp_id: number | null;
  project_id: number | null;
  role: string;
  model: string;
  clearance: string;
  session_id: string | null;
  session_tokens: number;
  cwd: string | null;
  token: string | null;
  stable_hash?: string | null;
}

export function makeExecutor(deps: ExecDeps): Executor {
  return async (job) => {
    switch (job.kind) {
      case "agent_turn":
        return runAgentTurn(deps, job);
      case "lease":
        return runLease(deps, job);
      case "gate":
        return runGateJob(deps, job);
      case "watchdog":
        return runWatchdogJob(deps);
      case "reconcile":
        // PR level: every slice accepted, so reconcile and gate the whole branch
        // before the Auditor is asked for an opinion.
        return job.grp_id ? runPrReview({ ctx: deps.ctx, cfg: deps.cfg, git: deps.git }, job.grp_id) : undefined;
      default:
        // watchdog / notify / digest land in M3. Doing nothing is correct for
        // now; failing would poison the queue.
        return;
    }
  };
}

/** Find or hire the agent this job belongs to. */
export function resolveAgent(deps: ExecDeps, job: Job): AgentRow {
  const { ctx } = deps;
  if (job.agent_id) {
    const a = ctx.db.query<AgentRow, [number]>(SELECT_AGENT).get(job.agent_id);
    if (a) return a;
  }
  const payload = safeJson(job.payload_json);
  const roleName = String(payload.role ?? "engineer");
  const existing = ctx.db
    .query<AgentRow, [number | null, string]>(
      `${SELECT_AGENT_BASE} WHERE grp_id IS ? AND role = ? AND state != 'retired'`,
    )
    .get(job.grp_id, roleName);
  if (existing) return existing;
  let payloadProject = payload.project_id ? Number(payload.project_id) : null;
  if (!payloadProject && payload.audit) {
    payloadProject =
      ctx.db
        .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
        .get(Number(payload.audit))?.project_id ?? null;
  }
  return hire(deps, job.grp_id, roleName, job.slice_id, payloadProject);
}

const SELECT_AGENT_BASE = `SELECT id, grp_id, project_id, role, model, clearance, session_id, session_tokens, cwd, token, stable_hash FROM agent`;
const SELECT_AGENT = `${SELECT_AGENT_BASE} WHERE id = ?`;

export function hire(
  deps: ExecDeps,
  grpId: number | null,
  roleName: string,
  sliceId?: number | null,
  projectId?: number | null,
): AgentRow {
  const { ctx, cfg, roles } = deps;
  const role = roles.get(roleName);
  if (!role) throw new Error(`no role definition for ${roleName} (add roles/${roleName}.yaml)`);

  const difficulty = sliceId
    ? (ctx.db.query<{ difficulty: string }, [number]>("SELECT difficulty FROM slice WHERE id = ?").get(sliceId)
        ?.difficulty ?? null)
    : null;
  const grp = grpId
    ? ctx.db
        .query<{ project_id: number; worktree: string | null }, [number]>(
          "SELECT project_id, worktree FROM grp WHERE id = ?",
        )
        .get(grpId)
    : null;

  const row = ctx.db
    .query<{ id: number }, [number | null, number | null, string, string, string, string, string | null]>(
      `INSERT INTO agent (project_id, grp_id, role, model, clearance, token, cwd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    )
    .get(
      grp?.project_id ?? projectId ?? null,
      grpId,
      roleName,
      modelFor(cfg, role, difficulty),
      role.clearance,
      mintToken(),
      grp?.worktree ?? null,
    )!;

  ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config?.language, "hired", { role: roleName }),
  });
  return ctx.db.query<AgentRow, [number]>(SELECT_AGENT).get(row.id)!;
}

async function runAgentTurn(deps: ExecDeps, job: Job): Promise<void> {
  const { ctx, cfg, roles, git } = deps;
  const agent = resolveAgent(deps, job);
  const role = roles.get(agent.role);
  if (!role) throw new Error(`no role definition for ${agent.role}`);

  const grp = job.grp_id
    ? ctx.db
        .query<
          { id: number; name: string; project_id: number; worktree: string | null; owns_json: string },
          [number]
        >("SELECT id, name, project_id, worktree, owns_json FROM grp WHERE id = ?")
        .get(job.grp_id)
    : null;
  const project = grp
    ? ctx.db
        .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
        .get(grp.project_id)
    : null;

  const standingRepo = agent.grp_id
    ? null
    : (ctx.db
        .query<{ repo_path: string }, [number | null]>(
          "SELECT repo_path FROM project WHERE id = ?",
        )
        .get(
          ctx.db
            .query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?")
            .get(agent.id)?.project_id ?? null,
        )?.repo_path ?? null);
  const cwd = grp?.worktree ?? project?.repo_path ?? standingRepo ?? process.cwd();
  const stable = buildStableFor(deps, agent, role, grp, project?.repo_path ?? standingRepo ?? cwd, job);

  // A changed stable half means the cached prefix is dead. Rotating is cheaper
  // than paying full price for every remaining turn of this session.
  const rotate =
    needsRotation(agent.stable_hash ?? null, stable) ||
    overTokenBudget(agent, cfg) ||
    Boolean(safeJson(job.payload_json).rotate);

  const sessionId = rotate || !agent.session_id ? crypto.randomUUID() : agent.session_id;
  const delta = buildDeltaFor(deps, agent, job, rotate);

  // Checkpoint first: intercept L3's rollback and "undo a stand-in's answer"
  // both need a consistent state that exists before the turn starts.
  const before =
    grp?.worktree && project
      ? await checkpoint(git, project.repo_path, grp.worktree, `${agent.role} turn`)
      : null;

  // Reconcile compares against what changed *in this slice*, so the baseline is
  // whatever HEAD was when the slice's first turn began.
  if (job.slice_id && before) {
    ctx.db.run("UPDATE slice SET base_sha = coalesce(base_sha, ?) WHERE id = ?", [before, job.slice_id]);
  }
  // Recorded on the job so intercept L3 can roll back to exactly the state this
  // turn started from, even after the process is gone.
  if (before) ctx.db.run("UPDATE job SET checkpoint_sha = ? WHERE id = ?", [before, job.id]);

  ctx.db.run("UPDATE agent SET state = 'running', session_id = ? WHERE id = ?", [sessionId, agent.id]);

  const logDir = join(cfg.dataDir, "turns");
  mkdirSync(logDir, { recursive: true });

  // Which CLI runs a role is configuration, not a fork in the orchestrator.
  // An empty prompt is rejected outright by `claude -p`, and an agent woken with
  // nothing to read is a bug upstream — but crashing the turn hides it, so say
  // what happened instead.
  const prompt =
    assemble(stable, delta).prompt.trim() ||
    "You were woken with nothing new to read. Check `orch task list` and " +
      "`orch ctx query` for your current situation, and if there is genuinely " +
      "nothing to do, say so in one line and stop.";

  const run = deps.runTurn ?? (role.runtime === "codex" ? runCodexTurn : runTurn);
  let result: TurnResult;
  try {
    result = await run(
      {
        stable,
        prompt,
        cwd,
        resumeSessionId: rotate || !agent.session_id ? undefined : sessionId,
        newSessionId: rotate || !agent.session_id ? sessionId : undefined,
        maxTurns: cfg.maxTurnsPerJob,
        timeoutMs: cfg.turnTimeoutMs,
        logPath: join(logDir, `${job.id}.jsonl`),
        env: {
          ORCH_URL: process.env.ORCH_URL ?? `http://127.0.0.1:${cfg.port}`,
          ORCH_TOKEN: agent.token ?? "",
          ORCH_GRP_ID: String(job.grp_id ?? ""),
          // `orch` has to be a real executable on PATH; the shim is written at
          // server start so it always matches the running source.
          PATH: `${process.env.ORCH_BIN_DIR ?? join(cfg.dataDir, "bin")}:${process.env.PATH ?? ""}`,
        },
      },
      {
        onText: (t) => ctx.bus.live({ grpId: job.grp_id, projectId: agent.project_id ?? null, agentId: agent.id, role: agent.role, kind: "text", body: t }),
        onThinking: (t) =>
          ctx.bus.live({ grpId: job.grp_id, projectId: agent.project_id ?? null, agentId: agent.id, role: agent.role, kind: "thinking", body: t }),
        onTool: (t) => {
          // A name with no detail is the streaming placeholder; overwriting a good
          // line with "Bash" makes the desk wall less informative, not more.
          if (t.detail === t.name) return;
          ctx.db.run("UPDATE agent SET activity = ? WHERE id = ?", [t.detail, agent.id]);
          ctx.bus.live({ grpId: job.grp_id, projectId: agent.project_id ?? null, agentId: agent.id, role: agent.role, kind: "tool", body: t.detail });
        },
        onStatus: (s) => ctx.bus.live({ grpId: job.grp_id, projectId: agent.project_id ?? null, agentId: agent.id, role: agent.role, kind: "status", body: s }),
        onPid: (pid) => ctx.db.run("UPDATE job SET pid = ? WHERE id = ?", [pid, job.id]),
      },
    );
  } finally {
    ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ? AND state = 'running'", [agent.id]);
  }

  recordCost(deps, agent, job, result, stable.hash);
  recordProgress(deps, agent, job, result);
  await narrate(deps, agent, job, grp, project?.repo_path ?? null, before, result);
  handleDenials(deps, agent, job, result);
  handleRateLimit(deps, agent, job, result);

  if (!result.ok) throw new Error(`turn failed (${result.terminalReason}): ${clip(result.text)}`);
}

function buildStableFor(
  deps: ExecDeps,
  agent: AgentRow,
  role: RoleDef,
  grp: { worktree: string | null; name: string; owns_json?: string } | null | undefined,
  repoPath: string,
  job: Job,
) {
  const { ctx, cfg } = deps;
  const worktree = grp?.worktree ?? repoPath;

  const siblings = ctx.db
    .query<{ worktree: string | null }, [number | null]>(
      "SELECT worktree FROM grp WHERE worktree IS NOT NULL AND id IS NOT ?",
    )
    .all(job.grp_id)
    .map((r) => r.worktree!)
    .filter(Boolean);

  const clearance = (agent.clearance as Clearance) ?? "L1";

  // Confine the group to the paths it owns. Deny-only sandbox, so this is the
  // complement: the worktree's top-level entries the group did not claim.
  const owns = parseOwns(grp?.owns_json ?? null);
  const extraDenyWrite = owns.length
    ? denyOutsideOwns(worktree, owns, (rel) => topLevel(rel ? join(worktree, rel) : worktree))
    : [];

  const settingsPath = writeProfile(join(cfg.dataDir, "profiles"), `${agent.id}-${clearance}`, {
    clearance,
    worktree,
    repoPath,
    siblingWorktrees: siblings,
    extraDenyWrite,
  });

  const projectId = ctx.db
    .query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?")
    .get(agent.id)?.project_id ?? null;

  const onboarding = noteBody(ctx, projectId, "onboarding");
  const lessons = ctx.db
    .query<{ body: string }, [number | null]>(
      "SELECT body FROM note WHERE kind = 'lesson' AND (project_id IS ? OR project_id IS NULL) ORDER BY at DESC LIMIT 20",
    )
    .all(projectId)
    .map((r) => r.body);

  return buildStable({
    rolePrompt: role.prompt,
    onboarding: onboarding ?? undefined,
    lessons,
    language: cfg.language,
    model: agent.model,
    allowedTools: role.allowedTools ?? allowedToolsFor(agent.role, clearance),
    settingsPath,
    // Attachments the boss sent with the idea live in the data dir, so the agent
    // has to be allowed to open them. Without this, a screenshot is a path the
    // sandbox refuses to read.
    addDirs: [worktree, join(deps.cfg.dataDir, "attachments")],
  });
}

/**
 * What this turn is told, and nothing more.
 *
 * Everything here is appended to the newest user message. Never merge any of it
 * into the stable half — that is the 3-5x mistake.
 */
function buildDeltaFor(deps: ExecDeps, agent: AgentRow, job: Job, rotated: boolean): Delta {
  const { ctx } = deps;
  const payload = safeJson(job.payload_json);
  const delta: Delta = {};

  if (payload.escalation) {
    const esc = ctx.db
      .query<{ id: number; question: string; severity: string; agent_id: number | null }, [number]>(
        "SELECT id, question, severity, agent_id FROM escalation WHERE id = ?",
      )
      .get(Number(payload.escalation));
    if (esc) {
      const asker =
        esc.agent_id !== null
          ? (ctx.db.query<{ role: string }, [number]>("SELECT role FROM agent WHERE id = ?").get(esc.agent_id)
              ?.role ?? "someone")
          : "someone";
      delta.card =
        `${asker} is blocked and asked (severity ${esc.severity}):\n${esc.question}\n\n` +
        `Answer it with \`orch answer ${esc.id} --answer "…"\`, or pass it up with ` +
        `\`orch answer ${esc.id} --abstain --why "…"\`. Abstaining is the right move if you are ` +
        `not sure — a guess becomes a premise the whole group then reasons from.`;
    }
  }
  if (payload.mail) {
    const m = payload.mail as Record<string, unknown>;
    const grpNote = m.from_group ? ` (group ${m.from_group})` : "";
    delta.card =
      `${m.from}${grpNote} sent you a "${m.intent}":\n${m.body}\n\n` +
      (m.intent === "ask"
        ? "Reply with `orch mail " +
          String(m.from) +
          ' --intent inform "…"`. If it needs a decision above your level, pass it up.'
        : "");
  }
  if (payload.boundary) {
    const groups = Array.isArray(payload.boundary)
      ? (payload.boundary as Array<{ id: number; name: string; idea?: string }>)
      : [{ id: Number(payload.boundary), name: String(payload.boundary), idea: undefined }];
    delta.card =
      `This project now has more than one live group, so every one of them needs a path ` +
      `boundary before work is planned inside it. Cut all of them now — each group's own ` +
      `requirement is quoted so you can tell them apart:\n\n` +
      groups
        .map(
          (g) =>
            `${g.name} (group ${g.id}) wants: ${g.idea || "(no requirement recorded)"}\n` +
            `  orch owns ${g.id} --path "<glob>" --path "<glob>"`,
        )
        .join("\n\n") +
      `\n\nGive each group the paths ITS OWN requirement needs — a group told to add a new ` +
      `file needs a directory or a glob, not a list of files that already exist. Overlapping ` +
      `groups cannot run in parallel, so make them disjoint. Shared files (manifests, ` +
      `lockfiles, schemas, CI config) belong to no group — leave them out.`;
  }
  if (payload.audit) {
    const gid = Number(payload.audit);
    const branch = payload.audit_branch ? String(payload.audit_branch) : null;
    delta.card =
      `Audit group ${payload.audit_group ?? gid} (group_id ${gid}) before the boss merges it.\n` +
      (branch
        ? `Its branch is ${branch}; you are in the main checkout, so read it with ` +
          `\`git diff main...${branch}\` and \`git log main..${branch}\`.\n`
        : "") +
      `Coverage against the DRAFT card, architectural consistency, and whether the journals ` +
      `describe what the diff does. Do NOT re-check what the gate covered.\n\n` +
      `File your verdict with exactly:\n` +
      `  orch audit ${gid} --verdict pass|fail --note "what is missing or inconsistent"`;
  }
  if (payload.digest && typeof payload.digest === "object") {
    const d = payload.digest as { channel_id?: number; from?: number; to?: number };
    const rows = ctx.db
      .query<{ seq: number; author: string; body: string }, [number, number, number]>(
        `SELECT seq, author, body FROM event
         WHERE channel_id = ? AND seq > ? AND seq <= ? AND kind IN ('say','boss_say','note','escalation')
         ORDER BY seq LIMIT 400`,
      )
      .all(d.channel_id ?? 0, d.from ?? 0, d.to ?? 0);
    delta.card =
      `Compress this channel backlog so nobody has to read it again. ${rows.length} events, ` +
      `seq ${d.from}..${d.to}.\n\n` +
      `File ONE note: \`orch journal add --kind journal -\`, at most 6 lines, covering what was ` +
      `decided, what is still open, and anything a later turn must not re-litigate. Names and ` +
      `file paths verbatim; drop the pleasantries.\n\n` +
      rows.map((r) => `[${r.seq}] ${r.author}: ${r.body}`).join("\n").slice(0, 20_000);
  }
  if (Array.isArray(payload.sediment)) {
    delta.card =
      `The boss has said the same thing ${payload.sediment.length} times now, to different groups. ` +
      `A fact attached to one group is invisible to the next, so this has to become a project rule.\n\n` +
      payload.sediment.map((t: unknown, i: number) => `${i + 1}. ${String(t)}`).join("\n") +
      `\n\nWrite ONE rule with \`orch journal add --kind lesson -\` — at most 6 lines, phrased as an ` +
      `instruction a later group can follow without knowing this history ("QA 必须…", not "老板不满意…"). ` +
      `If these are not actually the same complaint, say so with \`orch mail cos --intent note\` and write nothing.`;
  }
  if (payload.idea) delta.card = `The boss wants: ${payload.idea}`;
  if (payload.respec) delta.rejection = `The boss sent the DRAFT back: ${payload.respec}`;
  if (payload.rejection) delta.rejection = String(payload.rejection);

  if (job.slice_id) {
    const s = ctx.db
      .query<{ seq: number; title: string; accept_spec: string; difficulty: string }, [number]>(
        "SELECT seq, title, accept_spec, difficulty FROM slice WHERE id = ?",
      )
      .get(job.slice_id);
    if (s) {
      // The id, not just the sequence number: the verbs take the id, and giving an
      // agent an identifier it cannot use is the same mistake twice.
      delta.card =
        `Slice S${s.seq} (slice_id ${job.slice_id}) [${s.difficulty}]: ${s.title}\n` +
        `Accepted when: ${s.accept_spec}`;
      if (agent.role === "qa") {
        delta.card +=
          `\n\nFile your verdict with exactly:\n` +
          `  orch review ${job.slice_id} --verdict pass|fail --note "one line per criterion"`;
      }
    }
  } else if (job.grp_id && !payload.idea) {
    const slices = ctx.db
      .query<{ seq: number; title: string; status: string; difficulty: string }, [number]>(
        "SELECT seq, title, status, difficulty FROM slice WHERE grp_id = ? ORDER BY seq",
      )
      .all(job.grp_id);
    if (slices.length) {
      delta.card = slices
        .map((s) => `S${s.seq} [${s.difficulty}] ${s.title} — ${s.status}`)
        .join("\n");
    }
  }

  if (rotated) {
    const handoff = ctx.db
      .query<{ body: string }, [number | null]>(
        "SELECT body FROM note WHERE grp_id IS ? AND kind = 'handoff' ORDER BY at DESC LIMIT 1",
      )
      .get(job.grp_id);
    delta.handoff =
      (handoff?.body ? `${handoff.body}\n\n` : "") +
      "This is a fresh session. Use `orch ctx query` for anything you are missing " +
      "rather than assuming you remember it.";
  }

  const unread = readUnread(ctx, agent, job.grp_id, deps.cfg);
  // Skill text, read off the host for this turn only. The names travelled on the
  // payload; the bodies are not stored anywhere, so editing a SKILL.md takes effect
  // on the next turn that asks for it.
  const wanted = Array.isArray(payload.skills) ? payload.skills.map(String) : [];
  if (wanted.length) {
    const repo = ctx.db
      .query<{ repo_path: string }, [number | null]>(
        "SELECT p.repo_path FROM project p JOIN grp g ON g.project_id = p.id WHERE g.id = ?",
      )
      .get(job.grp_id ?? null)?.repo_path;
    const all = listSkills(repo);
    const found = wanted.map((n) => all.find((s) => s.name === n)).filter((s): s is NonNullable<typeof s> => !!s);
    if (found.length) delta.skills = found.map(readSkill).join("\n\n");
  }

  if (unread) delta.unread = unread;

  // A payload key nobody renders means the agent is woken with no instruction —
  // it happened twice (a mailed message, then a boundary request) and both times
  // the agent improvised something reasonable-looking and did not do the job.
  const unhandled = Object.keys(payload).filter((k) => !PAYLOAD_KEYS.has(k));
  if (unhandled.length) {
    ctx.bus.emit({
      grpId: job.grp_id,
      author: "orchestrator",
      kind: "state_change",
      body: `job ${job.id} carried payload keys nothing renders: ${unhandled.join(", ")}`,
      meta: { unhandled, job: job.id },
    });
  }

  return delta;
}

/**
 * Payload keys the delta builder knows about.
 *
 * Anything else is a bug at the enqueue site, and a silent one: the turn still
 * runs, the agent still answers, and the work simply does not happen.
 */
const PAYLOAD_KEYS = new Set([
  "role",
  "idea",
  "respec",
  "rejection",
  "rotate",
  "mail",
  "escalation",
  "boundary",
  "conflict",
  "audit",
  "audit_branch",
  "audit_group",
  "review",
  "skills",
  "digest",
  "sediment",
  "project_id",
  "onboarding",
  "lease_id",
]);

/** Channel delta since this agent's cursor, then advance it. */
/**
 * Unread channel events, and what to do when there are too many.
 *
 * The cursor only ever advances to the last row actually handed over, so a backlog is
 * not lost — but it drains 30 per turn, and an agent that comes back to 200 events
 * spends six turns reading history at full price. PLAN.md §7 puts the Librarian here:
 * past the threshold it compresses the run into one note, and the compression itself
 * is an event so the boss can see what was compressed.
 */
function readUnread(ctx: Ctx, agent: AgentRow, grpId: number | null, cfg?: Config): string | null {
  if (!grpId) return null;
  const ch = ctx.db
    .query<{ id: number }, [number]>("SELECT id FROM channel WHERE grp_id = ? LIMIT 1")
    .get(grpId);
  if (!ch) return null;

  const cur =
    ctx.db
      .query<{ last_seq: number }, [number, number]>(
        "SELECT last_seq FROM cursor WHERE agent_id = ? AND channel_id = ?",
      )
      .get(agent.id, ch.id)?.last_seq ?? 0;

  const limit = cfg?.unreadDigestThreshold ?? 30;
  const rows = ctx.db
    .query<{ seq: number; author: string; intent: string | null; body: string }, [number, number, number]>(
      `SELECT seq, author, intent, body FROM event
       WHERE channel_id = ? AND seq > ? AND kind IN ('say', 'boss_say', 'note', 'escalation')
       ORDER BY seq LIMIT ?`,
    )
    .all(ch.id, cur, limit);
  if (rows.length === 0) return null;

  // A full page means there is probably more behind it. Hand this page over, and put
  // the Librarian on the rest — once: a queued digest already covers the backlog.
  let tail = "";
  if (rows.length >= limit) {
    const behind = ctx.db
      .query<{ c: number; hi: number }, [number, number]>(
        `SELECT count(*) AS c, max(seq) AS hi FROM event
         WHERE channel_id = ? AND seq > ? AND kind IN ('say', 'boss_say', 'note', 'escalation')`,
      )
      .get(ch.id, rows.at(-1)!.seq)!;
    if (behind.c > 0) {
      const queued = ctx.db
        .query<{ c: number }, [number]>(
          `SELECT count(*) AS c FROM job WHERE kind = 'agent_turn' AND state IN ('pending','running')
           AND json_extract(payload_json, '$.digest.channel_id') = ?`,
        )
        .get(ch.id)!.c;
      if (queued === 0) {
        ctx.sched.enqueue("agent_turn", {
          grp_id: grpId,
          priority: 2,
          payload: { role: "librarian", digest: { channel_id: ch.id, from: rows.at(-1)!.seq, to: behind.hi } },
        });
      }
      tail = `\n\n(${behind.c} 条更早的还没读，Librarian 正在压成一条摘要，别自己去翻)`;
      ctx.bus.emit({
        grpId,
        author: "orchestrator",
        kind: "state_change",
        body: say(ctx.config?.language, "unread.digest", { n: behind.c }),
        meta: { channel_id: ch.id, behind: behind.c },
      });
    }
  }

  const last = rows.at(-1)!.seq;
  ctx.db.run(
    `INSERT INTO cursor (agent_id, channel_id, last_seq) VALUES (?, ?, ?)
     ON CONFLICT (agent_id, channel_id) DO UPDATE SET last_seq = excluded.last_seq`,
    [agent.id, ch.id, last],
  );
  return rows.map((r) => `${r.author}${r.intent ? ` (${r.intent})` : ""}: ${r.body}`).join("\n") + tail;
}

function recordCost(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult, stableHash: string): void {
  const { ctx } = deps;
  const total = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheCreate;
  ctx.db.run(
    `UPDATE agent SET session_tokens = session_tokens + ?, total_tokens = total_tokens + ?,
     total_usd = total_usd + ?, stable_hash = ? WHERE id = ?`,
    [total, total, r.costUsd, stableHash, agent.id],
  );
  if (job.slice_id) {
    ctx.db.run("UPDATE slice SET spent_tokens = spent_tokens + ?, spent_usd = spent_usd + ? WHERE id = ?", [
      total,
      r.costUsd,
      job.slice_id,
    ]);
  }
  if (job.grp_id) {
    ctx.db.run("UPDATE grp SET spent_tokens = spent_tokens + ?, spent_usd = spent_usd + ? WHERE id = ?", [
      total,
      r.costUsd,
      job.grp_id,
    ]);
  }
  // cacheRead vs input is the only visible signal that the prompt cache is
  // still working. A sudden drop means someone broke assemble.ts.
  ctx.bus.emit({
    grpId: job.grp_id,
    author: agent.role,
    kind: "tool_summary",
    body: `turn done (${r.numTurns} steps, $${r.costUsd.toFixed(4)})`,
    meta: { usage: r.usage, costUsd: r.costUsd, cacheRatio: cacheRatio(r), model: agent.model },
  });
}

/**
 * Feed the watchdog's counters. "Wrote nothing" is three checks we can make
 * ourselves — a file changed, a task moved, a note appeared — because an agent
 * asked whether it made progress always says yes.
 */
function recordProgress(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult): void {
  const { ctx } = deps;
  const since = Date.now() - 5 * 60_000;
  const wroteNote =
    ctx.db
      .query<{ c: number }, [number | null, number]>(
        "SELECT count(*) AS c FROM note WHERE grp_id IS ? AND at > ?",
      )
      .get(job.grp_id, since)!.c > 0;
  const movedTask =
    ctx.db
      .query<{ c: number }, [number]>(
        "SELECT count(*) AS c FROM task WHERE owner_agent_id = ? AND status = 'done'",
      )
      .get(agent.id)!.c > 0;
  recordTurnOutcome(ctx, agent.id, r.filesTouched, wroteNote, movedTask);
}

export function cacheRatio(r: TurnResult): number {
  const denom = r.usage.cacheRead + r.usage.cacheCreate + r.usage.input;
  return denom === 0 ? 0 : r.usage.cacheRead / denom;
}

/**
 * The timeline gets written for free from what the turn already did — files
 * changed, commands run, state moved. Agents are not asked to narrate for the
 * boss's benefit; that would be tokens spent on prose.
 */
async function narrate(
  deps: ExecDeps,
  agent: AgentRow,
  job: Job,
  grp: { worktree: string | null } | null | undefined,
  repoPath: string | null,
  before: string | null,
  r: TurnResult,
): Promise<void> {
  const { ctx, git } = deps;
  for (const t of r.toolSummaries.slice(0, 12)) {
    ctx.bus.emit({ grpId: job.grp_id, author: agent.role, kind: "tool_summary", body: t.detail });
  }

  let files = r.filesTouched;
  if (before && grp?.worktree && repoPath) {
    const changed = await changedSince(git, repoPath, grp.worktree, before);
    if (changed.length) files = changed;
  }
  if (files.length) {
    ctx.bus.emit({
      grpId: job.grp_id,
      author: agent.role,
      kind: "commit",
      body: files.slice(0, 20).join(", "),
      meta: { files, checkpoint: before },
    });
  }
}

/**
 * A headless run never prompts, so a denied tool call is silent and the agent
 * quietly invents a workaround. Surfacing it as an escalation is the only way
 * the boss ever finds out.
 */
/**
 * What was denied, in a line a human can read.
 *
 * The raw payload went straight into the escalation text, so the question the
 * boss was asked to answer opened with `[{"tool_name":"Bash","tool_use_id":…` and
 * was truncated mid-JSON. Shape differs per adapter (claude: `tool_name` +
 * `tool_input`, codex: `tool` + `message`), so read defensively.
 */
export function denialSummary(denials: unknown[]): string {
  return denials
    .map((d) => {
      const o = (d ?? {}) as Record<string, any>;
      const tool = o.tool_name ?? o.tool ?? "tool";
      const what = o.tool_input?.command ?? o.message ?? o.tool_input?.file_path ?? JSON.stringify(o.tool_input ?? o);
      return `${tool}: ${String(what).split("\n")[0]!.trim().slice(0, 120)}`;
    })
    .join("; ")
    .slice(0, 500);
}

function handleDenials(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult): void {
  if (r.permissionDenials.length === 0) {
    // It found a legal route. Nothing else ever closed these, so they accumulated
    // as advisories nobody would ever answer — and an open question is not inert:
    // it counts as "this group is waiting on someone" everywhere that looks.
    deps.ctx.db.run(
      `UPDATE escalation SET chain_state = 'answered', answered_by = 'orchestrator',
         answer = 'the agent found a permitted route on a later turn'
       WHERE agent_id = ? AND answer IS NULL AND question LIKE 'blocked by clearance:%'`,
      [agent.id],
    );
    return;
  }
  const { ctx } = deps;
  const summary = denialSummary(r.permissionDenials);

  // One row per agent, not one per denial. An agent that keeps reaching for the
  // same forbidden shape files the same escalation every turn — nine of them piled
  // up on one group, none answered, all of them reading as work waiting on someone.
  // A repeat is a reminder, not a new problem.
  const open = ctx.db
    .query<{ id: number }, [number]>(
      "SELECT id FROM escalation WHERE agent_id = ? AND answer IS NULL AND question LIKE 'blocked by clearance:%'",
    )
    .get(agent.id);
  if (!open) {
    const row = ctx.db
      .query<{ id: number }, [number | null, number, string]>(
        `INSERT INTO escalation (grp_id, agent_id, severity, question, created_at)
         VALUES (?, ?, 'advisory', ?, unixepoch() * 1000) RETURNING id`,
      )
      .get(job.grp_id, agent.id, `blocked by clearance: ${summary}`)!;
    // Route it, or it sits at the default chain_state forever: the PM it was
    // addressed to is never told, and it never climbs to anyone who could answer.
    route({ ctx }, row.id);
  }
  // Escalate the agent, not the whole group: the PM or Architect can often
  // point at a legal route, and stopping everyone for one denial is noisy.
  ctx.db.run("UPDATE agent SET state = 'blocked' WHERE id = ?", [agent.id]);
  ctx.bus.emit({
    grpId: job.grp_id,
    author: agent.role,
    kind: "escalation",
    intent: "ask",
    severity: "advisory",
    body: `clearance blocked a call: ${summary}`,
  });
}

/**
 * Hitting the account's rate limit, per PLAN.md §11: drop a tier and keep going; if
 * there is nothing cheaper, wait for the reset — not for the boss.
 *
 * Before this it only paused. The system exists so work happens while the boss is
 * asleep, and one 429 at 01:00 stopped everything until morning, which is the exact
 * failure it is supposed to prevent. The model is part of the cached prefix, so a
 * downgrade rotates the session by construction (`needsRotation` compares the hash) —
 * the retry starts a fresh session on the cheaper tier rather than re-reading an
 * expensive prefix at a new price.
 */
function handleRateLimit(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult): void {
  const rl = r.rateLimit;
  if (!rl || rl.status === "allowed") return;
  const { ctx, cfg } = deps;
  const cheaper = cfg.modelFallback?.[agent.model];

  if (cheaper) {
    ctx.db.run("UPDATE agent SET model = ?, session_id = NULL, session_tokens = 0 WHERE id = ?", [
      cheaper,
      agent.id,
    ]);
    ctx.bus.emit({
      grpId: job.grp_id,
      author: "orchestrator",
      kind: "state_change",
      body: say(ctx.config?.language, "rl.downgraded", { role: agent.role, from: agent.model, to: cheaper }),
      meta: { ...rl, from: agent.model, to: cheaper },
    });
    // Same work, cheaper tier, straight back in the queue.
    ctx.sched.enqueue("agent_turn", {
      grp_id: job.grp_id,
      agent_id: agent.id,
      slice_id: job.slice_id,
      priority: 4,
      payload: { ...(safeParse(job.payload_json) as object), rotate: true },
    });
    ctx.sched.tick();
    return;
  }

  // Already at the bottom tier: hold, and record when to try again so the watchdog
  // can restart it without anyone being awake.
  const resetsMs = rl.resetsAt ? rl.resetsAt * 1000 : Date.now() + 15 * 60_000;
  ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "state_change",
    body: say(ctx.config?.language, "rl.waiting", { at: new Date(resetsMs).toLocaleString() }),
    meta: rl,
  });
  if (job.grp_id) {
    ctx.db.run(
      "UPDATE grp SET status = 'PAUSED', paused_at = unixepoch() * 1000, rl_resets_at = ? WHERE id = ?",
      [resetsMs, job.grp_id],
    );
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function overTokenBudget(agent: AgentRow, cfg: Config): boolean {
  // Fallback trigger only. The real rotation point is slice completion, which
  // is a clean semantic boundary and makes the handoff cheap.
  const ceiling = 200_000 * cfg.sessionRotateFraction;
  return agent.session_tokens > ceiling;
}

/**
 * The deterministic half of slice review: reconcile, then gate. Neither consults
 * a model, so a send-back can always be explained exactly.
 */
async function runGateJob(deps: ExecDeps, job: Job): Promise<void> {
  if (!job.slice_id) return;
  const rd = { ctx: deps.ctx, cfg: deps.cfg, git: deps.git };
  const out = await runDeterministicReview(rd, job.slice_id);
  if (out.pass) handToQa(rd, job.slice_id);
  else sendBack(rd, job.slice_id, out.feedback, "gate");
}

/**
 * The watchdog runs as an ordinary job, which is why it bypasses the group slot
 * pool: otherwise it could never fire on the very group that is stuck.
 */
async function runWatchdogJob(deps: ExecDeps): Promise<void> {
  const findings = await runWatchdog({ ctx: deps.ctx, cfg: deps.cfg, git: deps.git });
  for (const f of findings) deps.ctx.onFinding?.(f.rule, f.severity, f.body, f.grpId);

  // The standup rides along: same deterministic pass, and it sees across groups
  // in a way no single group's agents can.
  for (const item of runStandup(deps.ctx.db)) {
    deps.ctx.bus.emit({
      grpId: item.grpIds[0] ?? null,
      author: "standup",
      kind: "state_change",
      body: item.body,
      meta: { kind: item.kind, groups: item.grpIds },
    });
    deps.ctx.onFinding?.(item.kind, "advisory", item.body, item.grpIds[0] ?? null);
  }
}

/** Called by the server when the Auditor files a PR-level verdict. */
export function makeAuditVerdict(deps: ExecDeps) {
  return (grpId: number, pass: boolean, note: string): void =>
    auditVerdict(
      { ctx: deps.ctx, cfg: deps.cfg, git: deps.git, onAuditPass: deps.onAuditPass },
      grpId,
      pass,
      note,
    );
}

/** Called by the server when QA files a verdict. */
export function makeReviewVerdict(deps: ExecDeps) {
  return (sliceId: number, pass: boolean, note: string): void => {
    const rd = { ctx: deps.ctx, cfg: deps.cfg, git: deps.git };
    if (pass) handToBoss(rd, sliceId);
    else sendBack(rd, sliceId, note || "QA rejected the slice", "qa");
  };
}

// -------------------------------------------------------------------- leases

async function runLease(deps: ExecDeps, job: Job): Promise<void> {
  const { ctx, cfg } = deps;
  const leaseId = Number(safeJson(job.payload_json).lease_id);
  const lease = ctx.db
    .query<{ id: number; resource: string; args_json: string; grp_id: number | null }, [number]>(
      "SELECT id, resource, args_json, grp_id FROM lease WHERE id = ?",
    )
    .get(leaseId);
  if (!lease) return;

  const def = loadResource(ctx, lease.resource);
  if (!def) return finishLease(deps, leaseId, 127, "unknown resource", undefined);

  // Re-validate at execution time. The queued args were checked on the way in,
  // but the resource template may have changed since.
  const resolved = resolveLease(def, safeJson(lease.args_json));
  if (!resolved.ok) return finishLease(deps, leaseId, 126, resolved.error, undefined);

  const cwd = leaseCwd(ctx, def, lease.grp_id);
  const logDir = join(cfg.dataDir, "leases");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${leaseId}.log`);

  // Stamp the commit this ran against: two failures at the same sha mean the
  // environment is the variable, not the code.
  const head = await deps.git(cwd, ["rev-parse", "HEAD"], cwd);
  ctx.db.run(
    "UPDATE lease SET state = 'running', head_sha = ?, started_at = unixepoch() * 1000 WHERE id = ?",
    [head.code === 0 ? head.out.trim() : null, leaseId],
  );
  ctx.bus.emit({
    grpId: lease.grp_id,
    author: "runner",
    kind: "tool_summary",
    body: `lease ${lease.resource} #${leaseId} started`,
  });

  // Same runner as the gates use. This used to spawn its own process, which meant
  // two implementations of "run a resource" and a timeout on only one of them.
  const out = await runResource(def, safeJson(lease.args_json) as Record<string, unknown>, {
    cwd,
    logPath,
    timeoutMs: cfg.leaseTimeoutMs,
  });
  if (!("digest" in out)) return finishLease(deps, leaseId, 126, out.error, logPath);
  finishLease(deps, leaseId, out.exitCode, out.digest.text, logPath);
}

function finishLease(
  deps: ExecDeps,
  leaseId: number,
  code: number,
  digest: string,
  logPath: string | undefined,
): void {
  const { ctx } = deps;
  ctx.db.run(
    `UPDATE lease SET state = ?, exit_code = ?, result_digest = ?, log_path = ?,
     ended_at = unixepoch() * 1000 WHERE id = ?`,
    [code === 0 ? "done" : "failed", code, digest, logPath ?? null, leaseId],
  );
  const grpId =
    ctx.db.query<{ grp_id: number | null }, [number]>("SELECT grp_id FROM lease WHERE id = ?").get(leaseId)
      ?.grp_id ?? null;
  ctx.bus.emit({
    grpId,
    author: "runner",
    kind: "lease_result",
    body: `lease #${leaseId} exit ${code}`,
    meta: { lease_id: leaseId, exit_code: code },
  });

  // Unblock the agent that is sitting in a blocking `orch lease` call.
  const w = ctx.waiters.get(`lease:${leaseId}`);
  ctx.waiters.delete(`lease:${leaseId}`);
  w?.(digest);
}

function leaseCwd(ctx: Ctx, def: ResourceDef, grpId: number | null): string {
  if (def.cwd) return def.cwd;
  if (grpId) {
    const g = ctx.db
      .query<{ worktree: string | null }, [number]>("SELECT worktree FROM grp WHERE id = ?")
      .get(grpId);
    if (g?.worktree) return g.worktree;
  }
  return process.cwd();
}

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
    argSchema: safeJson(r.arg_schema_json) as ResourceDef["argSchema"],
    errorRegex: r.error_regex ?? undefined,
    cwd: r.cwd ?? undefined,
  };
}

function noteBody(ctx: Ctx, projectId: number | null, kind: string): string | null {
  return (
    ctx.db
      .query<{ body: string }, [number | null, string]>(
        "SELECT body FROM note WHERE (project_id IS ? OR project_id IS NULL) AND kind = ? ORDER BY at DESC LIMIT 1",
      )
      .get(projectId, kind)?.body ?? null
  );
}

function topLevel(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function clip(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
