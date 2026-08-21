import { msg, plural } from "@lingui/core/macro";
import { and, count, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DB } from "../platform/persistence/database.ts";
import {
  maxMs,
  agent as agents,
  event as events,
  grp as grps,
  job as jobs,
  note as notes,
  project as projects,
  slice as slices,
  task as tasks,
  usage_snapshot,
} from "../platform/persistence/schema.ts";
import type { Json } from "../contracts/json.ts";

/** A turn that is over, however it ended. The complement of `ACTIVE_JOB_STATES`. */
const FINISHED_JOB_STATES = ["done", "failed", "cancelled"] as const;
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { imagePaths } from "../mech/util/attachment-text.ts";
import type { Config, RoleDef } from "../platform/config/load.ts";
import { contextWindowFor, DEFAULT_PROVIDER, modelFor } from "../platform/config/load.ts";
import { roleFor, type Ctx } from "../mech/ctx.ts";

function mintToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
import { renderSaid } from "../platform/text/lang.ts";
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
import { changedSince, checkpoint, porcelainEntries, porcelainPaths, STATUS_Z } from "../mech/git/gitops.ts";
import { lessonsFor } from "../mech/knowledge/lessons.ts";
import { gzipTurnLog, recordTurnOutcome, runWatchdog, type Finding } from "../mech/ops/watchdog.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { scopeAttributes, type SpanScope } from "../platform/observability/metrics.ts";
import { activeTracer } from "../platform/observability/traces.ts";
import { CODEX_HOME, isAuthFailure, vaultFor } from "../mech/sandbox/auth.ts";
import { MAILBOX_DIR, putBytes, runnerFor, type Scope, WORK } from "../mech/sandbox/sandbox.ts";
import { projectOfAgent, projectOfGrp } from "../mech/util/rows.ts";
import { valueOr } from "../contracts/json.ts";
import { clip, errText } from "../platform/process/text.ts";
import { runLease } from "./lease-job.ts";
import { assemble, buildStable, type Delta, needsRotation, type StablePrompt } from "../prompt/assemble.ts";
import { AgentTurnPayloadSchema, type Executor, type Job } from "../platform/scheduling/scheduler.ts";
import { buildTurnDelta } from "../application/turn/delta.ts";
import type { TurnResult } from "../runtime/claude.ts";
import { clampEffort, type Provider, providerFor } from "../runtime/providers.ts";
import { track, untrack } from "../platform/process/running-turns.ts";

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
async function resolveAgent(deps: ExecDeps, job: Job<"agent_turn">): Promise<AgentRow> {
  const assigned = await assignedAgent(deps.ctx.db, job.agent_id);
  if (assigned) return assigned;
  const roleName = job.payload.role ?? roleFor(deps.ctx, "write_code");
  // `IS ?` matched a NULL group; `eq` never does, so a group-less standing role
  // would be hired again on every turn.
  const [existing] = await deps.ctx.db
    .select(AGENT_COLUMNS)
    .from(agents)
    .where(
      and(
        job.grp_id === null ? isNull(agents.grp_id) : eq(agents.grp_id, job.grp_id),
        eq(agents.role, roleName),
        ne(agents.state, "retired"),
      ),
    );
  if (existing) return existing;
  return await hire(deps, job.grp_id, roleName, job.slice_id, await payloadProjectId(deps.ctx.db, job));
}

async function assignedAgent(db: DB, agentId: number | null): Promise<AgentRow | null> {
  if (!agentId) return null;
  const [row] = await db.select(AGENT_COLUMNS).from(agents).where(eq(agents.id, agentId));
  return row ?? null;
}

async function payloadProjectId(db: DB, job: Job<"agent_turn">): Promise<number | null> {
  if (job.payload.project_id) return job.payload.project_id;
  if (!job.payload.audit) return null;
  return await projectOfGrp(db, job.payload.audit);
}

/** The columns an `AgentRow` is, named once. */
const AGENT_COLUMNS = {
  id: agents.id,
  grp_id: agents.grp_id,
  project_id: agents.project_id,
  role: agents.role,
  model: agents.model,
  runtime: agents.runtime,
  session_id: agents.session_id,
  session_tokens: agents.session_tokens,
  cwd: agents.cwd,
  token: agents.token,
  stable_hash: agents.stable_hash,
  context_window: agents.context_window,
};

export async function hire(
  deps: ExecDeps,
  grpId: number | null,
  roleName: string,
  sliceId?: number | null,
  projectId?: number | null,
): Promise<AgentRow> {
  const { ctx, cfg, roles } = deps;
  const role = roles.get(roleName);
  if (!role) throw new Error(`no role definition for ${roleName} (add roles/${roleName}.yaml)`);

  const [slice] = sliceId
    ? await ctx.db.select({ difficulty: slices.difficulty }).from(slices).where(eq(slices.id, sliceId))
    : [];
  const projectOfGroup = await projectOfGrp(ctx.db, grpId);

  const [row] = await ctx.db
    .insert(agents)
    .values({
      project_id: projectOfGroup ?? projectId ?? null,
      grp_id: grpId,
      role: roleName,
      model: modelFor(cfg, role, slice?.difficulty ?? null),
      // Recorded, not looked up later: the scheduler has to know which account a
      // queued turn would spend without loading roles/*.yaml, and the role could
      // be re-pointed at another provider while this agent is mid-slice.
      runtime: role.runtime ?? DEFAULT_PROVIDER,
      token: mintToken(),
      // Every agent works in its sandbox's checkout; there is no host path left
      // for one to sit in.
      cwd: WORK,
      created_at: Date.now(),
    })
    .returning(AGENT_COLUMNS);
  if (!row) throw new Error(`could not hire ${roleName}: the insert returned no row`);

  await ctx.bus.emit({
    grpId,
    author: "orchestrator",
    kind: "state_change",
    say: msg`hired ${{ role: roleName }}`,
  });
  return row;
}

interface TurnGroup {
  id: number;
  name: string;
  project_id: number;
  branch: string | null;
  owns_json: Json;
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

/**
 * The scope every span in a turn carries, so a stage is aggregable on its own.
 *
 * Putting it only on the outer span would mean the panel could total a turn but
 * not answer the question that motivates the table — which *stage* of which
 * group's turns is the slow one.
 */
async function turnScope(deps: ExecDeps, job: Job<"agent_turn">): Promise<SpanScope> {
  // Looked up rather than left NULL: `scopeAttributes` only emits `project.id`
  // when given one, so the panel's project scope matched nothing. The read path
  // derives it through `grp`, but a span exported over OTLP reaches a collector
  // that never heard of our `grp` table, where this column is the only thing
  // saying which project the work belonged to. Resolved once and handed to each
  // stage — four spans asking separately is four round trips per turn.
  const projectId = job.grp_id === null ? null : await projectOfGrp(deps.ctx.db, job.grp_id);
  return { grpId: job.grp_id, sliceId: job.slice_id, projectId };
}

/**
 * Where a turn's wall clock goes, as four spans rather than one number.
 *
 * The stages can each be slow for a different reason: assembling the prompt,
 * taking the checkpoint (first to touch the sandbox, so a cold container is paid
 * there), the provider call, settling the result. A turn that took nine minutes
 * is not actionable; nine of which eight were the provider is.
 */
async function runAgentTurn(deps: ExecDeps, job: Job<"agent_turn">): Promise<void> {
  const scope = await turnScope(deps, job);
  return activeTracer().startActiveSpan(
    "turn",
    { attributes: { "job.kind": job.kind, ...scopeAttributes(scope) } },
    async (span) => {
      try {
        const turn = await prepareTurn(deps, job, scope);
        span.setAttributes({ "agent.role": turn.agent.role, "agent.runtime": turn.agent.runtime ?? turn.role.runtime });
        const before = await checkpointTurn(deps, job, turn, scope);
        const result = await invokeTurn(deps, job, turn, scope);
        await finishTurn(deps, job, turn, before, result, scope);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errText(error) });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

async function prepareTurn(deps: ExecDeps, job: Job<"agent_turn">, scope: SpanScope): Promise<PreparedTurn> {
  return activeTracer().startActiveSpan("turn.prepare", { attributes: scopeAttributes(scope) }, async (span) => {
    try {
      return await buildPreparedTurn(deps, job);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function buildPreparedTurn(deps: ExecDeps, job: Job<"agent_turn">): Promise<PreparedTurn> {
  const agent = await resolveAgent(deps, job);
  const role = deps.roles.get(agent.role);
  if (!role) throw new Error(`no role definition for ${agent.role}`);
  const group = await turnGroup(deps.ctx.db, job.grp_id);
  const scope: Scope = job.grp_id ? { grp: job.grp_id } : { project: agent.project_id ?? 0 };
  const repoPath = await turnRepoPath(deps.ctx.db, agent, group);
  const stable = await buildStableFor(deps, agent, role, group, repoPath, job);
  const why = rotationReason(agent, deps.cfg, stable, job.payload.rotate === true);
  const rotate = why !== null && why !== "new";
  const sessionId = rotate || !agent.session_id ? crypto.randomUUID() : agent.session_id;
  const delta = await buildTurnDelta(deps, agent, job, rotate, scope);
  return { agent, role, group, scope, stable, delta, rotate, why, sessionId };
}

async function turnGroup(db: DB, groupId: number | null): Promise<TurnGroup | null> {
  if (!groupId) return null;
  const [row] = await db
    .select({
      id: grps.id,
      name: grps.name,
      project_id: grps.project_id,
      branch: grps.branch,
      owns_json: grps.owns_json,
    })
    .from(grps)
    .where(eq(grps.id, groupId));
  return row ?? null;
}

async function turnRepoPath(db: DB, agent: AgentRow, group: TurnGroup | null): Promise<string> {
  if (!group && agent.grp_id) return WORK;
  const projectId = group?.project_id ?? (await projectOfAgent(db, agent.id));
  if (projectId === null) return WORK;
  const [row] = await db.select({ repo_path: projects.repo_path }).from(projects).where(eq(projects.id, projectId));
  return row?.repo_path ?? WORK;
}

function rotationReason(agent: AgentRow, cfg: Config, stable: StablePrompt, explicit: boolean): RotateReason | null {
  if (needsRotation(agent.stable_hash ?? null, stable)) return "hash";
  if (overTokenBudget(agent, cfg)) return "budget";
  if (explicit) return "explicit";
  if (!agent.session_id) return "new";
  return null;
}

/**
 * The checkpoint, and the first thing in a turn to reach the group's sandbox.
 *
 * A cold container is created and provisioned underneath this call, so on a
 * group's first turn this span is where that cost shows up. A dedicated span
 * inside `ensureSandbox` would separate the two, and needs `src/mech/sandbox/`.
 */
async function checkpointTurn(
  deps: ExecDeps,
  job: Job<"agent_turn">,
  turn: PreparedTurn,
  scope: SpanScope,
): Promise<string | null> {
  return activeTracer().startActiveSpan("turn.checkpoint", { attributes: scopeAttributes(scope) }, async (span) => {
    try {
      return await takeCheckpoint(deps, job, turn);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function takeCheckpoint(deps: ExecDeps, job: Job<"agent_turn">, turn: PreparedTurn): Promise<string | null> {
  if (!job.grp_id) {
    await markAgentRunning(deps.ctx.db, turn);
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
    await checkpointLabel(deps.ctx.db, job),
    await gitTrailers(deps.ctx.db),
  );
  if (before) await recordCheckpoint(deps.ctx.db, job, before);
  await markAgentRunning(deps.ctx.db, turn);
  return before;
}

async function recordCheckpoint(db: DB, job: Job<"agent_turn">, before: string): Promise<void> {
  if (job.slice_id) {
    // `coalesce` in the SET, not a read-then-write: the first checkpoint of a
    // slice is its baseline and every later one must leave it alone.
    await db
      .update(slices)
      .set({ base_sha: sql`coalesce(${slices.base_sha}, ${before})` })
      .where(eq(slices.id, job.slice_id));
  }
  await db.update(jobs).set({ checkpoint_sha: before }).where(eq(jobs.id, job.id));
}

async function markAgentRunning(db: DB, turn: PreparedTurn): Promise<void> {
  await db
    .update(agents)
    .set({ state: "running", session_id: turn.sessionId, ...(turn.rotate ? { session_tokens: 0 } : {}) })
    .where(eq(agents.id, turn.agent.id));
}

/** The provider call itself — usually most of a turn, and the one worth isolating. */
async function invokeTurn(
  deps: ExecDeps,
  job: Job<"agent_turn">,
  turn: PreparedTurn,
  scope: SpanScope,
): Promise<TurnResult> {
  return activeTracer().startActiveSpan(
    "turn.provider",
    {
      attributes: {
        "agent.runtime": turn.agent.runtime ?? turn.role.runtime,
        ...scopeAttributes(scope),
      },
    },
    async (span) => {
      try {
        const result = await callProvider(deps, job, turn);
        // A failed turn returns, it does not throw — `claude.ts` sets `ok` false
        // and `terminalReason` to `no_result` when the provider emitted nothing.
        // Erroring only in the catch made that indistinguishable from a turn that
        // worked, in the one surface built to tell them apart.
        if (!result.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: result.terminalReason });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errText(error) });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

async function callProvider(deps: ExecDeps, job: Job<"agent_turn">, turn: PreparedTurn): Promise<TurnResult> {
  const { ctx, cfg } = deps;
  const logDir = join(cfg.dataDir, "turns");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${job.id}.jsonl`);
  const prompt = await turnPrompt(deps, job, turn);
  const spec = await turnSpec(ctx, cfg, job, turn, prompt, logPath);
  const provider = providerFor(turn.agent.runtime ?? turn.role.runtime);
  const run: Provider["run"] = deps.runTurn ?? provider.run;
  let result: TurnResult;
  let stopTurn: (() => void) | undefined;
  try {
    result = await run(
      spec,
      turnEvents(ctx, job, turn.agent, (stop) => {
        stopTurn = stop;
        track(job.id, stop);
      }),
    );
  } finally {
    if (stopTurn) untrack(job.id, stopTurn);
    await ctx.db
      .update(agents)
      .set({ state: "idle" })
      .where(and(eq(agents.id, turn.agent.id), eq(agents.state, "running")));
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

/**
 * Start a session or continue one, which is the one decision in the spec.
 *
 * Named and exported because getting it wrong is expensive in both directions
 * and silent in both: resuming a session the provider has rotated away from
 * fails the turn, and starting fresh when one was live throws away the cached
 * prefix that makes a long requirement affordable.
 */
export function sessionFor(turn: {
  rotate: boolean;
  sessionId: string;
  agent: { session_id?: string | null };
}): { newSessionId: string } | { resumeSessionId: string } {
  return turn.rotate || !turn.agent.session_id ? { newSessionId: turn.sessionId } : { resumeSessionId: turn.sessionId };
}

async function turnSpec(
  ctx: Ctx,
  cfg: Config,
  job: Job<"agent_turn">,
  turn: PreparedTurn,
  prompt: string,
  logPath: string,
) {
  const vault = await vaultFor(ctx.db);
  return {
    stable: turn.stable,
    prompt,
    cwd: WORK,
    ...sessionFor(turn),
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
      ...vault.env,
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
      // Deliberately not awaited. This arrives from the provider's synchronous
      // stream consumer, and the activity line is a live hint — a round trip per
      // tool call would put the database in the middle of the token stream. The
      // failure is announced rather than dropped: a stale activity field looks
      // exactly like an agent that has stopped doing anything.
      void ctx.db
        .update(agents)
        .set({ activity: tool.detail })
        .where(eq(agents.id, agent.id))
        .catch((e: unknown) => live("status", `could not record activity: ${errText(e)}`));
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

/**
 * The fourth quarter of a turn, which was the one nobody could see.
 *
 * The comment on `runAgentTurn` names four stages and three had spans. This is
 * ten serial awaits and two of them enter a container — `preserveTurnBranch`
 * bundles the branch into the mirror, `reconcileOwnership` runs git against the
 * checkout — so "the turn took nine minutes" could resolve to the provider, or
 * here, and there was no way to tell which.
 */
async function finishTurn(
  deps: ExecDeps,
  job: Job<"agent_turn">,
  turn: PreparedTurn,
  before: string | null,
  result: TurnResult,
  scope: SpanScope,
): Promise<void> {
  return activeTracer().startActiveSpan("turn.settle", { attributes: scopeAttributes(scope) }, async (span) => {
    try {
      await settleTurn(deps, job, turn, before, result);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function settleTurn(
  deps: ExecDeps,
  job: Job<"agent_turn">,
  turn: PreparedTurn,
  before: string | null,
  result: TurnResult,
): Promise<void> {
  await recordRuntimeSession(deps.ctx.db, turn, result);
  await preserveTurnBranch(deps.ctx, job, turn.group);
  await recordCost(deps, turn.agent, job, result, turn.stable.hash, turn.why);
  await recordProgress(deps, turn.agent, job, result);
  await narrate(deps, turn.agent, job, before, result);
  await handleRateLimit(deps, turn.agent, job, result);
  await handleAuthFailure(deps, turn.agent, job, result);
  await recordSubscriptionUsage(deps, providerFor(turn.agent.runtime ?? turn.role.runtime).name, result);
  await reconcileOwnership(deps, turn.agent, job, turn.group);
  await repairLostSession(deps.ctx, job, turn, result);
  if (!result.ok) throw new Error(`turn failed (${result.terminalReason}): ${clip(result.text)}`);
}

async function recordRuntimeSession(db: DB, turn: PreparedTurn, result: TurnResult): Promise<void> {
  if (result.sessionId && result.sessionId !== turn.sessionId) {
    await db.update(agents).set({ session_id: result.sessionId }).where(eq(agents.id, turn.agent.id));
  }
}

async function preserveTurnBranch(ctx: Ctx, job: Job<"agent_turn">, group: TurnGroup | null): Promise<void> {
  if (!job.grp_id || !group?.branch) return;
  const kept = await keepBranch(ctx, job.grp_id);
  if (kept.ok || !kept.reason || /empty bundle/i.test(kept.reason)) return;
  await ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "state_change",
    body: `could not take ${group.branch} out of the sandbox: ${kept.reason}`,
  });
}

async function repairLostSession(
  ctx: Ctx,
  job: Job<"agent_turn">,
  turn: PreparedTurn,
  result: TurnResult,
): Promise<void> {
  if (result.ok || !LOST_SESSION.test(result.text)) return;
  await ctx.db.update(agents).set({ session_id: null, stable_hash: null }).where(eq(agents.id, turn.agent.id));
  await ctx.bus.emit({
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
 * `S2: engineer — 闸门放行的卡…`: slice number first, then who did it, then the
 * only sentence anyone wrote about this work. It names the turn that **just
 * ended**, not the one about to start — the checkpoint commits the previous
 * turn's output, so the incoming job's role filed the Engineer's diff as `qa`.
 */
async function checkpointLabel(db: DB, job: Job<"agent_turn">): Promise<string> {
  const [prev] = await db
    .select({ payload_json: jobs.payload_json, slice_id: jobs.slice_id })
    .from(jobs)
    .where(
      and(eq(jobs.grp_id, job.grp_id!), eq(jobs.kind, "agent_turn"), inArray(jobs.state, [...FINISHED_JOB_STATES])),
    )
    .orderBy(desc(jobs.id))
    .limit(1);
  const role = valueOr(prev?.payload_json, AgentTurnPayloadSchema, {}).role ?? "agent";
  if (!prev?.slice_id) return `${role} turn`;
  const sliceId = prev.slice_id;
  const [slice] = await db.select({ seq: slices.seq }).from(slices).where(eq(slices.id, sliceId));
  // The task that turn had claimed. Not "not done": by the time this runs it
  // usually is done, which is what left every checkpoint labelled with the next
  // task instead of the one in the commit.
  const [task] = await db
    .select({ title: tasks.title })
    .from(tasks)
    .where(eq(tasks.slice_id, sliceId))
    .orderBy(desc(sql`(${tasks.status} = 'done')`), desc(tasks.id))
    .limit(1);
  const head = slice?.seq ? `S${slice.seq}: ${role}` : `${role} turn`;
  return task ? `${head} — ${task.title.slice(0, 60)}` : head;
}

async function buildStableFor(
  deps: ExecDeps,
  agent: AgentRow,
  role: RoleDef,
  grp: { name: string; owns_json?: Json } | null | undefined,
  repoPath: string,
  job: Job<"agent_turn">,
) {
  const { ctx, cfg } = deps;

  const projectId = await projectOfAgent(ctx.db, agent.id);

  const onboarding = await noteBody(ctx.db, projectId, "onboarding");
  // Owned by `report.ts`, next to the eviction that decides which survive.
  const lessons = await lessonsFor(ctx.db, projectId);
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
 * `withAttachments` writes the attachment's **host** path into the message, and
 * since 005 that path does not exist where the turn runs. Only paths under
 * `<dataDir>/attachments` are touched — exact, so it cannot mistake an agent's
 * own bullet list for an attachment block the way parsing the header would.
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
      await deps.ctx.bus.emit({
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
async function recordSubscriptionUsage(deps: ExecDeps, provider: string, r: TurnResult): Promise<void> {
  const rl = r.rateLimit;
  if (!rl || rl.fiveHourPercent === undefined) return;
  const at = Date.now();
  // `json` is jsonb: the value goes in, not `JSON.stringify` of it, or the column
  // holds a JSON string whose every reader then has to parse twice.
  await deps.ctx.db
    .insert(usage_snapshot)
    .values({ runtime: provider, json: rl, at })
    .onConflictDoUpdate({ target: usage_snapshot.runtime, set: { json: rl, at } });
}

/**
 * File ownership, enforced after the fact. The only mechanism there is.
 *
 * The container is the write boundary and knows nothing about which group owns
 * which file (005 §Ceiling), so the rule runs against `git status` here and the
 * files go back, deterministically, and are announced — a silent revert has the
 * agent puzzling over work that vanishes. `sandboxGit`: `/work` is inside.
 */
export async function reconcileOwnership(
  deps: { ctx: Ctx },
  agent: { role: string },
  job: { grp_id: number | null },
  grp: { owns_json?: Json } | null | undefined,
): Promise<void> {
  const owns = parseOwns(grp?.owns_json ?? null);
  if (!owns.length || !job.grp_id) return;

  const git = sandboxGit(deps.ctx, { grp: job.grp_id });
  const status = await git(STATUS_Z, WORK);
  if (status.code !== 0) {
    // Said out loud. This is the only file-ownership enforcement there is since
    // 005 deleted the deny-list, and `engineer.yaml` promises it to the agent —
    // so skipping silently means the boundary is off and everything reads normal.
    await deps.ctx.bus.emit({
      grpId: job.grp_id,
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body: `could not check file ownership this turn (git status in the sandbox: ${status.out.slice(0, 200)})`,
    });
    return;
  }
  const entries = porcelainEntries(status.out);
  const stray = outsideOwns(
    entries.map((entry) => entry.path),
    owns,
  );
  if (!stray.length) return;

  // Split by status code rather than handing both commands one pathspec.
  // `git checkout --` is all-or-nothing: measured, a single untracked path in the
  // list makes it report `did not match any file(s)` and revert nothing, while
  // `clean` removes the untracked half — so the pair half-succeeded and the count
  // below read as success. Sequential, because both write the index.
  const untracked = new Set(entries.filter((entry) => entry.xy === "??").map((entry) => entry.path));
  const modified = stray.filter((path) => !untracked.has(path));
  const created = stray.filter((path) => untracked.has(path));
  const co = modified.length ? await git(["checkout", "--", ...modified], WORK) : null;
  const cl = created.length ? await git(["clean", "-fd", "--", ...created], WORK) : null;
  // What is actually gone, read back rather than assumed. This announcement used
  // to be made from the list of files we had *tried* to revert: when the pathspec
  // did not match — every non-ASCII and every spaced path, before `-z` — git
  // exited 1, changed nothing, and the boss was told the boundary had held.
  const after = await git(STATUS_Z, WORK);
  // A status we could not read back is not evidence that anything was reverted.
  const left = after.code === 0 ? new Set(outsideOwns(porcelainPaths(after.out), owns)) : new Set(stray);
  const reverted = stray.filter((p) => !left.has(p));
  // Anything still outside the group's paths, not "did we manage to remove one".
  // A partial rollback used to reach the success announcement below.
  if (left.size) {
    await deps.ctx.bus.emit({
      grpId: job.grp_id,
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body:
        `could not roll back ${left.size} file(s) outside this group's paths ` +
        `(${[...left].slice(0, 5).join(", ")}): ${(co?.out || cl?.out || "git changed nothing").slice(0, 200)}`,
      meta: { left: [...left], reverted, stray, owns },
    });
    return;
  }
  await deps.ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "state_change",
    severity: "blocker",
    say: msg`${{ role: agent.role }} wrote ${plural({ n: String(reverted.length) }, { one: "# file", other: "# files" })} this group does not own (${{ files: reverted.slice(0, 5).join(", ") }}) — reverted; this CLI's sandbox cannot stop the write, so the check runs after it`,
    meta: { reverted, stray, owns },
  });
}

async function recordCost(
  deps: ExecDeps,
  agent: AgentRow,
  job: Job,
  r: TurnResult,
  stableHash: string,
  rotate: RotateReason | null,
): Promise<void> {
  const { ctx } = deps;
  const total = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheCreate;
  // session_tokens tracks context occupancy, not billing: output and cacheRead
  // don't sit in the next turn's prompt, so counting them makes overTokenBudget
  // trip every turn once a session has run long (see grp7 risk note).
  const contextTokens = r.usage.input + r.usage.cacheCreate;
  // Read-modify-write in the statement, not in TypeScript: two turns of the same
  // group settle concurrently and the loser would overwrite the winner's total.
  await ctx.db
    .update(agents)
    .set({
      session_tokens: sql`${agents.session_tokens} + ${contextTokens}`,
      total_tokens: sql`${agents.total_tokens} + ${total}`,
      stable_hash: stableHash,
      ...(r.contextWindow ? { context_window: r.contextWindow } : {}),
    })
    .where(eq(agents.id, agent.id));
  if (job.slice_id) {
    await ctx.db
      .update(slices)
      .set({ spent_tokens: sql`${slices.spent_tokens} + ${total}` })
      .where(eq(slices.id, job.slice_id));
  }
  if (job.grp_id) {
    await ctx.db
      .update(grps)
      .set({ spent_tokens: sql`${grps.spent_tokens} + ${total}` })
      .where(eq(grps.id, job.grp_id));
  }
  // cacheRead vs input is the only visible signal that the prompt cache is
  // still working. A sudden drop means someone broke assemble.ts.
  await ctx.bus.emit({
    grpId: job.grp_id,
    author: agent.role,
    kind: "tool_summary",
    body: `turn done (${r.numTurns} steps, ${total} tokens)`,
    // The provider, recorded rather than inferred: the `model LIKE 'gpt%'` split
    // 成本 used breaks on any rename, and the event row has no agent to join to.
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
async function recordProgress(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult): Promise<void> {
  const { ctx } = deps;
  const since = Date.now() - 5 * 60_000;
  // `IS ?` matched a NULL group; `eq` never does, and a standing agent with no
  // group would then always read as having written nothing.
  const [notesWritten] = await ctx.db
    .select({ c: count() })
    .from(notes)
    .where(and(job.grp_id === null ? isNull(notes.grp_id) : eq(notes.grp_id, job.grp_id), gt(notes.at, since)));
  const [tasksMoved] = await ctx.db
    .select({ c: count() })
    .from(tasks)
    .where(and(eq(tasks.owner_agent_id, agent.id), eq(tasks.status, "done")));
  await recordTurnOutcome(ctx, agent.id, r.filesTouched, (notesWritten?.c ?? 0) > 0, (tasksMoved?.c ?? 0) > 0);
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
  const { ctx } = deps;
  for (const t of r.toolSummaries.slice(0, 12)) {
    await ctx.bus.emit({ grpId: job.grp_id, author: agent.role, kind: "tool_summary", body: t.detail });
  }

  let files = r.filesTouched;
  if (before && job.grp_id) {
    const changed = await changedSince(sandboxGit(ctx, { grp: job.grp_id }), WORK, before);
    if (changed.length) files = changed;
  }
  if (files.length) {
    await ctx.bus.emit({
      grpId: job.grp_id,
      author: agent.role,
      kind: "commit",
      body: files.slice(0, 20).join(", "),
      meta: { files, checkpoint: before },
    });
  }
}

/**
 * The credential stopped working.
 *
 * A year-long OAuth token expires exactly once, and when it does every group
 * fails at the same moment with what reads like a model error. Retrying is the
 * one thing that cannot help, so the group stops and the question points at the
 * settings page — this is a decision only the boss can make.
 */
async function handleAuthFailure(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult): Promise<void> {
  if (r.ok || !isAuthFailure(r.text)) return;
  const { ctx } = deps;
  const runtime = agent.runtime ?? DEFAULT_PROVIDER;
  if (job.grp_id) {
    await hold(ctx.db, job.grp_id, { reason: `auth:${runtime}`, settled: true, from: "RUNNING" });
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
  await ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "escalation",
    intent: "ask",
    severity: "blocker",
    body: `${runtime} credentials rejected`,
  });
}

async function handleRateLimit(deps: ExecDeps, agent: AgentRow, job: Job, r: TurnResult): Promise<void> {
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
  const at = Date.now();
  // Only `hold_until` and `at` on conflict, as before: the stored `json` is the
  // last usage report, and a rate-limit notice is not one.
  await ctx.db
    .insert(usage_snapshot)
    .values({ runtime: agent.runtime ?? DEFAULT_PROVIDER, json: rl, at, hold_until: resetsMs })
    .onConflictDoUpdate({ target: usage_snapshot.runtime, set: { hold_until: resetsMs, at } });
  await ctx.bus.emit({
    grpId: job.grp_id,
    author: "orchestrator",
    kind: "state_change",
    say: msg`rate limited; everything on this CLI holds until the window reopens (~${{ at: new Date(resetsMs).toLocaleString() }}) and resumes itself — the quota belongs to the account, so no model spends less of it`,
    meta: rl,
  });
  if (job.grp_id) {
    await hold(ctx.db, job.grp_id, { reason: "ratelimit", settled: true, until: resetsMs });
  }
}

function overTokenBudget(agent: AgentRow, cfg: Config): boolean {
  // Fallback trigger only. The real rotation point is slice completion, a clean
  // semantic boundary that makes the handoff cheap. The denominator is the
  // model's own window, never a literal: the strong models have far more, and
  // every rotation throws away a cached prefix that cost money to build.
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
  if (out.pass) await handToQa(rd, job.slice_id);
  else await sendBack(rd, job.slice_id, out.feedback, "gate");
}

/**
 * The watchdog runs as an ordinary job, which is why it bypasses the group slot
 * pool: otherwise it could never fire on the very group that is stuck.
 */
async function runWatchdogJob(deps: ExecDeps): Promise<void> {
  const findings = await runWatchdog({ ctx: deps.ctx, cfg: deps.cfg });
  for (const finding of findings) publishWatchdogFinding(deps.ctx, finding);
  for (const item of await runStandup(deps.ctx.db)) await publishStandupItem(deps.ctx, item);
}

/**
 * Rendered here, and in `output.language`.
 *
 * The event carrying this finding went out with a key on it, which the panel
 * renders in its own locale. This is the other reader: `onFinding` feeds the
 * `Notifier`, and `busDeliver` POSTs what it produces to a webhook — no browser
 * on that path, which is ADR 035 §3's test for staying server-rendered.
 */
export function publishWatchdogFinding(ctx: Ctx, finding: Finding): void {
  ctx.onFinding?.(finding.rule, finding.severity, renderSaid(ctx.config.language, finding.say), finding.grpId);
}

export async function publishStandupItem(
  ctx: Ctx,
  item: { kind: string; body: string; grpIds: number[] },
): Promise<void> {
  const [seen] = await ctx.db
    .select({ at: maxMs(events.at) })
    .from(events)
    .where(and(eq(events.author, "standup"), eq(events.body, item.body)));
  if (seen?.at && Date.now() - seen.at < ctx.config.watchdog.reemitMs) return;
  const groupId = item.grpIds[0] ?? null;
  await ctx.bus.emit({
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
  return async (grpId: number, pass: boolean, note: string): Promise<void> =>
    await auditVerdict({ ctx: deps.ctx, cfg: deps.cfg }, grpId, pass, note);
}

/** Called by the server when QA files a verdict. */
export function makeReviewVerdict(deps: ExecDeps) {
  return async (sliceId: number, pass: boolean, note: string): Promise<void> => {
    const rd = { ctx: deps.ctx, cfg: deps.cfg };
    if (pass) await handToBoss(rd, sliceId);
    else await sendBack(rd, sliceId, note || "QA rejected the slice", roleFor(deps.ctx, "review_slice"));
  };
}

/** Newest note of a kind. `id DESC` for the same reason the lessons query has it. */
async function noteBody(db: DB, projectId: number | null, kind: string): Promise<string | null> {
  // The project's own, or a global one. `IS ?` was doing both halves at once; the
  // NULL branch has to be spelled out now, and `or` keeps globals visible to a
  // project that has no note of its own.
  const [row] = await db
    .select({ body: notes.body })
    .from(notes)
    .where(
      and(
        or(projectId === null ? isNull(notes.project_id) : eq(notes.project_id, projectId), isNull(notes.project_id)),
        eq(notes.kind, kind),
      ),
    )
    .orderBy(desc(notes.at), desc(notes.id))
    .limit(1);
  return row?.body ?? null;
}
