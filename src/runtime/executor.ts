import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { imagePaths } from "../mech/util/attachment-text.ts";
import type { Config, RoleDef } from "../platform/config/load.ts";
import { contextWindowFor, DEFAULT_PROVIDER, modelFor } from "../platform/config/load.ts";
import type { Ctx } from "../mech/ctx.ts";

function mintToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
import { say } from "../platform/text/lang.ts";
import { raise } from "../mech/flow/escalate.ts";
import { hold } from "../mech/flow/intercept.ts";
import { outsideOwns, parseOwns } from "../mech/flow/ownership.ts";
import {
  auditVerdict,
  handToBoss,
  handToQa,
  runDeterministicReview,
  runPrReview,
  sendBack,
} from "../mech/flow/review.ts";
import { runStandup } from "../mech/flow/standup.ts";
import { ensureCheckout, keepBranch, sandboxGit } from "../mech/git/checkout.ts";
import { gitTrailers } from "../mech/git/ghlogin.ts";
import { changedSince, checkpoint, porcelainPaths, STATUS_Z } from "../mech/git/worktree.ts";
import { lessonsFor } from "../mech/knowledge/lessons.ts";
import { LeaseArgsSchema, loadResource, type ResourceDef, resolveLease, runResource } from "../mech/lease.ts";
import { gzipTurnLog, REEMIT_MS, recordTurnOutcome, runWatchdog } from "../mech/ops/watchdog.ts";
import { CODEX_HOME, isAuthFailure, vaultFor } from "../mech/sandbox/auth.ts";
import { MAILBOX_DIR, putBytes, resourceExec, runnerFor, type Scope, WORK } from "../mech/sandbox/sandbox.ts";
import { projectOfAgent } from "../mech/util/rows.ts";
import { jsonOr } from "../contracts/json.ts";
import { clip, errText } from "../platform/process/text.ts";
import { assemble, buildStable, type Delta, needsRotation, type StablePrompt } from "../prompt/assemble.ts";
import { AgentTurnPayloadSchema, type Executor, type Job } from "../platform/scheduling/scheduler.ts";
import { buildTurnDelta } from "../application/turn/delta.ts";
import type { TurnResult } from "./claude.ts";
import { clampEffort, type Provider, providerFor } from "./providers.ts";
import { track, untrack } from "../platform/process/running-turns.ts";
import { requestContext } from "../platform/observability/request-context.ts";

/**
 * Turns a queued `job` into work that actually happens.
 *
 * Everything expensive or irreversible is decided here rather than in a prompt:
 * which model runs, whether the session must rotate, what the turn is told, and
 * what happens when the CLI reports a permission denial or a rate limit.
 */

/**
 * Why a turn did not resume the session it had.
 *
 * `hash` the cached prefix changed under it, `budget` the context ceiling,
 * `explicit` a send-back that asked for a clean head, `new` there was no session
 * to resume. Recorded on the turn event; the first three cost a cached prefix.
 */
type RotateReason = "hash" | "budget" | "explicit" | "new";

export interface ExecDeps {
  ctx: Ctx;
  cfg: Config;
  roles: Map<string, RoleDef>;
  /** Injectable for tests; defaults to whichever provider the role names. */
  runTurn?: Provider["run"];
}

export interface AgentRow {
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
        return job.grp_id ? runPrReview({ ctx: deps.ctx, cfg: deps.cfg }, job.grp_id) : undefined;
      case "digest":
      case "notify":
        // notify / digest land in M3. Doing nothing is correct for
        // now; failing would poison the queue.
        break;
    }
  };
}

/** Find or hire the agent this job belongs to. */
function resolveAgent(deps: ExecDeps, job: Job<"agent_turn">): AgentRow {
  const assigned = assignedAgent(deps.ctx, job.agent_id);
  if (assigned) return assigned;
  const roleName = job.payload.role ?? "engineer";
  const existing = deps.ctx.db
    .query<AgentRow, [number | null, string]>(
      `${SELECT_AGENT_BASE} WHERE grp_id IS ? AND role = ? AND state != 'retired'`,
    )
    .get(job.grp_id, roleName);
  if (existing) return existing;
  return hire(deps, job.grp_id, roleName, job.slice_id, payloadProjectId(deps.ctx, job));
}

function assignedAgent(ctx: Ctx, agentId: number | null): AgentRow | null {
  if (!agentId) return null;
  return ctx.db.query<AgentRow, [number]>(SELECT_AGENT).get(agentId) ?? null;
}

function payloadProjectId(ctx: Ctx, job: Job<"agent_turn">): number | null {
  if (job.payload.project_id) return job.payload.project_id;
  if (!job.payload.audit) return null;
  return (
    ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(job.payload.audit)
      ?.project_id ?? null
  );
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
    body: say(ctx.config.language, "hired", { role: roleName }),
  });
  return ctx.db.query<AgentRow, [number]>(SELECT_AGENT).get(row.id)!;
}

interface TurnGroup {
  id: number;
  name: string;
  project_id: number;
  branch: string | null;
  owns_json: string;
}

interface PreparedTurn {
  agent: AgentRow;
  role: RoleDef;
  group: TurnGroup | null;
  scope: Scope;
  stable: StablePrompt;
  delta: Delta;
  rotate: boolean;
  why: RotateReason | null;
  sessionId: string;
}

async function runAgentTurn(deps: ExecDeps, job: Job<"agent_turn">): Promise<void> {
  const turn = await prepareTurn(deps, job);
  const before = await checkpointTurn(deps, job, turn);
  const result = await invokeTurn(deps, job, turn);
  await finishTurn(deps, job, turn, before, result);
}

async function prepareTurn(deps: ExecDeps, job: Job<"agent_turn">): Promise<PreparedTurn> {
  const agent = resolveAgent(deps, job);
  const role = deps.roles.get(agent.role);
  if (!role) throw new Error(`no role definition for ${agent.role}`);
  const group = turnGroup(deps.ctx, job.grp_id);
  const scope: Scope = job.grp_id ? { grp: job.grp_id } : { project: agent.project_id ?? 0 };
  const stable = buildStableFor(deps, agent, role, group, turnRepoPath(deps.ctx, agent, group), job);
  const why = rotationReason(agent, deps.cfg, stable, job.payload.rotate === true);
  const rotate = why !== null && why !== "new";
  const sessionId = rotate || !agent.session_id ? crypto.randomUUID() : agent.session_id;
  const delta = await buildTurnDelta(deps, agent, job, rotate, scope);
  return { agent, role, group, scope, stable, delta, rotate, why, sessionId };
}

function turnGroup(ctx: Ctx, groupId: number | null): TurnGroup | null {
  if (!groupId) return null;
  return (
    ctx.db
      .query<TurnGroup, [number]>("SELECT id, name, project_id, branch, owns_json FROM grp WHERE id = ?")
      .get(groupId) ?? null
  );
}

function turnRepoPath(ctx: Ctx, agent: AgentRow, group: TurnGroup | null): string {
  if (!group && agent.grp_id) return WORK;
  const projectId = group?.project_id ?? projectOfAgent(ctx.db, agent.id);
  return (
    ctx.db.query<{ repo_path: string }, [number | null]>("SELECT repo_path FROM project WHERE id = ?").get(projectId)
      ?.repo_path ?? WORK
  );
}

function rotationReason(agent: AgentRow, cfg: Config, stable: StablePrompt, explicit: boolean): RotateReason | null {
  if (needsRotation(agent.stable_hash ?? null, stable)) return "hash";
  if (overTokenBudget(agent, cfg)) return "budget";
  if (explicit) return "explicit";
  if (!agent.session_id) return "new";
  return null;
}

async function checkpointTurn(deps: ExecDeps, job: Job<"agent_turn">, turn: PreparedTurn): Promise<string | null> {
  if (!job.grp_id) {
    markAgentRunning(deps.ctx, turn);
    return null;
  }
  try {
    await ensureCheckout(deps.ctx, job.grp_id);
  } catch (error) {
    throw new Error(`could not prepare the group's checkout: ${errText(error)}`, { cause: error });
  }
  const before = await checkpoint(
    sandboxGit(deps.ctx, turn.scope),
    WORK,
    WORK,
    checkpointLabel(deps.ctx, job),
    gitTrailers(deps.ctx),
  );
  if (before) recordCheckpoint(deps.ctx, job, before);
  markAgentRunning(deps.ctx, turn);
  return before;
}

function recordCheckpoint(ctx: Ctx, job: Job<"agent_turn">, before: string): void {
  if (job.slice_id) {
    ctx.db.run("UPDATE slice SET base_sha = coalesce(base_sha, ?) WHERE id = ?", [before, job.slice_id]);
  }
  ctx.db.run("UPDATE job SET checkpoint_sha = ? WHERE id = ?", [before, job.id]);
}

function markAgentRunning(ctx: Ctx, turn: PreparedTurn): void {
  ctx.db.run(
    turn.rotate
      ? "UPDATE agent SET state = 'running', session_id = ?, session_tokens = 0 WHERE id = ?"
      : "UPDATE agent SET state = 'running', session_id = ? WHERE id = ?",
    [turn.sessionId, turn.agent.id],
  );
}

async function invokeTurn(deps: ExecDeps, job: Job<"agent_turn">, turn: PreparedTurn): Promise<TurnResult> {
  const { ctx, cfg } = deps;
  const logDir = join(cfg.dataDir, "turns");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${job.id}.jsonl`);
  const prompt = await turnPrompt(deps, job, turn);
  const provider = providerFor(turn.agent.runtime ?? turn.role.runtime);
  const run: Provider["run"] = deps.runTurn ?? provider.run;
  let result: TurnResult;
  let stopTurn: (() => void) | undefined;
  try {
    result = await run(
      turnSpec(ctx, cfg, job, turn, prompt, logPath),
      turnEvents(ctx, job, turn.agent, (stop) => {
        stopTurn = stop;
        track(job.id, stop);
      }),
    );
  } finally {
    if (stopTurn) untrack(job.id, stopTurn);
    ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ? AND state = 'running'", [turn.agent.id]);
    gzipTurnLog(logPath);
  }
  return result;
}

async function turnPrompt(deps: ExecDeps, job: Job<"agent_turn">, turn: PreparedTurn): Promise<string> {
  const prompt =
    assemble(turn.stable, turn.delta).prompt.trim() ||
    "You were woken with nothing new to read. Check `orch task list` and " +
      "`orch ctx query` for your current situation, and if there is genuinely " +
      "nothing to do, say so in one line and stop.";
  return stageAttachments(deps, turn.scope, prompt, job.grp_id);
}

function turnSpec(ctx: Ctx, cfg: Config, job: Job<"agent_turn">, turn: PreparedTurn, prompt: string, logPath: string) {
  return {
    stable: turn.stable,
    prompt,
    cwd: WORK,
    ...(turn.rotate || !turn.agent.session_id ? { newSessionId: turn.sessionId } : { resumeSessionId: turn.sessionId }),
    maxTurns: turn.role.maxTurns ?? cfg.maxTurnsPerJob,
    timeoutMs: cfg.turnTimeoutMs,
    images: imagePaths(prompt),
    logPath,
    runner: runnerFor(ctx, turn.scope),
    env: {
      ORCH_MAILBOX: MAILBOX_DIR,
      ORCH_MAILBOX_TIMEOUT_MS: String(cfg.turnTimeoutMs),
      ORCH_TOKEN: turn.agent.token ?? "",
      ORCH_GRP_ID: String(job.grp_id ?? ""),
      ...vaultFor(ctx.db).env,
      CODEX_HOME,
    },
  };
}

function turnEvents(ctx: Ctx, job: Job<"agent_turn">, agent: AgentRow, onAbort: (stop: () => void) => void) {
  const live = (kind: "text" | "thinking" | "status", body: string): void =>
    ctx.bus.live({
      grpId: job.grp_id,
      projectId: agent.project_id ?? null,
      agentId: agent.id,
      role: agent.role,
      kind,
      body,
    });
  return {
    onText: (text: string) => live("text", text),
    onThinking: (text: string) => live("thinking", text),
    onTool: (tool: { name: string; detail: string }) => {
      if (tool.detail === tool.name) return;
      ctx.db.run("UPDATE agent SET activity = ? WHERE id = ?", [tool.detail, agent.id]);
      ctx.bus.live({
        grpId: job.grp_id,
        projectId: agent.project_id ?? null,
        agentId: agent.id,
        role: agent.role,
        kind: "tool",
        body: tool.detail,
      });
    },
    onStatus: (status: string) => live("status", status),
    onAbort,
  };
}

async function finishTurn(
  deps: ExecDeps,
  job: Job<"agent_turn">,
  turn: PreparedTurn,
  before: string | null,
  result: TurnResult,
): Promise<void> {
  recordRuntimeSession(deps.ctx, turn, result);
  await preserveTurnBranch(deps.ctx, job, turn.group);
  recordCost(deps, turn.agent, job, result, turn.stable.hash, turn.why);
  recordProgress(deps, turn.agent, job, result);
  await narrate(deps, turn.agent, job, before, result);
  handleRateLimit(deps, turn.agent, job, result);
  handleAuthFailure(deps, turn.agent, job, result);
  recordSubscriptionUsage(deps, providerFor(turn.agent.runtime ?? turn.role.runtime).name, result);
  await reconcileOwnership(deps, turn.agent, job, turn.group);
  repairLostSession(deps.ctx, job, turn, result);
  if (!result.ok) throw new Error(`turn failed (${result.terminalReason}): ${clip(result.text)}`);
}

function recordRuntimeSession(ctx: Ctx, turn: PreparedTurn, result: TurnResult): void {
  if (result.sessionId && result.sessionId !== turn.sessionId) {
    ctx.db.run("UPDATE agent SET session_id = ? WHERE id = ?", [result.sessionId, turn.agent.id]);
  }
}

async function preserveTurnBranch(ctx: Ctx, job: Job<"agent_turn">, group: TurnGroup | null): Promise<void> {
  if (!job.grp_id || !group?.branch) return;
  const kept = await keepBranch(ctx, job.grp_id);
  if (kept.ok || !kept.reason || /empty bundle/i.test(kept.reason)) return;
  ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "state_change",
    body: `could not take ${group.branch} out of the sandbox: ${kept.reason}`,
  });
}

function repairLostSession(ctx: Ctx, job: Job<"agent_turn">, turn: PreparedTurn, result: TurnResult): void {
  if (result.ok || !LOST_SESSION.test(result.text)) return;
  ctx.db.run("UPDATE agent SET session_id = NULL, stable_hash = NULL WHERE id = ?", [turn.agent.id]);
  ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "state_change",
    body: `${turn.agent.role} 的会话记录没了，下一轮从新会话开始`,
    meta: { agent_id: turn.agent.id, lost_session: turn.sessionId },
  });
}

/** Both CLIs, both spellings. */
export const LOST_SESSION = /no rollout found for thread|No conversation found with session ID/i;

/**
 * What a turn's checkpoint commit says about itself.
 *
 * `S2: engineer — 闸门放行的卡 enqueue 一个 cos turn`. The slice number is where
 * the reviewer looks first, the role is who did it, and the task title is the
 * only sentence anyone wrote about this particular piece of work.
 *
 * It names the turn that **just ended**, not the one about to start. The
 * checkpoint runs at the top of a turn and commits whatever is dirty, which is
 * the previous turn's output — so taking the role from the incoming job filed
 * the Engineer's diff under `S2: qa`, and the one place a reviewer looks to find
 * out who wrote a line said the wrong name.
 */
function checkpointLabel(ctx: Ctx, job: Job<"agent_turn">): string {
  const prev = ctx.db
    .query<{ payload_json: string | null; slice_id: number | null }, [number]>(
      `SELECT payload_json, slice_id FROM job WHERE grp_id = ? AND kind = 'agent_turn'
         AND state IN ('done', 'failed', 'cancelled') ORDER BY id DESC LIMIT 1`,
    )
    .get(job.grp_id!);
  const role = jsonOr(prev?.payload_json, AgentTurnPayloadSchema, {}).role ?? "agent";
  if (!prev?.slice_id) return `${role} turn`;
  const sliceId = prev.slice_id;
  const seq = ctx.db.query<{ seq: number }, [number]>("SELECT seq FROM slice WHERE id = ?").get(sliceId)?.seq;
  // The task that turn had claimed. Not "not done": by the time this runs it
  // usually is done, which is what left every checkpoint labelled with the next
  // task instead of the one in the commit.
  const task = ctx.db
    .query<{ title: string }, [number]>(
      "SELECT title FROM task WHERE slice_id = ? ORDER BY (status = 'done') DESC, id DESC LIMIT 1",
    )
    .get(sliceId)?.title;
  const head = seq ? `S${seq}: ${role}` : `${role} turn`;
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
  job: Job<"agent_turn">,
) {
  const { ctx, cfg } = deps;

  const projectId = projectOfAgent(ctx.db, agent.id);

  const onboarding = noteBody(ctx, projectId, "onboarding");
  // Owned by `report.ts`, next to the eviction that decides which of them
  // survive. The comment that used to be here said those two queries have to
  // agree, and then wrote out its own predicate and its own literal 20.
  const lessons = lessonsFor(ctx.db, projectId);
  const effort = clampEffort(agent.runtime ?? role.runtime, role.effort);

  return buildStable({
    rolePrompt: role.prompt,
    ...(onboarding ? { onboarding } : {}),
    lessons,
    language: cfg.language,
    model: agent.model,
    // Clamped to what this role's provider accepts before it is hashed, so the
    // prefix hash describes the turn that was actually sent.
    ...(effort ? { effort } : {}),
    // A role's own list, always. There is no clearance table behind it any more:
    // the sandbox is the boundary, so this only decides which tool definitions
    // are loaded into the prefix and which roles may search the web.
    allowedTools: role.allowedTools ?? ["Bash", "Read", "Grep", "Glob"],
    addDirs: [WORK],
  });
}

/** Where a staged attachment lands inside the container. */
export const ATTACH_DIR = `${MAILBOX_DIR}/attach`;

/**
 * Copy the turn's attachments into the sandbox and point the prompt at them.
 *
 * The boss attaches a screenshot; `withAttachments` writes its **host** path into
 * the message, and since 005 that path does not exist where the turn runs. claude
 * was asked to `Read` a missing file, failed silently and improvised around it;
 * codex was handed `-i /Users/…/data/attachments/…` for a file that was not
 * there. Nothing copied them in, and nothing said so — the feature had been dead
 * for as long as the container had been the boundary.
 *
 * Only paths under `<dataDir>/attachments` are touched. That is the whole
 * filter: it is exact, and it cannot mistake an agent's own bullet list for an
 * attachment block the way parsing the header would.
 */
export async function stageAttachments(
  deps: ExecDeps,
  scope: Scope,
  prompt: string,
  grpId: number | null,
): Promise<string> {
  const root = resolve(join(deps.cfg.dataDir, "attachments"));
  const wanted = new Set<string>();
  for (const m of prompt.matchAll(/^- (?:\[[^\]]+\] )?(\/\S+)/gm)) {
    const p = resolve(m[1]!);
    if (p === root || p.startsWith(`${root}/`)) wanted.add(m[1]!);
  }
  if (wanted.size === 0) return prompt;

  let out = prompt;
  for (const host of wanted) {
    const inside = `${ATTACH_DIR}/${basename(host)}`;
    try {
      await putBytes(deps.ctx, scope, inside, new Uint8Array(await Bun.file(host).arrayBuffer()));
    } catch (e) {
      // Said out loud rather than left as a path that goes nowhere: an attachment
      // the agent cannot open is exactly the failure this function exists for.
      deps.ctx.bus.emit({
        grpId,
        author: "orchestrator",
        kind: "state_change",
        severity: "blocker",
        body: `could not put ${basename(host)} into the sandbox: ${errText(e)}`,
      });
      continue;
    }
    out = out.split(host).join(inside);
  }
  return out;
}

/**
 * The account's own quota state, for the header.
 *
 * Only codex volunteers this, and only in `token_count`. The claude side is
 * filled in by mech/ops/subusage.ts on the watchdog's clock, since its stream carries
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
 * File ownership, enforced after the fact. The only mechanism there is.
 *
 * The container is the write boundary, and it knows nothing about which group
 * owns which file — a deny-list used to stop the write before it happened, and
 * decision 005 §Ceiling accepted the trade. So the rule runs against
 * `git status` here and the offending files go back. Deliberately deterministic:
 * asking a role prompt to respect a boundary is the thing this codebase does not
 * do.
 *
 * Rolled back, then said out loud — a silent revert would have the agent puzzling
 * over work that keeps vanishing.
 *
 * `sandboxGit`, not the host runner: the checkout is `/work` inside the group's
 * container and there is no such path on this machine. Pointing the host runner at
 * it threw on every turn, in the one mechanism that has no second line of defence.
 */
export async function reconcileOwnership(
  deps: { ctx: Ctx },
  agent: { role: string },
  job: { grp_id: number | null },
  grp: { owns_json?: string } | null | undefined,
): Promise<void> {
  const owns = parseOwns(grp?.owns_json ?? null);
  if (!owns.length || !job.grp_id) return;

  const git = sandboxGit(deps.ctx, { grp: job.grp_id });
  const status = await git(WORK, STATUS_Z, WORK);
  if (status.code !== 0) {
    // Said out loud. This is the only file-ownership enforcement there is since
    // 005 deleted the deny-list, and `engineer.yaml` promises it to the agent —
    // so skipping silently means the boundary is off and everything reads normal.
    // The same function was just fixed for pointing the host runner at `/work`;
    // this line is the identical failure one layer down.
    deps.ctx.bus.emit({
      grpId: job.grp_id,
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body: `could not check file ownership this turn (git status in the sandbox: ${status.out.slice(0, 200)})`,
    });
    return;
  }
  const stray = outsideOwns(porcelainPaths(status.out), owns);
  if (!stray.length) return;

  // Untracked files have nothing to check out, so they are removed instead — the
  // pair is expected to disagree about which paths it can act on, which is why
  // neither exit code alone is the test.
  const [co, cl] = await Promise.all([
    git(WORK, ["checkout", "--", ...stray], WORK),
    git(WORK, ["clean", "-fd", "--", ...stray], WORK),
  ]);
  // What is actually gone, read back rather than assumed. This announcement used
  // to be made from the list of files we had *tried* to revert: when the pathspec
  // did not match — every non-ASCII and every spaced path, before `-z` — git
  // exited 1, changed nothing, and the boss was told the boundary had held.
  const after = await git(WORK, STATUS_Z, WORK);
  const left = after.code === 0 ? new Set(outsideOwns(porcelainPaths(after.out), owns)) : new Set<string>();
  const reverted = stray.filter((p) => !left.has(p));
  if (!reverted.length) {
    deps.ctx.bus.emit({
      grpId: job.grp_id,
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body:
        `could not roll back ${stray.length} file(s) outside this group's paths ` +
        `(${stray.slice(0, 5).join(", ")}): ${(co.out || cl.out || "git changed nothing").slice(0, 200)}`,
      meta: { stray, owns },
    });
    return;
  }
  deps.ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "state_change",
    severity: "blocker",
    body: say(deps.ctx.config.language, "owns.reverted", {
      role: agent.role,
      files: reverted.slice(0, 5).join(", "),
      n: String(reverted.length),
    }),
    meta: { reverted, stray, owns },
  });
}

function recordCost(
  deps: ExecDeps,
  agent: AgentRow,
  job: Job,
  r: TurnResult,
  stableHash: string,
  rotate: RotateReason | null,
): void {
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
      // Null when this turn resumed. Otherwise which of the four started a new
      // session — the number the cache ratio cannot give you, because a low ratio
      // and a high rotation rate are the same picture with different fixes.
      rotate,
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
      .query<{ c: number }, [number | null, number]>("SELECT count(*) AS c FROM note WHERE grp_id IS ? AND at > ?")
      .get(job.grp_id, since)!.c > 0;
  const movedTask =
    ctx.db
      .query<{ c: number }, [number]>("SELECT count(*) AS c FROM task WHERE owner_agent_id = ? AND status = 'done'")
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
async function narrate(deps: ExecDeps, agent: AgentRow, job: Job, before: string | null, r: TurnResult): Promise<void> {
  // No `repoPath` and no `git`: both were left over from when this read the host
  // checkout, and the diff has come out of `sandboxGit(WORK)` since 005. A
  // parameter nobody reads is the next reader's wrong mental model.
  const { ctx } = deps;
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
    hold(ctx, job.grp_id, { reason: `auth:${runtime}`, settled: true, from: "RUNNING" });
  }
  if (
    raise(ctx.db, {
      grpId: job.grp_id,
      agentId: agent.id,
      kind: "env",
      brief: `${runtime} 凭据过期`,
      dedupe: { prefix: `${runtime} 的凭据`, scope: "global" },
      question:
        `${runtime} 的凭据不好使了：${r.text.slice(0, 200)}\n` +
        `去设置页 → ${runtime} → 登录，重新配一个。登录是在工具容器里跑官方 CLI 做的，本机不用装。配完这一组会自己接着走。`,
    }) === null
  ) {
    return;
  }
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
    body: say(ctx.config.language, "rl.waiting", { at: new Date(resetsMs).toLocaleString() }),
    meta: rl,
  });
  if (job.grp_id) {
    hold(ctx, job.grp_id, { reason: "ratelimit", settled: true, until: resetsMs });
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
async function runGateJob(deps: ExecDeps, job: Job<"gate">): Promise<void> {
  if (!job.slice_id) return;
  const rd = { ctx: deps.ctx, cfg: deps.cfg };
  const out = await runDeterministicReview(rd, job.slice_id);
  if (out.pass) handToQa(rd, job.slice_id);
  else sendBack(rd, job.slice_id, out.feedback, "gate");
}

/**
 * The watchdog runs as an ordinary job, which is why it bypasses the group slot
 * pool: otherwise it could never fire on the very group that is stuck.
 */
async function runWatchdogJob(deps: ExecDeps): Promise<void> {
  const findings = await runWatchdog({ ctx: deps.ctx, cfg: deps.cfg });
  for (const finding of findings) publishWatchdogFinding(deps.ctx, finding);
  for (const item of runStandup(deps.ctx.db)) publishStandupItem(deps.ctx, item);
}

function publishWatchdogFinding(
  ctx: Ctx,
  finding: { rule: string; severity: string; body: string; grpId: number | null },
): void {
  ctx.onFinding?.(finding.rule, finding.severity, finding.body, finding.grpId);
}

export function publishStandupItem(ctx: Ctx, item: { kind: string; body: string; grpIds: number[] }): void {
  const seen = ctx.db
    .query<{ at: number }, [string]>(`SELECT max(at) AS at FROM event WHERE author = 'standup' AND body = ?`)
    .get(item.body);
  if (seen?.at && Date.now() - seen.at < REEMIT_MS) return;
  const groupId = item.grpIds[0] ?? null;
  ctx.bus.emit({
    grpId: groupId,
    author: "standup",
    kind: "state_change",
    body: item.body,
    meta: { kind: item.kind, groups: item.grpIds },
  });
  ctx.onFinding?.(item.kind, "advisory", item.body, groupId);
}

/** Called by the server when the Auditor files a PR-level verdict. */
export function makeAuditVerdict(deps: ExecDeps) {
  return (grpId: number, pass: boolean, note: string): void =>
    auditVerdict({ ctx: deps.ctx, cfg: deps.cfg }, grpId, pass, note);
}

/** Called by the server when QA files a verdict. */
export function makeReviewVerdict(deps: ExecDeps) {
  return (sliceId: number, pass: boolean, note: string): void => {
    const rd = { ctx: deps.ctx, cfg: deps.cfg };
    if (pass) handToBoss(rd, sliceId);
    else sendBack(rd, sliceId, note || "QA rejected the slice", "qa");
  };
}

// -------------------------------------------------------------------- leases

/**
 * Lease completion is durable: `finishLease` records the terminal result and
 * queues the requesting agent's follow-up turn. Cancellation stays retryable by
 * leaving the lease non-terminal while the scheduler reclaims its job.
 */
async function runLease(deps: ExecDeps, job: Job<"lease">): Promise<void> {
  const leaseId = job.payload.lease_id;
  if (!leaseId) throw new Error("lease job requires a positive integer lease_id");
  try {
    await lease(deps, job, leaseId);
  } catch (e) {
    if (requestContext.getStore()?.signal?.aborted) throw e;
    finishLease(deps, leaseId, 126, `the gate could not run: ${errText(e)}`, undefined);
  }
}

async function lease(deps: ExecDeps, job: Job<"lease">, leaseIdIn: number): Promise<void> {
  const { ctx, cfg } = deps;
  const leaseId = leaseIdIn;
  const lease = ctx.db
    .query<{ id: number; resource: string; args_json: string; grp_id: number | null }, [number]>(
      "SELECT id, resource, args_json, grp_id FROM lease WHERE id = ?",
    )
    .get(leaseId);
  if (!lease) return;

  const def = loadResource(ctx.db, lease.resource);
  if (!def) return finishLease(deps, leaseId, 127, "unknown resource", undefined);

  // Re-validate at execution time. The queued args were checked on the way in,
  // but the resource template may have changed since.
  const args = jsonOr(lease.args_json, LeaseArgsSchema.nullable(), null);
  if (!args) {
    return finishLease(
      deps,
      leaseId,
      126,
      "lease arguments must be a flat JSON object of string, number, or boolean values",
      undefined,
    );
  }
  const resolved = resolveLease(def, args);
  if (!resolved.ok) return finishLease(deps, leaseId, 126, resolved.error, undefined);

  const cwd = leaseCwd(def);
  const logDir = join(cfg.dataDir, "leases");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${leaseId}.log`);

  // Stamp the commit this ran against: two failures at the same sha mean the
  // environment is the variable, not the code.
  const scope: Scope = lease.grp_id ? { grp: lease.grp_id } : { project: 0 };
  const head = await sandboxGit(ctx, scope)(cwd, ["rev-parse", "HEAD"], cwd);
  ctx.db.run("UPDATE lease SET state = 'running', head_sha = ?, started_at = unixepoch() * 1000 WHERE id = ?", [
    head.code === 0 ? head.out.trim() : null,
    leaseId,
  ]);
  ctx.bus.emit({
    grpId: lease.grp_id,
    author: "runner",
    kind: "tool_summary",
    body: `lease ${lease.resource} #${leaseId} started`,
  });

  // Same runner as the gates use. This used to spawn its own process, which meant
  // two implementations of "run a resource" and a timeout on only one of them.
  const out = await runResource(def, args, {
    cwd,
    logPath,
    timeoutMs: cfg.leaseTimeoutMs,
    // The group's own sandbox. A lease used to be the one thing that ran on the
    // boss's machine with the boss's permissions — docs/project/plan.md called the runner the
    // sandbox's only hole. There is no hole now.
    exec: resourceExec(ctx, scope),
  });
  if (!("digest" in out)) return finishLease(deps, leaseId, 126, out.error, logPath);
  finishLease(deps, leaseId, out.exitCode, out.digest.text, logPath);
}

function finishLease(deps: ExecDeps, leaseId: number, code: number, digest: string, logPath: string | undefined): void {
  const { ctx } = deps;
  ctx.db.transaction(() => {
    const lease = ctx.db
      .query<{ grp_id: number | null; agent_id: number | null }, [number]>(
        "SELECT grp_id, agent_id FROM lease WHERE id = ?",
      )
      .get(leaseId);
    if (!lease) return;
    const finished = ctx.db.run(
      `UPDATE lease SET state = ?, exit_code = ?, result_digest = ?, log_path = ?,
       ended_at = unixepoch() * 1000 WHERE id = ? AND state IN ('queued', 'running')`,
      [code === 0 ? "done" : "failed", code, digest, logPath ?? null, leaseId],
    );
    if (finished.changes === 0) return;
    ctx.bus.emit({
      grpId: lease.grp_id,
      author: "runner",
      kind: "lease_result",
      body: `lease #${leaseId} exit ${code}`,
      meta: { lease_id: leaseId, exit_code: code },
    });
    if (lease.agent_id) {
      ctx.db.run("UPDATE agent SET state = 'idle' WHERE id = ? AND state = 'waiting_lease'", [lease.agent_id]);
      ctx.sched.enqueue("agent_turn", {
        grp_id: lease.grp_id,
        agent_id: lease.agent_id,
        priority: 5,
        payload: {
          mail: {
            from: "runner",
            from_group: lease.grp_id,
            intent: "inform",
            body: `lease #${leaseId} finished:\n${digest}`,
          },
        },
      });
    }
  })();
  ctx.sched.tick();
}

function leaseCwd(def: ResourceDef): string {
  return def.cwd ?? WORK;
}

/** Newest note of a kind. `id DESC` for the same reason the lessons query has it. */
function noteBody(ctx: Ctx, projectId: number | null, kind: string): string | null {
  return (
    ctx.db
      .query<{ body: string }, [number | null, string]>(
        "SELECT body FROM note WHERE (project_id IS ? OR project_id IS NULL) AND kind = ? ORDER BY at DESC, id DESC LIMIT 1",
      )
      .get(projectId, kind)?.body ?? null
  );
}
