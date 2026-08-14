import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { Ctx } from "../api.ts";
import { imagePaths, mintToken } from "../api.ts";
import type { Config, RoleDef } from "../config.ts";
import { DEFAULT_PROVIDER, contextWindowFor, modelFor } from "../config.ts";
import type { Executor, Job } from "../scheduler.ts";
import { assemble, buildStable, needsRotation, type Delta } from "../prompt/assemble.ts";
import { say } from "../lang.ts";
import { listSkills, readSkill } from "../mech/skills.ts";
import { outsideOwns, parseOwns } from "../mech/ownership.ts";
import { digestOutput, resolveLease, runResource, type ResourceDef } from "../mech/lease.ts";
import { checkpoint, changedSince, defaultBase, type GitRunner } from "../mech/worktree.ts";
import { getFile, MAILBOX_DIR, resourceExec, runnerFor, WORK, type Scope } from "../mech/sandbox.ts";
import { ensureCheckout, publishBranch, sandboxGit } from "../mech/checkout.ts";
import { track, untrack } from "./running.ts";
import { absorbCodexHome, CODEX_HOME, isAuthFailure, vaultFor } from "../mech/auth.ts";
import { recordTurnOutcome, runWatchdog, REEMIT_MS } from "../mech/watchdog.ts";
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
import { type TurnResult } from "./claude.ts";
import { clampEffort, providerFor, type Provider } from "./providers.ts";

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
  /** Injectable for tests; defaults to whichever provider the role names. */
  runTurn?: Provider["run"];
}

interface AgentRow {
  id: number;
  grp_id: number | null;
  project_id: number | null;
  role: string;
  model: string;
  session_id: string | null;
  session_tokens: number;
  cwd: string | null;
  token: string | null;
  stable_hash?: string | null;
  /** What the CLI said this model's window is, once it has said it. */
  context_window?: number | null;
  /** Which provider this agent's turns run on. Frozen at hire. */
  runtime?: string | null;
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

const SELECT_AGENT_BASE = `SELECT id, grp_id, project_id, role, model, runtime, session_id, session_tokens, cwd, token, stable_hash, context_window FROM agent`;
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
    ? ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
    : null;

  const row = ctx.db
    .query<{ id: number }, [number | null, number | null, string, string, string, string, string]>(
      `INSERT INTO agent (project_id, grp_id, role, model, runtime, token, cwd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000) RETURNING id`,
    )
    .get(
      grp?.project_id ?? projectId ?? null,
      grpId,
      roleName,
      modelFor(cfg, role, difficulty),
      // Recorded, not looked up later: the scheduler has to know which account a
      // queued turn would spend without loading roles/*.yaml, and the role could
      // be re-pointed at another provider while this agent is mid-slice.
      role.runtime ?? DEFAULT_PROVIDER,
      mintToken(),
      // Every agent works in its sandbox's checkout; there is no host path left
      // for one to sit in.
      WORK,
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
          { id: number; name: string; project_id: number; branch: string | null; owns_json: string },
          [number]
        >("SELECT id, name, project_id, branch, owns_json FROM grp WHERE id = ?")
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
  // Always the sandbox's own checkout. There is no host path a turn can run in
  // any more, which is the point: nothing an agent does touches this machine.
  const cwd = WORK;
  const scope: Scope = job.grp_id ? { grp: job.grp_id } : { project: agent.project_id ?? 0 };
  const stable = buildStableFor(deps, agent, role, grp, project?.repo_path ?? standingRepo ?? cwd, job);

  // A changed stable half means the cached prefix is dead. Rotating is cheaper
  // than paying full price for every remaining turn of this session.
  const rotate =
    needsRotation(agent.stable_hash ?? null, stable) ||
    overTokenBudget(agent, cfg) ||
    Boolean(safeJson(job.payload_json).rotate);

  const sessionId = rotate || !agent.session_id ? crypto.randomUUID() : agent.session_id;
  const delta = buildDeltaFor(deps, agent, job, rotate);

  // A turn cannot run in an empty checkout, and an empty one is the normal state
  // after a sandbox is replaced — or for any group that predates this design and
  // has a branch but never had a clone. Idempotent, so this is one cheap exec.
  if (job.grp_id) {
    try {
      await ensureCheckout(ctx, job.grp_id);
    } catch (e: any) {
      throw new Error(`could not prepare the group's checkout: ${e?.message ?? e}`);
    }
  }

  // Checkpoint first: intercept L3's rollback and "undo a stand-in's answer"
  // both need a consistent state that exists before the turn starts.
  //
  // The label says which slice and what the writer had claimed it was doing.
  // `wip: engineer turn` eight times is a branch log that says nothing — and
  // these survive into review whenever squashWip declines (an agent that wrote
  // one real commit keeps all of them). A checkpoint is still a checkpoint, so
  // it stays marked `wip`, but the rest of the line is the work.
  const before = job.grp_id
    ? await checkpoint(sandboxGit(ctx, scope), WORK, WORK, checkpointLabel(ctx, agent, job))
    : null;

  // Reconcile compares against what changed *in this slice*, so the baseline is
  // whatever HEAD was when the slice's first turn began.
  if (job.slice_id && before) {
    ctx.db.run("UPDATE slice SET base_sha = coalesce(base_sha, ?) WHERE id = ?", [before, job.slice_id]);
  }
  // Recorded on the job so intercept L3 can roll back to exactly the state this
  // turn started from, even after the process is gone.
  if (before) ctx.db.run("UPDATE job SET checkpoint_sha = ? WHERE id = ?", [before, job.id]);

  ctx.db.run(
    rotate
      ? "UPDATE agent SET state = 'running', session_id = ?, session_tokens = 0 WHERE id = ?"
      : "UPDATE agent SET state = 'running', session_id = ? WHERE id = ?",
    [sessionId, agent.id],
  );

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

  // The agent's runtime, not the role's. `agent.model` was resolved against the
  // provider this agent was hired on and is frozen there; reading the CLI from the
  // role instead means an agent hired before its role was re-pointed runs the new
  // CLI with the old CLI's model id. Observed live: `codex exec -m claude-sonnet-5`
  // starting every turn with "Model metadata for claude-sonnet-5 not found".
  const provider = providerFor(agent.runtime ?? role.runtime);
  const run: Provider["run"] = deps.runTurn ?? provider.run;
  // codex reads AGENTS.md where claude reads CLAUDE.md. Same repo instructions,
  // different filename, so link them rather than asking every project to keep two.
  // Both runtimes, not just codex: the link that was missing is the one a claude
  // turn needs in a repo that only has AGENTS.md.
  linkAgentsMd(cwd);
  const logPath = join(logDir, `${job.id}.jsonl`);
  let result: TurnResult;
  try {
    result = await run(
      {
        stable,
        prompt,
        cwd,
        resumeSessionId: rotate || !agent.session_id ? undefined : sessionId,
        newSessionId: rotate || !agent.session_id ? sessionId : undefined,
        maxTurns: role.maxTurns ?? cfg.maxTurnsPerJob,
        timeoutMs: cfg.turnTimeoutMs,
        images: imagePaths(prompt),
        logPath,
        // Every turn runs inside a sandbox: the group's, or the project's when
        // the role is a standing one with no group. Nothing runs on the host.
        runner: runnerFor(ctx, scope),
        env: {
          // The mailbox, not a URL: the sandbox has no route to this machine on
          // any platform we can rely on, and the files API has one everywhere.
          ORCH_MAILBOX: MAILBOX_DIR,
          ORCH_TOKEN: agent.token ?? "",
          ORCH_GRP_ID: String(job.grp_id ?? ""),
          // Format-plausible fakes. The real values are in the egress sidecar
          // and get swapped in on the way out; nothing in here is worth stealing.
          ...vaultFor(ctx.db).env,
          // codex reads its login from a file, so it has to be told where.
          CODEX_HOME,
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
        onAbort: (stop) => track(job.id, stop),
      },
    );
  } finally {
    untrack(job.id);
    ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ? AND state = 'running'", [agent.id]);
    // Compress now rather than a day later. Nothing reads these while they are
    // warm — every consumer is a human debugging afterwards — and 24h of raw
    // NDJSON was most of the 59 MB this directory had grown to.
    gzipTurnLog(logPath);
  }

  // The id the runtime actually used, which is not always the one we minted.
  //
  // claude takes `--session-id <uuid>` and honours it, so minting one and storing
  // it is correct there. codex does not: `codex exec` starts a thread of its own
  // and reports it as `thread.started.thread_id`, and `codex exec resume` wants
  // THAT id. We stored the minted one, so every codex agent's second turn ran
  // `resume <our-uuid>` and died with `no rollout found for thread id …` — thirty
  // agents in this database, none of them holding a codex thread id. It reads as
  // an environment fault (a missing file, a lost session) rather than as a turn
  // that was never resumable, which is why it survived: the group looks healthy,
  // the engineer is on the roster, and the error is inside a rejection body.
  if (result.sessionId && result.sessionId !== sessionId) {
    ctx.db.run("UPDATE agent SET session_id = ? WHERE id = ?", [result.sessionId, agent.id]);
  }

  // The group's commits, back on the host, every turn. A sandbox is disposable
  // and this is what makes that true: a container that dies costs the turn in
  // flight and nothing else. Publishing only at PR time would have meant losing
  // everything since the last one, because a group's branch does not reach the
  // remote until then.
  if (job.grp_id && grp?.branch && project?.repo_path && git) {
    const kept = await publishBranch(ctx, scope, git, project.repo_path, grp.branch, `origin/${await defaultBase(git, project.repo_path)}`);
    if (!kept.ok && kept.reason && !/empty bundle/i.test(kept.reason)) {
      ctx.bus.emit({
        grpId: job.grp_id,
        author: "orchestrator",
        kind: "state_change",
        body: `could not take ${grp.branch} out of the sandbox: ${kept.reason}`,
      });
    }
  }

  // codex rotates its own tokens and rewrites auth.json, so the copy inside the
  // sandbox runs ahead of ours within hours. Reading it back is what keeps the
  // next sandbox able to log in at all.
  if (provider.name === "codex" && job.grp_id) {
    const rotated = await getFile(ctx, scope, `${CODEX_HOME}/auth.json`).catch(() => null);
    if (rotated) absorbCodexHome(ctx.db, rotated);
  }

  recordCost(deps, agent, job, result, stable.hash);
  recordProgress(deps, agent, job, result);
  await narrate(deps, agent, job, grp, project?.repo_path ?? null, before, result);
  handleRateLimit(deps, agent, job, result);
  handleAuthFailure(deps, agent, job, result);
  recordSubscriptionUsage(deps, provider.name, result);
  // Always, for every provider. The container is the write boundary and it knows
  // nothing about which files this group owns, so the reconcile runs after the
  // fact — it is not a codex workaround any more, it is the mechanism.
  await reconcileOwnership(deps, agent, job, grp, cwd);

  // A session whose transcript is gone on disk.
  //
  // Both CLIs resume by id and both fail the whole turn when the file behind it
  // is missing — codex with `thread/resume: no rollout found for thread id …`,
  // claude with `No conversation found with session ID`. `session_id` still
  // points at it, and rotation only fires on a changed prefix, a token budget or
  // an explicit flag, so every turn after that resumes the same dead id and dies
  // the same way. Live: composer-file-picker failed eight turns in a row and
  // looked healthy the whole time — an agent on the roster, no error anywhere
  // except inside a rejection body nobody parses.
  //
  // Clearing the id is the whole repair: the next turn starts a session. It
  // costs one uncached prefix, which is what a lost transcript costs.
  if (!result.ok && LOST_SESSION.test(result.text)) {
    ctx.db.run("UPDATE agent SET session_id = NULL, stable_hash = NULL WHERE id = ?", [agent.id]);
    ctx.bus.emit({
      grpId: job.grp_id,
      author: "orchestrator",
      kind: "state_change",
      body: `${agent.role} 的会话记录没了，下一轮从新会话开始`,
      meta: { agent_id: agent.id, lost_session: sessionId },
    });
  }

  if (!result.ok) throw new Error(`turn failed (${result.terminalReason}): ${clip(result.text)}`);
}

/** Both CLIs, both spellings. */
export const LOST_SESSION = /no rollout found for thread|No conversation found with session ID/i;

/**
 * What a turn's checkpoint commit says about itself.
 *
 * `wip(S2): engineer — 闸门放行的卡 enqueue 一个 cos turn`. The slice number is
 * where the reviewer looks first, the role is who did it, and the task title is
 * the only sentence anyone wrote about this particular piece of work.
 */
function checkpointLabel(ctx: Ctx, agent: AgentRow, job: Job): string {
  const seq = job.slice_id
    ? ctx.db.query<{ seq: number }, [number]>("SELECT seq FROM slice WHERE id = ?").get(job.slice_id)?.seq
    : undefined;
  const task = job.slice_id
    ? ctx.db
        .query<{ title: string }, [number]>(
          "SELECT title FROM task WHERE slice_id = ? AND status != 'done' ORDER BY id LIMIT 1",
        )
        .get(job.slice_id)?.title
    : undefined;
  const head = seq ? `S${seq}: ${agent.role}` : `${agent.role} turn`;
  return task ? `${head} — ${task.slice(0, 60)}` : head;
}

/**
 * The project's gate container, if it has one.
 *
 * `config_json.container` = `{"image":"oven/bun:1"}`, optionally with
 * `network`, `depsVolume` and `depsPath`. Absent means the host.
 */
function buildStableFor(
  deps: ExecDeps,
  agent: AgentRow,
  role: RoleDef,
  grp: { name: string; owns_json?: string } | null | undefined,
  repoPath: string,
  job: Job,
) {
  const { ctx, cfg } = deps;

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
    // Clamped to what this role's provider accepts before it is hashed, so the
    // prefix hash describes the turn that was actually sent.
    effort: clampEffort(agent.runtime ?? role.runtime, role.effort),
    // A role's own list, always. There is no clearance table behind it any more:
    // the sandbox is the boundary, so this only decides which tool definitions
    // are loaded into the prefix and which roles may search the web.
    allowedTools: role.allowedTools ?? ["Bash", "Read", "Grep", "Glob"],
    settingsPath: "",
    addDirs: [WORK],
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

/**
 * codex reads AGENTS.md; claude reads CLAUDE.md. Same instructions, two names.
 *
 * A symlink rather than a copy, so a project that edits one does not have a stale
 * twin, and both directions because both kinds of project exist: a codex-native
 * repo ships only AGENTS.md, and a claude turn in it used to run with no project
 * instructions at all — silently, since a missing memory file looks exactly like a
 * project that has none. A repo that already ships both is left alone: it said
 * what it wanted.
 */
export function linkAgentsMd(worktree: string): void {
  const pairs: [string, string][] = [
    ["CLAUDE.md", "AGENTS.md"],
    ["AGENTS.md", "CLAUDE.md"],
  ];
  for (const [real, alias] of pairs) {
    if (!existsSync(join(worktree, real)) || existsSync(join(worktree, alias))) continue;
    try {
      symlinkSync(real, join(worktree, alias));
    } catch {
      // Read-only checkout, a race with another turn — not worth failing a turn.
    }
  }
}

/**
 * Compress a finished turn's log and drop the raw file.
 *
 * The sweep in watchdog.ts did this after 24 hours, which meant a day of raw
 * NDJSON on disk at all times — most of the 59 MB this directory had reached.
 * Nothing reads a warm log: every consumer is a person looking at it afterwards.
 * The sweep stays as the backstop for logs left behind by a crash.
 */
function gzipTurnLog(path: string): void {
  try {
    if (!existsSync(path)) return;
    writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)));
    rmSync(path, { force: true });
  } catch {
    // A log that will not compress is not worth failing a turn over.
  }
}

/**
 * The account's own quota state, for the header.
 *
 * Only codex volunteers this, and only in `token_count`. The claude side is
 * filled in by mech/subusage.ts on the watchdog's clock, since its stream carries
 * a status but never a percentage.
 */
function recordSubscriptionUsage(deps: ExecDeps, provider: string, r: TurnResult): void {
  const rl = r.rateLimit;
  if (!rl || rl.fiveHourPercent === undefined) return;
  deps.ctx.db.run(
    `INSERT INTO usage_snapshot (runtime, json, at) VALUES (?, ?, ?)
     ON CONFLICT (runtime) DO UPDATE SET json = excluded.json, at = excluded.at`,
    [provider, JSON.stringify(rl), Date.now()],
  );
}

/**
 * File ownership, enforced after the fact for providers whose sandbox cannot.
 *
 * The deny-list handed to claude's settings stops the write; codex has no
 * equivalent (cwd is writable whatever `writable_roots` says, probed on 0.147),
 * so the same rule runs against `git status` here and the offending files go
 * back. Deliberately deterministic: asking a role prompt to respect a boundary
 * is the thing this codebase does not do.
 *
 * Rolled back, then said out loud — a silent revert would have the agent puzzling
 * over work that keeps vanishing.
 */
async function reconcileOwnership(
  deps: ExecDeps,
  agent: AgentRow,
  job: Job,
  grp: { owns_json?: string } | null | undefined,
  worktree: string,
): Promise<void> {
  const owns = parseOwns(grp?.owns_json ?? null);
  if (!owns.length) return;

  const status = await deps.git(worktree, ["status", "--porcelain"], worktree);
  if (status.code !== 0) return;
  // "XY path" and "XY old -> new"; the destination is the one that exists now.
  const changed = status.out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1]!.trim() : p))
    .map((p) => p.replace(/^"|"$/g, ""));

  const stray = outsideOwns(changed, owns);
  if (!stray.length) return;

  // Untracked files have nothing to check out, so they are removed instead.
  await deps.git(worktree, ["checkout", "--", ...stray], worktree);
  await deps.git(worktree, ["clean", "-fd", "--", ...stray], worktree);
  deps.ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "state_change",
    severity: "blocker",
    body: say(deps.ctx.config?.language, "owns.reverted", {
      role: agent.role,
      files: stray.slice(0, 5).join(", "),
      n: String(stray.length),
    }),
    meta: { reverted: stray, owns },
  });
}

function recordCost(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult, stableHash: string): void {
  const { ctx } = deps;
  const total = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheCreate;
  // session_tokens tracks context occupancy, not billing: output and cacheRead
  // don't sit in the next turn's prompt, so counting them makes overTokenBudget
  // trip every turn once a session has run long (see grp7 risk note).
  const contextTokens = r.usage.input + r.usage.cacheCreate;
  ctx.db.run(
    `UPDATE agent SET session_tokens = session_tokens + ?, total_tokens = total_tokens + ?,
     stable_hash = ?, context_window = coalesce(?, context_window)
     WHERE id = ?`,
    [contextTokens, total, stableHash, r.contextWindow ?? null, agent.id],
  );
  if (job.slice_id) {
    ctx.db.run("UPDATE slice SET spent_tokens = spent_tokens + ? WHERE id = ?", [total, job.slice_id]);
  }
  if (job.grp_id) {
    ctx.db.run("UPDATE grp SET spent_tokens = spent_tokens + ? WHERE id = ?", [total, job.grp_id]);
  }
  // cacheRead vs input is the only visible signal that the prompt cache is
  // still working. A sudden drop means someone broke assemble.ts.
  ctx.bus.emit({
    grpId: job.grp_id,
    author: agent.role,
    kind: "tool_summary",
    body: `turn done (${r.numTurns} steps, ${total} tokens)`,
    // The provider, recorded rather than inferred. 成本's 按账号 split was reading
    // `model LIKE 'gpt%'`, which is right today and wrong the first time either
    // vendor renames anything — and the event row has no agent to join back to.
    meta: {
      usage: r.usage,
      cacheRatio: cacheRatio(r),
      model: agent.model,
      runtime: agent.runtime ?? DEFAULT_PROVIDER,
    },
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
  grp: { name: string } | null | undefined,
  repoPath: string | null,
  before: string | null,
  r: TurnResult,
): Promise<void> {
  const { ctx, git } = deps;
  for (const t of r.toolSummaries.slice(0, 12)) {
    ctx.bus.emit({ grpId: job.grp_id, author: agent.role, kind: "tool_summary", body: t.detail });
  }

  let files = r.filesTouched;
  if (before && job.grp_id) {
    const changed = await changedSince(sandboxGit(ctx, { grp: job.grp_id }), WORK, WORK, before);
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
 * The credential stopped working.
 *
 * A year-long OAuth token expires exactly once, and when it does every group
 * fails at the same moment with what reads like a model error. Retrying is the
 * one thing that cannot help, so the group stops and the question points at the
 * settings page — this is a decision only the boss can make.
 */
function handleAuthFailure(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult): void {
  if (r.ok || !isAuthFailure(r.text)) return;
  const { ctx } = deps;
  const runtime = agent.runtime ?? DEFAULT_PROVIDER;
  if (job.grp_id) {
    ctx.db.run(
      "UPDATE grp SET status = 'PAUSED', paused_at = unixepoch() * 1000 WHERE id = ? AND status = 'RUNNING'",
      [job.grp_id],
    );
  }
  const open = ctx.db
    .query<{ id: number }, [string]>(
      "SELECT id FROM escalation WHERE answer IS NULL AND question LIKE ?",
    )
    .get(`${runtime} 的凭据%`);
  if (open) return;
  ctx.db.run(
    `INSERT INTO escalation (grp_id, agent_id, severity, question, brief, kind, created_at)
     VALUES (?, ?, 'blocker', ?, ?, 'env', unixepoch() * 1000)`,
    [
      job.grp_id,
      agent.id,
      `${runtime} 的凭据不好使了：${r.text.slice(0, 200)}\n` +
        `去设置页重新配一个（claude 跑 \`claude setup-token\`，一年有效），配完这一组会自己接着走。`,
      `${runtime} 凭据过期`,
    ],
  );
  ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "escalation",
    intent: "ask",
    severity: "blocker",
    body: `${runtime} credentials rejected`,
  });
}

function handleRateLimit(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult): void {
  const rl = r.rateLimit;
  if (!rl || rl.status === "allowed") return;
  const { ctx } = deps;

  // Hold, and record when to try again so the watchdog can restart it without
  // anyone being awake.
  const resetsMs = rl.resetsAt ? rl.resetsAt * 1000 : Date.now() + 15 * 60_000;
  // The window belongs to the account, so the hold does too: every agent on this
  // CLI stops being dispatched until the reset, standing ones included. Nine other
  // groups each spending a turn to discover the same wall is the waste this
  // prevents — and a held job is never started, so it costs nothing to wait.
  ctx.db.run(
    `INSERT INTO usage_snapshot (runtime, json, at, hold_until) VALUES (?, ?, ?, ?)
     ON CONFLICT (runtime) DO UPDATE SET hold_until = excluded.hold_until, at = excluded.at`,
    [agent.runtime ?? DEFAULT_PROVIDER, JSON.stringify(rl), Date.now(), resetsMs],
  );
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
  //
  // The denominator used to be the literal 200_000 for every model. Measured on
  // this repo's own logs, sonnet-5 and opus-5 report a 1M window — so the strong
  // models were rotating at 12% of theirs, and every rotation throws away a cached
  // prefix that cost real money to build.
  const ceiling = contextWindowFor(cfg, agent.model, agent.context_window) * cfg.sessionRotateFraction;
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
    // Same body, every thirty seconds, forever: the watchdog's own findings are
    // filtered against the event log before they are emitted and the standup's
    // never were, so the feed filled with three lines repeating.
    const seen = deps.ctx.db
      .query<{ at: number }, [string]>(
        `SELECT max(at) AS at FROM event WHERE author = 'standup' AND body = ?`,
      )
      .get(item.body);
    if (seen?.at && Date.now() - seen.at < REEMIT_MS) continue;
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

  const cwd = leaseCwd(def);
  const logDir = join(cfg.dataDir, "leases");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${leaseId}.log`);

  // Stamp the commit this ran against: two failures at the same sha mean the
  // environment is the variable, not the code.
  const scope: Scope = lease.grp_id ? { grp: lease.grp_id } : { project: 0 };
  const head = await sandboxGit(ctx, scope)(cwd, ["rev-parse", "HEAD"], cwd);
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
    // The group's own sandbox. A lease used to be the one thing that ran on the
    // boss's machine with the boss's permissions — PLAN.md called the runner the
    // sandbox's only hole. There is no hole now.
    exec: resourceExec(ctx, scope),
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

function leaseCwd(def: ResourceDef): string {
  return def.cwd ?? WORK;
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
