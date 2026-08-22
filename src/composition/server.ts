import { msg, plural } from "@lingui/core/macro";
import { errText } from "../platform/process/text.ts";
import { renderSaid } from "../platform/text/lang.ts";
import { makeNoteIndex } from "../mech/knowledge/note-index.ts";
import { existsSync, chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeApp } from "./api.ts";
import { landGroup } from "../api/panel/group.ts";
import { roleFor, type Ctx } from "../mech/ctx.ts";
import { joinQueue } from "../mech/flow/mergequeue.ts";
import { bindSandboxKey } from "../mech/sandbox/auth.ts";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { Bus, trimEvents } from "../platform/persistence/event-bus.ts";
import { projectOfGrp } from "../mech/util/rows.ts";
import { maxMs, escalation, grp, job, project, runtime_auth as runtimeAuth } from "../platform/persistence/schema.ts";
import { consola } from "consola";
import {
  checkCapabilities,
  loadConfig,
  loadRoles,
  ROOT,
  withAbsoluteDataDir,
  type Config,
} from "../platform/config/load.ts";
import { applyOverrides } from "../platform/config/settings.ts";
import { changed, checkConfig, checkRoles } from "../mech/ops/checkconfig.ts";
import { open } from "../platform/persistence/database.ts";
import { REAL, sandboxHeld, type Scope } from "../mech/sandbox/sandbox.ts";
import type { DB } from "../platform/persistence/database.ts";
import { startMailbox } from "../mech/sandbox/mailbox.ts";
import { baseRefFor, createCheckout, treeHeads } from "../mech/git/checkout.ts";
import { makeCheck, preflight, type Check } from "../mech/ops/preflight.ts";
import { restageSkills } from "../mech/skills.ts";
import { ensureServer, type ServerState } from "../mech/sandbox/server.ts";
import { batchForBoss, busDeliver, notifiable, Notifier, tierFor, type PendingItem } from "../mech/ops/notify.ts";
import { dispatchFeedback, type Feedback, openPr, pollPrs, prBody, prTitle } from "../mech/git/prwatch.ts";
import { type Github, makeGithub } from "../mech/git/github.ts";
import { repoHeld } from "../mech/git/repository.ts";
import {
  chargeIndex,
  HEAD_CHARS,
  modelAsk,
  noteLeaves,
  NOTE_PREFIX,
  saveTree,
  skeleton,
  summarise,
  loadTree,
} from "../mech/knowledge/pageindex.ts";
import { indexable, indexExcludes } from "../mech/knowledge/repomap.ts";
import { hire, makeAuditVerdict, makeExecutor, makeReviewVerdict } from "../application/executor.ts";
import { reclaimOrphans, resumeReclaimed, Scheduler } from "../platform/scheduling/scheduler.ts";
import { abortAll } from "../platform/process/running-turns.ts";
import { isOnline } from "../mech/sandbox/net.ts";
import { hold } from "../mech/flow/intercept.ts";
import { escalationKey, raise } from "../mech/flow/escalate.ts";
import { restoreWorkspace } from "../mech/flow/start.ts";
import { closeTelemetry, runtimeStatus, type RuntimeStatus } from "../platform/observability/metrics.ts";
import { ACTIVE_JOB_STATES } from "../contracts/states.ts";
import { configureTracing } from "../platform/observability/otel.ts";
import { trimSpans } from "../platform/observability/span-store.ts";
import { configureStructuredLogging } from "../platform/observability/logging.ts";
import { VERSION } from "../platform/process/version.ts";

/**
 * Wires the pieces together and serves them.
 *
 * One process: HTTP + SSE for the web UI, the same routes for `orch`, the job
 * queue, and the sandboxes it drives. Bound to 127.0.0.1: nothing outside this
 * machine needs it, and agents reach it through the mailbox rather than the
 * network (docs/adr/005).
 */

export interface Started {
  ctx: Ctx;
  cfg: Config;
  url: string;
  notifier: Notifier;
  stop: () => void;
  shutdown: (deadlineMs?: number) => Promise<number>;
  runtime: RuntimeStatus;
}

/** Refresh the cached readiness snapshot without coupling tests to a real server. */
export async function refreshRuntimeReadiness(
  runtime: RuntimeStatus,
  load: () => Promise<ReadonlyArray<Check>>,
): Promise<void> {
  try {
    const checks = await load();
    runtime.checks = checks;
    runtime.ready = checks.every((check) => check.ok);
  } catch (error) {
    runtime.ready = false;
    runtime.checks = [makeCheck("preflight", false, msg`the checks could not run: ${{ error: errText(error) }}`)];
  }
}

/** Runs the two-phase process shutdown in an order tests can prove. */
export async function shutdownRuntime(
  ops: {
    stopIntake: () => boolean;
    drain: () => Promise<void>;
    gracefulStop: () => Promise<void>;
    reclaim: () => Promise<void>;
    abort: () => void;
    forceStop: () => Promise<void>;
    close: () => void;
    sleep: (ms: number) => Promise<unknown>;
  },
  deadlineMs = 10_000,
): Promise<0 | 1> {
  if (!ops.stopIntake()) return 0;
  const graceful = await Promise.race([
    Promise.all([ops.drain(), ops.gracefulStop()]).then(() => true),
    ops.sleep(deadlineMs).then(() => false),
  ]);
  if (!graceful) {
    await ops.reclaim();
    ops.abort();
    await ops.forceStop();
    await Promise.race([ops.drain(), ops.sleep(1_000)]);
  }
  ops.close();
  return graceful ? 0 : 1;
}

/**
 * How often the self-check runs, derived from the watchdog's own interval.
 *
 * Clamped rather than followed: below five seconds the `spawnSync` calls to the
 * docker daemon block the event loop more often than they say anything, and
 * above thirty a machine that lost its sandbox server takes half a minute to
 * report it.
 */
export const readinessPeriodMs = (watchdogIntervalMs: number): number =>
  Math.min(Math.max(watchdogIntervalMs, 5_000), 30_000);

/**
 * Nothing. The host runs no binary of its own — what is left on this machine is
 * the server, sqlite and mailbox polling, so a headless box with docker, the
 * image and a pasted token starts. Kept as a function rather than deleted: the
 * one place to name a host binary if one is ever needed again.
 */
export function missingBinaries(): string[] {
  return [];
}

/**
 * The bundle is `/dist/main.js` with no hash in the name, and Bun's file
 * responses carry no etag and no last-modified — so without this the browser
 * heuristically caches it and keeps showing a UI that was already rebuilt.
 *
 * `no-cache` is revalidate-every-time, not "never store".
 */
const NO_CACHE = "no-cache";
const INDEX_PATHS = new Set(["/", "/index.html"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isApplicationPath(path: string): boolean {
  return path === "/healthz" || path === "/readyz" || path.startsWith("/api/v1/") || path.startsWith("/orch/v1/");
}

/** What the heartbeat has already started and must not start twice. */
export interface InFlight {
  index: Promise<void> | null;
  poll: Promise<void> | null;
}

export interface HeartbeatDeps {
  ctx: Ctx;
  db: DB;
  /** Only the two calls a tick makes, so a test does not have to build a Scheduler. */
  sched: Pick<Scheduler, "enqueue" | "tick">;
  gh: Github;
  url: string;
  notifier: Notifier;
  /** Registers background work so shutdown can wait for it. */
  track: <T>(work: Promise<T>) => Promise<T>;
  inFlight: InFlight;
}

/**
 * One tick of the server's own work, separated from the timer that drives it, so
 * every branch here is reachable without starting the process and waiting out an
 * interval. Only the re-arming stays in the callback: that is about the handle.
 */
export async function heartbeat({ ctx, db, sched, gh, url, notifier, track, inFlight }: HeartbeatDeps): Promise<void> {
  // The watchdog is an ordinary job, and one in flight is enough.
  //
  // `pending` **or** `running`: a tick can outlast the interval that drives it,
  // and counting only pending enqueues a second one the moment it does, forever.
  // Two watchdogs at once is worse than a slow one — the rules keep module state
  // (the server argv last seen, the sweep clock, which projects were warned)
  // that a second run would race.
  const [queued] = await db
    .select({ c: count() })
    .from(job)
    .where(and(eq(job.kind, "watchdog"), inArray(job.state, [...ACTIVE_JOB_STATES])));
  // `?? 0`, so a row that somehow did not come back still enqueues: a watchdog
  // that never fires is the failure this whole block exists to prevent, and a
  // duplicate one is caught by the same count on the next tick.
  if ((queued?.c ?? 0) === 0) await sched.enqueue("watchdog", {});
  await sched.tick();

  // Span retention, on the tick rather than on the span. A trace arriving is not
  // a reason to run housekeeping, and this is already the process's periodic
  // driver — a timer of its own would be a second thing to arm and shut down.
  await trimSpans(db);
  // The same for events, which had no retention at all: the only `DELETE FROM
  // event` in the tree was project deletion, so an installation kept every
  // `state_change` it had ever emitted and a stale SSE cursor replayed all of them.
  await trimEvents(db, ctx.config.eventRetentionMs);

  // Everything waiting on the boss, as one message. The CoS is meant to do this
  // in its own words; this is the backstop for when it does not run at all.
  const waiting: PendingItem[] = await db
    .select({
      id: escalation.id,
      severity: escalation.severity,
      question: escalation.question,
      grpId: escalation.grp_id,
      group: grp.name,
    })
    .from(escalation)
    .leftJoin(grp, eq(grp.id, escalation.grp_id))
    .where(and(eq(escalation.chain_state, "boss"), isNull(escalation.answer)))
    .orderBy(asc(escalation.created_at), asc(escalation.id));
  const batched = batchForBoss(waiting, url);
  if (batched) void notifier.push(batched);

  // Both of these need the network — the index spawns a model, `pollPrs` asks
  // GitHub — so they sit behind the same gate the scheduler uses. Offline they
  // would each spend their timeout every thirty seconds and fill the feed with
  // failures the boss can do nothing about.
  if (!isOnline()) return;

  // Keep the PageIndex tree current. Incremental by file signature, so a quiet
  // repo costs zero model calls; a busy one pays for the files that changed.
  // Caught here rather than at the process backstop, which emits a blocker per
  // tick, forever — `bus.emit` has no dedup.
  if (!inFlight.index) {
    inFlight.index = track(refreshIndex(ctx).catch((error: unknown) => indexThrew(ctx, error))).finally(() => {
      inFlight.index = null;
    });
  }

  // Polling is arithmetic, not judgement, so it happens here rather than in an
  // agent. Only a change wakes the PM. The `.then` writes rows and enqueues
  // turns, so a group dropped between poll and handler would otherwise be a
  // process-wide blocker for one stale row.
  if (!inFlight.poll) {
    inFlight.poll = track(
      pollPrs(ctx, gh)
        .then(async (fs) => {
          for (const f of fs) await applyPrOutcome(ctx, f, url, notifier);
        })
        .catch((e: unknown) => consola.error(`pollPrs: ${errText(e)}`)),
    ).finally(() => {
      inFlight.poll = null;
    });
  }
}

/**
 * Log every unhandled rejection, but put each distinct one on the boss's feed
 * once. Returns the text to compare the next one against.
 *
 * Mostly per-tick chains, so without the check one recurring bug is a blocker
 * line every interval and the feed stops being readable. The console keeps all.
 */
export function reportRejection(bus: Bus, e: unknown, said: string): string {
  const why = (e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 600);
  consola.error(`unhandled rejection (kept running):\n${why}`);
  if (why === said) return said;
  // Detached with its failure handled, not awaited: the caller is a
  // `process.on("unhandledRejection")` listener, which is synchronous and cannot
  // be made otherwise. If the record is the thing that failed, the console line
  // above is the report.
  void bus
    .emit({
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      say: msg`A background task crashed and the server carried on without it. That is a bug — please send this to whoever maintains it:\n${{ stack: why.slice(0, 400) }}`,
    })
    .catch(() => {});
  return why;
}

/**
 * What one poll result means for the group behind it.
 *
 * Four outcomes, not interchangeable: a merge lands the group, a close stops it
 * and asks the boss, a reopen puts it back, anything else is review feedback.
 * Order matters — a PR can come back merged *and* closed in one poll, and
 * treating that as a close stops a group whose work is already on main.
 */
export async function applyPrOutcome(ctx: Ctx, f: Feedback, url: string, notifier: Notifier): Promise<void> {
  if (f.merged) {
    await landGroup(ctx, f.grpId, "github");
    return;
  }
  if (f.closed) return await prClosed(ctx, f.grpId, f.prNumber, url, notifier);
  if (f.reopened) return await prReopened(ctx, f.grpId, f.prNumber);
  await dispatchFeedback(ctx, f);
}

/**
 * The boss closed the PR on GitHub.
 *
 * Leaves the merge queue rather than blocking it: the queue is strictly serial,
 * so a group that will never merge at its head stops every group behind it. Stops
 * as a group waiting on the boss, with both exits stated, and reopens nothing
 * automatically — the close was deliberate.
 */
async function prClosed(ctx: Ctx, grpId: number, prNumber: number, url: string, notifier: Notifier): Promise<void> {
  const [g] = await ctx.db.select({ name: grp.name }).from(grp).where(eq(grp.id, grpId));
  await hold(ctx.db, grpId, { reason: "merge", settled: true, from: "PR_OPEN", leaveQueue: true });
  // `key`, not the opening line. Two matchers find this row again — `prReopened`
  // below and `replacePr` in `api/panel/group.ts` — and both used to compare the
  // sentence, so translating it was enough to strand a group in `Awaiting your decision` forever.
  // The text is still rendered here because `delta.ts` splices it into a prompt.
  await raise(ctx.db, {
    grpId,
    key: escalationKey.prClosed(prNumber),
    lang: ctx.config.language,
    brief: msg`PR closed — reopen it or not`,
    chain: "boss",
    question: msg`PR #${{ pr: prNumber }} was closed without merging. This group has stopped and left the merge queue.\nTo carry on: reopen the PR on GitHub and it rejoins the queue by itself. To give up on it: drop the requirement.`,
  });
  await ctx.bus.emit({
    grpId,
    author: "pr-watcher",
    kind: "escalation",
    intent: "ask",
    severity: "blocker",
    say: msg`PR #${{ pr: prNumber }} was closed without merging`,
    meta: { pr: prNumber },
  });
  void notifier.push({
    key: `pr-closed:${grpId}:${prNumber}`,
    tier: "immediate",
    // A notification leaves this machine for a person, so it is rendered here in
    // the output language rather than sent as a descriptor: ADR 035 §3 row two.
    body: renderSaid(
      ctx.config.language,
      msg`${{ name: g?.name ?? grpId }}: PR #${{ pr: prNumber }} was closed — reopen it or drop the requirement`,
    ),
    url: `${url}/#g=${grpId}&v=progress`,
  });
}

/** Reopened on GitHub: back into the queue, and the question that asked is answered. */
async function prReopened(ctx: Ctx, grpId: number, prNumber: number): Promise<void> {
  await ctx.db
    .update(grp)
    .set({ status: "PR_OPEN", paused_at: null, pause_reason: null })
    .where(and(eq(grp.id, grpId), eq(grp.status, "PAUSED")));
  // The question this answers is the one `prClosed` asked, found by the key it
  // filed under. It was a prefix test over the question's first line, escaped
  // for LIKE; the key is per-PR, so this now also cannot close a question about
  // a different PR in the same group, which the prefix could not distinguish.
  await ctx.db
    .update(escalation)
    .set({ chain_state: "answered", answered_by: "github", answer: "reopened" })
    .where(
      and(
        eq(escalation.grp_id, grpId),
        isNull(escalation.answer),
        eq(escalation.dedupe_key, escalationKey.prClosed(prNumber)),
      ),
    );
  await joinQueue(ctx.db, grpId);
  await ctx.bus.emit({
    grpId,
    author: "pr-watcher",
    kind: "state_change",
    say: msg`PR #${{ pr: prNumber }} was reopened; back in the merge queue`,
    meta: { pr: prNumber },
  });
  await ctx.sched.tick();
}

/**
 * The indexer's memory, per database rather than per process.
 *
 * Three module-level containers keyed by project id alone, which `AGENTS.md`
 * invariant 11 forbids: a second database with a project id 1 inherited the
 * first one's verdict. A `WeakMap` because the owner is the database — when it
 * goes so does this, with no sweep to write and nothing to forget to call.
 */
interface IndexMemory {
  /** Content stamp of the last pass that finished clean, so an unchanged tree is free. */
  at: Map<number, string>;
  /** Projects already told about a container that will not open. */
  warned: Set<number>;
  /** Projects whose model answered nothing, against the credential stamp at the time. */
  down: Map<number, number>;
  /** When a pass that *threw* stops being backed off. Not per project: a socket
   *  that will not carry a file carries nobody's. */
  blockedUntil: number;
  /** The last throw's reason, so the same one is not announced every tick. */
  lastError: string;
}

const memories = new WeakMap<DB, IndexMemory>();

function memory(db: DB): IndexMemory {
  const found = memories.get(db);
  if (found) return found;
  const fresh: IndexMemory = { at: new Map(), warned: new Set(), down: new Map(), blockedUntil: 0, lastError: "" };
  memories.set(db, fresh);
  return fresh;
}

/** When the runtimes' credentials last changed. Rule 17b reads the same row. */
const authStamp = async (db: DB): Promise<number> => {
  const [row] = await db.select({ at: maxMs(runtimeAuth.updated_at) }).from(runtimeAuth);
  return row?.at ?? 0;
};

/**
 * Whether a pass would be spending calls that cannot be answered.
 *
 * Keyed on the credential stamp, not on the project or the tree: nothing about a
 * repository can make an unauthenticated CLI authenticate, so only a credential
 * change is grounds to try again. Exported so the skip is testable — the previous
 * version of that claim gated only the warning and nothing asserted it.
 */
/**
 * An index pass that *threw*, which is not the same as one whose calls failed.
 *
 * `recordIndexResult` is what arms the credential pause, and a throw never reaches
 * it — so this path retried every thirty seconds forever, each time paying for a
 * checkout and a `treeHeads` before failing, and each time emitting a fresh event
 * because `bus.emit` has no dedup.
 */
/**
 * A throw is not a credential problem, so it does not wait on a credential: it backs
 * off for a few ticks and says the reason once per distinct reason. A socket that
 * recovers is picked up by the next attempt; one that does not stops costing a
 * container round trip per tick.
 */
export const INDEX_THROW_BACKOFF_MS = 5 * 60_000;

/**
 * Whether `orch ctx query` gets a model to walk the summary tree with.
 *
 * An empty `indexModel.model` turns it off, and both readers of `askIn` already
 * treat its absence as "no navigator": the query falls through to the lexical
 * half and the index stops rebuilding. So the off switch is a setting, not a
 * second code path — and it is what makes this layer's own claim testable, since
 * "cheaper than the grep rounds it replaces" was never measured against not
 * having it.
 */
export function navigatorEnabled(indexModel: { model: string }): boolean {
  return indexModel.model.trim().length > 0;
}

/**
 * What boot says about the sandbox server it found.
 *
 * Four states and only one of them is ours to act on. `stuck` is the one worth
 * being careful with: a server that is up and undrivable may be somebody else's,
 * and "we cannot drive it" is not evidence that nobody can — so it raises a
 * question rather than restarting a process this installation did not start.
 */
/**
 * Which of four things a request is, before any of them is done.
 *
 * `/metrics` is the only one with a rule behind it rather than a path: ADR 012
 * keeps it on loopback, and the `PrometheusExporter` was left unused precisely
 * because it opens a port on every interface and would walk around this. The
 * address is a thunk because asking for it is only free when it is needed.
 */
export function routeRequest(path: string, peer: () => string | undefined): "index" | "app" | "refuse" | "file" {
  if (INDEX_PATHS.has(path)) return "index";
  if (path === "/metrics") {
    const ip = peer();
    return ip && !LOOPBACK_ADDRESSES.has(ip) ? "refuse" : "app";
  }
  return isApplicationPath(path) ? "app" : "file";
}

export async function reportServerState(ctx: Ctx, st: ServerState): Promise<void> {
  if (st.kind === "started") {
    consola.success(`opensandbox-server started (pid ${st.pid}, ${st.config})`);
    await ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      say: msg`the sandbox server is up — we started it (pid ${{ pid: st.pid }})`,
    });
    return;
  }
  if (st.kind === "theirs") {
    consola.info(`opensandbox-server already running (pid ${st.pid}) — using it, not touching it`);
    return;
  }
  if (st.kind === "down") {
    consola.warn(`opensandbox-server: ${renderSaid("en", st.why)}`);
    return;
  }
  // `ours` is a server this orchestrator started and is still driving. The chain
  // this replaced had no branch for it and fell out silently, which was right by
  // accident: a reconnect to our own process is not news.
  if (st.kind === "ours") return;
  consola.warn(`opensandbox-server running (pid ${st.pid}) but not drivable: ${renderSaid("en", st.why)}`);
  await ctx.bus.emit({
    author: "orchestrator",
    kind: "escalation",
    intent: "inform",
    severity: "blocker",
    // `st.why` verbatim, not wrapped: a descriptor cannot nest in another, and
    // rendering it to a string to interpolate is one sentence in two languages.
    // Nothing is lost — `say()` in `sandbox/server.ts` already names the way out
    // for each `Probe`, and "we left it alone" is what "that we did not start"
    // there already means. The pid is data, so it rides in `meta`.
    say: st.why,
    meta: { pid: st.pid },
  });
}

export async function indexThrew(ctx: Ctx, error: unknown, now = Date.now()): Promise<void> {
  const reason = errText(error);
  const mem = memory(ctx.db);
  mem.blockedUntil = now + INDEX_THROW_BACKOFF_MS;
  // Once per reason, not once per tick: the same socket failure is one piece of
  // news however many times it happens, and a different one is worth saying.
  if (reason === mem.lastError) return;
  mem.lastError = reason;
  await ctx.bus.emit({ author: "orchestrator", kind: "state_change", say: msg`the index pass threw: ${{ reason }}` });
}

export async function indexPaused(db: DB, projectId: number): Promise<boolean> {
  return memory(db).down.get(projectId) === (await authStamp(db));
}

/**
 * Which projects a pass should enter, which is the whole of the decision.
 *
 * Separate from the loop because it is the testable half: a project with no
 * remote has nothing to mirror, and one whose model answered nothing has nothing
 * to ask — and the second of those used to be decided *after* a container
 * checkout had already been paid for.
 */
export async function indexTargets(db: DB, now = Date.now()): Promise<IndexProject[]> {
  if (now < memory(db).blockedUntil) return [];
  const rows = await db.select({ id: project.id, remote: project.remote }).from(project);
  const targets: IndexProject[] = [];
  // `indexPaused` rather than its two lines inlined, even though that means one
  // read of the same row per project: it is the rule a test asserts on directly,
  // and a second copy here is a second thing to keep true.
  for (const p of rows) {
    if (p.remote && !(await indexPaused(db, p.id))) targets.push({ id: p.id, remote: p.remote });
  }
  return targets;
}

async function refreshIndex(ctx: Ctx): Promise<void> {
  const askIn = ctx.askIn;
  if (!askIn) return;
  for (const project of await indexTargets(ctx.db)) await refreshProjectIndex(ctx, project, askIn);
}

type AskIn = NonNullable<Ctx["askIn"]>;
/** A project a pass can actually enter: it has somewhere to mirror from. */
export type IndexProject = { id: number; remote: string };

async function refreshProjectIndex(ctx: Ctx, project: IndexProject, askIn: AskIn): Promise<void> {
  const base = await baseRefFor(ctx, project.id);
  const heads = await indexHeads(ctx, project, base);
  if (!heads) return;
  memory(ctx.db).warned.delete(project.id);
  const at = indexStamp(heads);
  if (at && memory(ctx.db).at.get(project.id) === at) return;
  const result = await buildProjectIndex(ctx.db, project.id, heads, askIn);
  await recordIndexResult(ctx, project.id, at, result);
}

async function indexHeads(ctx: Ctx, project: IndexProject, base: string): Promise<Map<string, string> | null> {
  const scope = { project: project.id } as const;
  try {
    await createCheckout(ctx, scope, {
      remote: project.remote,
      branch: base.replace(/^origin\//, ""),
      base,
      projectId: project.id,
    });
    return await treeHeads(ctx, scope, HEAD_CHARS);
  } catch (error) {
    await warnIndexOnce(ctx, project.id, error);
    return null;
  }
}

async function warnIndexOnce(ctx: Ctx, projectId: number, error: unknown): Promise<void> {
  const warned = memory(ctx.db).warned;
  if (warned.has(projectId)) return;
  warned.add(projectId);
  await ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    say: msg`the index cannot be refreshed: this project's container will not start (${{ why: errText(error) }})`,
  });
}

function indexStamp(heads: Map<string, string>): string {
  return heads.size ? Bun.hash([...heads].map(([file, head]) => `${file}${head}`).join("\n")).toString(16) : "";
}

/**
 * Re-summarise what changed, once per tick, capped by `maxCalls`.
 *
 * The cap is the point: an index free to spend a hundred model calls in a tick
 * would be a worse version of the grepping it replaces. Twelve a tick on the
 * cheapest tier catches up over a few minutes and then costs nothing.
 */
async function buildProjectIndex(db: DB, projectId: number, heads: Map<string, string>, askIn: AskIn) {
  const excludes = await indexExcludes(db, projectId);
  const files = [...heads.keys()].filter((file) => indexable(file, excludes));
  const notes = await noteLeaves(db, projectId);
  const previous = (await loadTree(db, projectId)) ?? {};
  const result = await summarise(
    skeleton([...files, ...notes.ids]),
    (id) => (id.startsWith(NOTE_PREFIX) ? notes.read(id) : (heads.get(id) ?? null)),
    askIn({ project: projectId }),
    { previous, maxCalls: 12 },
  );
  await saveTree(db, projectId, result.tree);
  return { calls: result.calls, failed: result.failed, files: files.length };
}

/**
 * What an index pass is allowed to conclude from its own numbers.
 *
 * Three separate decisions the loop above cannot make: a pass that did real work
 * without failing marks the tree fresh, a pass where every call failed is the
 * model being down rather than the repository being broken, and a pass that made
 * no calls at all says nothing and must not clear the down flag.
 */
export async function recordIndexResult(
  ctx: Ctx,
  projectId: number,
  at: string,
  result: { calls: number; failed: number; files: number },
): Promise<void> {
  if (at && result.calls < 12 && result.failed === 0) memory(ctx.db).at.set(projectId, at);
  if (result.failed > 0 && result.failed === result.calls) return await warnModelDown(ctx, projectId, result.failed);
  if (!result.calls) return;
  memory(ctx.db).down.delete(projectId);
  // A pass that worked is the only evidence the throw path has recovered.
  memory(ctx.db).blockedUntil = 0;
  memory(ctx.db).lastError = "";
  await ctx.bus.emit({
    author: roleFor(ctx, "compress_context"),
    kind: "state_change",
    say: msg`PageIndex: summarised ${plural({ n: result.calls - result.failed }, { one: "# node", other: "# nodes" })}, ${plural({ files: result.files }, { one: "# file", other: "# files" })} indexed`,
  });
}

/**
 * Which project pays for an index model call.
 *
 * Charged to the project's `indexer` row, so the most frequent model call in the
 * system is not invisible in every cost total. A project-scoped call bills
 * itself, a group-scoped one bills the group's project; there is no util case,
 * because nothing in the utility container asks a model.
 */
export async function chargedProject(db: DB, scope: Scope): Promise<number | undefined> {
  if ("project" in scope) return scope.project;
  if (!("grp" in scope)) return undefined;
  // `?? undefined`, not the helper's `null`: the return says "no project" with
  // `undefined`, and `chargeIndex` is skipped on a falsy value either way.
  return (await projectOfGrp(db, scope.grp)) ?? undefined;
}

/**
 * Said once per credential state, and it stops the passes as well as the noise.
 *
 * Once *per state* rather than once ever: if the boss signs the index runtime in
 * and it still fails, that is news and not a repeat.
 */
async function warnModelDown(ctx: Ctx, projectId: number, failed: number): Promise<void> {
  const stamp = await authStamp(ctx.db);
  const down = memory(ctx.db).down;
  if (down.get(projectId) === stamp) return;
  down.set(projectId, stamp);
  await ctx.bus.emit({
    author: roleFor(ctx, "compress_context"),
    kind: "escalation",
    intent: "inform",
    severity: "blocker",
    say: msg`PageIndex cannot be built: all ${{ n: failed }} calls came back with nothing. Check in settings whether the account the index runs on still works.`,
  });
}

/**
 * A timer whose period is a setting the boss can change while the server runs.
 *
 * `setInterval` captures its period, so the callback checks its own and re-arms.
 * Written twice before this, and the second copy resolved the period once at
 * boot — so changing the interval moved the watchdog and left the readiness
 * check on its old clock until a restart.
 */
function reArming(periodOf: () => number, work: () => void): () => void {
  let armed = periodOf();
  let timer = setInterval(function beat() {
    if (periodOf() !== armed) {
      clearInterval(timer);
      armed = periodOf();
      timer = setInterval(beat, armed);
    }
    work();
  }, armed);
  return () => clearInterval(timer);
}

export async function start(overrides: Partial<Config> = {}, handle?: DB): Promise<Started> {
  // Overrides can put a relative dataDir back; the subprocesses cannot use one.
  const cfg = withAbsoluteDataDir({ ...loadConfig(), ...overrides });
  const missing = missingBinaries();
  if (missing.length) {
    throw new Error(
      `not on PATH: ${missing.join(", ")}. Install it first; nothing this process does would work without it.`,
    );
  }
  mkdirSync(cfg.dataDir, { recursive: true });

  // `ORCH_DATABASE_URL`, not a path under `dataDir`. The database is a PostgreSQL
  // server now and `open()` throws by name when the variable is unset, which is
  // the whole of the diagnosis. `dataDir` still holds turn logs, gate logs and
  // attachments, so it is still made, still owned by this account only — those
  // files are as readable as the credentials once were.
  // `handle` is how the smoke test boots the real server: `open()` needs a
  // connection string and a running PostgreSQL, and that suite's whole point is
  // that the process comes up — skipping it when a database is missing is a
  // green tick over the one test that starts the thing.
  const db = handle ?? (await open(cfg.dbPoolSize));
  try {
    chmodSync(cfg.dataDir, 0o700);
  } catch {}
  // The panel's settings, over the file's. Before anything reads `cfg`: the
  // scheduler, the watchdog timer and every handler share this one object.
  await applyOverrides(db, cfg);
  // After the overrides, because the address it binds to has to be the one this
  // run will actually use. A key stored before the address travelled with it is
  // given the address in effect now; from then on `sandboxKeyFor` refuses to
  // send it anywhere else.
  await bindSandboxKey(db, cfg.sandbox.server);

  // The thunk, not `cfg.language`: `applyOverrides` above and the settings pane
  // below both rewrite this object while the fleet runs, and the bus outlives
  // both. It renders the `body` column, which ADR 035 §3 keeps in output.language
  // for the readers that are not a browser.
  const bus = new Bus(db, () => cfg.language);
  const roles = loadRoles();
  // Before anything can dispatch. A capability no role declares reaches a job
  // payload as an undefined role and becomes a turn that never runs; a capability
  // two roles declare picks whichever `readdir` returned first. Both are silent at
  // the point they are decided, so they are decided here, by name, at boot.
  checkCapabilities(roles);

  // The executor needs the ctx that the scheduler lives in, so the scheduler is
  // created with a thunk that resolves once both exist.
  let exec: ReturnType<typeof makeExecutor> | null = null;
  const sched = new Scheduler(db, (job) => exec!(job), {
    // Thunks, not values: both are settings the boss can change while the fleet
    // runs, and the scheduler outlives the change.
    maxGroups: () => cfg.maxGroups,
    leaseSlots: () => cfg.leaseSlots,
    // The watchdog probes; this only reads the answer, so a tick never blocks a
    // dispatch decision on a DNS timeout.
    online: isOnline,
    // Same shape, different fact: docker or the sandbox server being down holds
    // every turn instead of failing each group once.
    sandboxReady: () => !sandboxHeld(),
    // Same shape a fifth time, and the first that is per project: one project's
    // revoked org access must not stop a project whose credential is fine.
    repoHeld: (projectId) => repoHeld(db, projectId),
  });

  const gh = makeGithub(db, undefined, cfg.language, cfg.timeouts.githubApiMs);
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gh,
    sandbox: REAL,
    // Cheapest tier: navigating a tree of one-line summaries is not a reasoning
    // job, and this runs on every `orch ctx query`.
    //
    // An empty model turns the walk off, and both callers already read `askIn`
    // being absent as "no navigator" — the query falls through to the lexical
    // half and the index stops rebuilding. That is the off switch the claim this
    // layer rests on has never been measured against: it is asserted to cost less
    // than the grep rounds it replaces, and nothing here could compare.
    ...(navigatorEnabled(cfg.indexModel)
      ? {
          askIn: (scope: Scope) =>
            modelAsk(ctx, cfg.indexModel, scope, undefined, (u) => {
              // Detached with its failure handled. `onUsage` is a synchronous
              // callback the summariser fires per call, and this is the most
              // frequent model call in the system — the charge must not be able
              // to fail silently, but it must not hold up the answer either.
              void chargedProject(db, scope)
                .then(async (projectId) => {
                  if (!projectId) return;
                  await chargeIndex(ctx, projectId, cfg.indexModel, u, "grp" in scope ? scope.grp : undefined);
                })
                .catch((e: unknown) => consola.warn(`index call went uncharged: ${errText(e)}`));
            }),
        }
      : {}),
    waiters: new Map(),
    // Built here because it outlives every request and has to be kept fresh,
    // which is state — and state gets one owner rather than a module reaching
    // for it. Construction is cheap; the index fills itself on first search.
    notes: makeNoteIndex(db),
    restoreWorkspace: (grpId) => restoreWorkspace(ctx, grpId),
    // One object, not a copy. See `Ctx` for what the copy used to cost.
    config: cfg,
    version: VERSION,
  };
  const execDeps = { ctx, cfg, roles };

  /**
   * Squash, push, open the PR. Called when the Scribe files the message for a
   * branch whose audit passed — or by the watchdog when no message ever arrives,
   * with whatever the record can say by itself.
   */
  ctx.publishBranch = (grpId: number) => {
    void publishBranch(grpId)
      // Detached, so anything the handler throws would surface against whoever is
      // running when it lands rather than against the PR that caused it.
      .catch((error: unknown) => consola.warn(`opening the PR for ${grpId} threw: ${errText(error)}`));
  };
  const publishBranch = async (grpId: number): Promise<void> => {
    const [group] = await db
      .select({ name: grp.name, repo_path: project.repo_path })
      .from(grp)
      .innerJoin(project, eq(project.id, grp.project_id))
      .where(eq(grp.id, grpId));
    await openPr({
      ctx,
      gh,
      grpId,
      title: await prTitle(ctx.db, grpId),
      body: await prBody(ctx.db, grpId),
    }).then(async (r) => {
      if ("error" in r) {
        // No remote, no gh auth, a rejected push: the branch has nowhere to go.
        // Leave the queue rather than block it — a group at PR_OPEN with a null
        // pr_number is one `pollPrs` skips forever, at the head of a serial
        // queue — and stop waiting on the boss. Answering un-pauses it and the
        // watchdog retries the PR, so there is no mechanism only for this.
        await hold(ctx.db, grpId, { reason: "merge", settled: true, leaveQueue: true });
        await raise(db, {
          grpId,
          lang: ctx.config.language,
          question: msg`The branch is finished but the PR will not open: ${{ why: r.error }}\n\nAnswer this once it is fixed and the group retries by itself.`,
          brief: msg`the PR will not open`,
          chain: "boss",
        });
        await ctx.bus.emit({
          grpId,
          author: "orchestrator",
          kind: "escalation",
          intent: "ask",
          severity: "blocker",
          say: msg`could not open a PR: ${{ why: r.error }}`,
        });
        void notifier.push({
          key: `pr-open:${grpId}`,
          tier: "immediate",
          body: renderSaid(
            ctx.config.language,
            msg`${{ name: group?.name ?? grpId }}: the PR will not open — ${{ why: r.error }}`,
          ).slice(0, 200),
          url,
        });
      }
    });
  };
  exec = makeExecutor(execDeps);
  ctx.knownRoles = () => [...roles.keys()];
  ctx.roles = roles;
  ctx.hire = async (grpId, role, projectId) => {
    if (!roles.has(role)) return null;
    return (await hire(execDeps, grpId, role, null, projectId ?? null)).id;
  };
  ctx.reviewVerdict = makeReviewVerdict(execDeps);
  ctx.auditVerdict = makeAuditVerdict(execDeps);

  // Composition installs the span processors, so no platform module opens a
  // socket or takes a database handle as an import side effect. Without a
  // configured endpoint only the SQLite processor is registered.
  configureTracing(db);
  const runtime = runtimeStatus(false);
  // What the readiness timer found, where the panel can reach it. A getter, so
  // the snapshot reads the current array rather than the one that existed at
  // wiring time — and a read, so it never triggers the checks themselves.
  ctx.checks = () => runtime.checks;
  const app = makeApp(ctx, runtime);
  const webDir = join(ROOT, "web");
  const background = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    background.add(work);
    void work.finally(() => background.delete(work)).catch(() => {});
    return work;
  };
  const drainBackground = async (): Promise<void> => {
    while (background.size > 0) await Promise.allSettled(background);
  };

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    idleTimeout: 0, // `ask-boss` holds a request open until the boss answers
    async fetch(req, bunServer) {
      const path = new URL(req.url).pathname;
      const route = routeRequest(path, () => bunServer.requestIP(req)?.address);
      if (route === "index") {
        return new Response(Bun.file(join(webDir, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": NO_CACHE },
        });
      }
      if (route === "app") return app(req);
      if (route === "refuse") return new Response("not found", { status: 404 });

      const file = Bun.file(join(webDir, path.replace(/^\/+/, "")));
      if (await file.exists()) return new Response(file, { headers: { "cache-control": NO_CACHE } });
      return new Response("not found", { status: 404 });
    },
  });

  // What it actually bound, not what it was asked for. `port: 0` means "any free
  // one" to `Bun.serve` and is refused by `ConfigSchema`, so leaving the zero in
  // the config made every endpoint that parses it answer 500 — the settings
  // dialog among them, which is the one `scripts/browse.ts` most needs to open.
  if (server.port) cfg.port = server.port;
  const url = `http://${cfg.host === "::1" ? "[::1]" : cfg.host}:${server.port}`;
  // Environment handed to every spawned turn: the URL plus the agent's own
  // token. Identity is never a request-body field.
  process.env.ORCH_URL = url;

  const notifier = new Notifier({
    deliver: busDeliver(bus, cfg.notifyWebhook, cfg.timeouts.webhookMs),
    batchMs: cfg.intervals.notifyBatchMs,
    backoffMs: cfg.intervals.notifyBackoffMs,
    // The one string the boss reads outside the panel, so it is the one that
    // cannot follow the panel's locale: `busDeliver` also POSTs it to a webhook,
    // where no browser is involved. ADR 035's test is whether anything but a
    // browser reads the string, and here something does.
    lang: cfg.language,
  });
  ctx.onFinding = (rule, severity, body, grpId) => {
    // The finding is already an event in the timeline. A notification on top of it
    // is a claim that the boss has to act, and most rules are the system reporting
    // that it handled something itself.
    if (!notifiable(rule, severity)) return;
    void notifier.push({ key: `${rule}:${grpId ?? 0}`, tier: tierFor(rule, severity), body, url });
  };
  ctx.notifyBoss = (escId, question, severity) => {
    // Detached with its failure handled: `notifyBoss` is called from handlers that
    // must not wait on a notification, and the group id only decides which page
    // the link opens — a lookup that fails still has something worth pushing.
    void db
      .select({ grp_id: escalation.grp_id })
      .from(escalation)
      .where(eq(escalation.id, escId))
      .then(([row]) =>
        notifier.push({
          key: `escalation:${escId}`,
          tier: tierFor("blocker", severity),
          body: question.slice(0, 300),
          url: row?.grp_id ? `${url}/#g=${row.grp_id}&v=progress` : url,
        }),
      )
      .catch((error: unknown) => consola.warn(`notifying the boss of ${escId} threw: ${errText(error)}`));
  };

  // Before the first tick: a turn that was in flight when the last server stopped
  // still holds its group's only slot, and that group would never move again.
  const orphans = await reclaimOrphans(db, { maxAgeMs: cfg.turnTimeoutMs * 4 });
  if (orphans.length > 0) {
    // Freeing the slot is not the same as resuming the work: the slice stays
    // `running`, so the group looks busy to `startNextSlice` and never moves again.
    const resumed = await resumeReclaimed(sched, orphans);
    await bus.emit({
      author: "orchestrator",
      kind: "state_change",
      say: msg`reclaimed ${plural({ n: orphans.length }, { one: "# turn", other: "# turns" })} left running by the previous server, resumed ${{ resumed }}`,
      meta: { orphans: orphans.length, resumed },
    });
  }

  // The watchdog is an ordinary job, enqueued on a timer. It bypasses the group
  // slot pool, or it could never fire on the very group that is stuck.
  const inFlight: InFlight = { index: null, poll: null };
  const stopHeartbeat = reArming(
    () => cfg.watchdogIntervalMs,
    () =>
      void track(heartbeat({ ctx, db, sched, gh, url, notifier, track, inFlight })).catch((e: unknown) =>
        consola.error(`heartbeat: ${errText(e)}`),
      ),
  );

  // The agents' only way out. Nothing in a sandbox can reach this process
  // directly, so their requests arrive as files and are replayed against these
  // same routes.
  const stopMailbox = startMailbox(ctx);

  // The directory every sandbox mounts read-only. Rebuilt here because the boss
  // installs and uninstalls skills outside this process; a tick box rebuilds it
  // again, and neither needs a container restarted.
  const skills = await restageSkills(db, cfg.skillsDir);
  if (skills.failed.length) consola.warn(`skills skipped (dangling): ${skills.failed.join(", ")}`);

  // A server, if there is not one, and never one it did not start (`ensureServer`).
  // Before preflight, so the check reports the state after we have done what we
  // can — otherwise the first boot on a clean machine prints a failure that fixed
  // itself two seconds later.
  const sandboxServer = track(
    ensureServer(ctx)
      .then(async (st) => await reportServerState(ctx, st))
      .catch((e: unknown) => consola.error(`ensureServer: ${errText(e)}`)),
  );

  // Find what is missing here, once, rather than letting every group discover it
  // one failed turn at a time. Not fatal: the panel can be opened and the
  // settings page is where three of these are fixed.
  //
  // Nothing is printed. A console line is written to a terminal the boss does not
  // watch, and re-written every tick for as long as the fault lasts; the same
  // finding now leaves through `ctx.checks` into the panel snapshot, which
  // notifies once per fault and can be dismissed.
  let readinessWork: Promise<void> | null = null;
  // Returns the work rather than starting it and walking away: `ctx.recheck`
  // needs to await the run that is already in flight, and a second one started
  // beside it would be the same host round trips twice.
  const refreshReadiness = (): Promise<void> => {
    if (readinessWork) return readinessWork;
    readinessWork = track(
      refreshRuntimeReadiness(runtime, () =>
        sandboxServer.then(() =>
          preflight({ db, sandbox: cfg.sandbox, skillsDir: cfg.skillsDir, cacheDirs: cfg.sandbox.cacheDirs, cfg }).then(
            async (checks) => {
              // A real round trip, not a handle that exists: `open()` migrated it
              // at boot, and what this reports is whether it still answers.
              await db.execute(sql`select 1`);
              return [makeCheck("database", true, msg`migrated and queryable`), ...checks];
            },
          ),
        ),
      ),
    ).finally(() => {
      readinessWork = null;
    });
    return readinessWork;
  };
  // The settings page's `/preflight` goes through here rather than running its
  // own: one owner for the answer, so the pane and the shell's banner cannot
  // disagree about whether the host is well.
  ctx.recheck = async () => {
    await refreshReadiness();
    return runtime.checks;
  };
  void refreshReadiness();
  // The second of the two timers reading `watchdogIntervalMs`; see `reArming`
  // for why neither may resolve it once at boot.
  // `void`, because `refreshReadiness` returns its work now for `ctx.recheck`
  // to await, and the timer is the caller that does not.
  const stopReadiness = reArming(
    () => readinessPeriodMs(cfg.watchdogIntervalMs),
    () => void refreshReadiness(),
  );

  await sched.tick();
  let stopped = false;
  const stopIntake = () => {
    if (stopped) return false;
    stopped = true;
    runtime.accepting = false;
    runtime.ready = false;
    sched.quiesce();
    stopHeartbeat();
    stopReadiness();
    stopMailbox();
    return true;
  };
  return {
    ctx,
    cfg,
    url,
    notifier,
    runtime,
    stop: () => {
      if (!stopIntake()) return;
      void server.stop(true);
    },
    shutdown: (deadlineMs) =>
      shutdownRuntime(
        {
          stopIntake,
          drain: async () => {
            await Promise.all([sched.drain(), drainBackground()]);
          },
          gracefulStop: async () => {
            await server.stop(false);
          },
          reclaim: async () => {
            await resumeReclaimed(sched, await reclaimOrphans(db, { maxAgeMs: 0 }));
          },
          abort: abortAll,
          forceStop: async () => {
            await server.stop(true);
          },
          close: () => {
            // No `db.close()`: `DB` is a Drizzle query interface and the pool
            // behind it belongs to `open()`. Shutting the pool down is that
            // module's to expose; nothing here holds a driver handle to close.
            closeTelemetry();
          },
          sleep: Bun.sleep,
        },
        deadlineMs,
      ),
  };
}

/**
 * Say what the yaml got wrong, here, before anything reads it.
 *
 * Only on a real boot: `start()` is also called by tests and by browse.ts with
 * overrides, and a config report from those is noise about a file they are not
 * using. Fatal findings stop the process — a port of 0 or a string where a
 * number belongs surfaces half an hour later as something that looks unrelated.
 */
function reportConfig(cfg: Config): void {
  const path = join(ROOT, "config/default.yaml");
  const { findings } = checkConfig(path);
  const all = [...findings, ...checkRoles(loadRoles(), Object.keys(cfg.difficultyModel))];
  for (const f of all) {
    const line = `${f.key} — ${f.says}`;
    if (f.level === "fatal") consola.error(line);
    else consola.warn(line);
  }
  if (all.some((f) => f.level === "fatal")) {
    consola.box("The config is wrong, so this will not start. Fix config/default.yaml and run it again.");
    process.exit(1);
  }
  consola.success(`config/default.yaml · ${changed(cfg)} settings differ from the defaults`);
}

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === "--version") {
    console.log(VERSION);
    process.exit(0);
  }
  configureStructuredLogging();
  reportConfig(loadConfig());
  const { ctx, url, shutdown } = await start();
  consola.info(`orchestrator on ${url}`);
  // The panel is served from `web/dist` and nothing rebuilds it, so a committed,
  // tested, typechecked UI change still shows the old page. Not rebuilt here on
  // purpose: in a worktree `web/dist` is a symlink to the main checkout's build.
  // Skipped where there is no `web/src` to compare against — an image ships the
  // built panel only, and a check that cannot run is not a failure.
  if (existsSync(join(ROOT, "web/src"))) {
    const dist = statSync(join(ROOT, "web/dist/main.js"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    const newest = readdirSync(join(ROOT, "web/src"), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .reduce((m, e) => Math.max(m, statSync(join(e.parentPath, e.name)).mtimeMs), 0);
    if (newest > dist)
      consola.warn("web/dist is older than web/src — run `bun run build:web`, or the page served is the old one");
  }

  // A detached rejection must not end the fleet: bun exits the process on one,
  // which is right for a script and wrong for the only thing driving twelve
  // containers. A backstop, not a licence — it is logged and recorded at
  // `blocker`, and the fix for each is at its source, because this line can only
  // say something went wrong, never what should have happened. Installed once.
  let saidRejection = "";
  process.on("unhandledRejection", (e) => {
    saidRejection = reportRejection(ctx.bus, e, saidRejection);
  });

  // Let go of every turn we are reading before exiting, so the next boot sees
  // them as orphans and requeues instead of leaving the group wedged behind a
  // job that nothing will ever finish. Only installed here: `start()` is called
  // many times per test run, and each would add a listener.
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown().then((code) => process.exit(code));
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, onSignal);
  }
}
