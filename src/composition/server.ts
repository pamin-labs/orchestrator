import { errText } from "../platform/process/text.ts";
import { existsSync, chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeApp } from "./api.ts";
import { landGroup } from "../api/panel/group.ts";
import type { Ctx } from "../mech/ctx.ts";
import { joinQueue } from "../mech/flow/mergequeue.ts";
import { Bus } from "../platform/persistence/event-bus.ts";
import { consola } from "consola";
import { loadConfig, loadRoles, ROOT, withAbsoluteDataDir, type Config } from "../platform/config/load.ts";
import { applyOverrides } from "../platform/config/settings.ts";
import { changed, checkConfig, checkRoles } from "../mech/ops/checkconfig.ts";
import { open } from "../platform/persistence/database.ts";
import { REAL, sandboxHeld, type Scope } from "../mech/sandbox/sandbox.ts";
import type { DB } from "../platform/persistence/database.ts";
import { startMailbox } from "../mech/sandbox/mailbox.ts";
import { baseRefFor, createCheckout, treeHeads } from "../mech/git/checkout.ts";
import { preflight, report, type Check } from "../mech/ops/preflight.ts";
import { restageSkills } from "../mech/skills.ts";
import { ensureServer } from "../mech/sandbox/server.ts";
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
import { raise } from "../mech/flow/escalate.ts";
import { restoreWorkspace } from "../mech/flow/start.ts";
import { closeTelemetry, runtimeStatus, type RuntimeStatus } from "../platform/observability/metrics.ts";
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
    runtime.checks = [{ name: "preflight", ok: false, detail: errText(error) }];
  }
}

/** Runs the two-phase process shutdown in an order tests can prove. */
export async function shutdownRuntime(
  ops: {
    stopIntake: () => boolean;
    drain: () => Promise<void>;
    gracefulStop: () => Promise<void>;
    reclaim: () => void;
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
    ops.reclaim();
    ops.abort();
    await ops.forceStop();
    await Promise.race([ops.drain(), ops.sleep(1_000)]);
  }
  ops.close();
  return graceful ? 0 : 1;
}

/**
 * Nothing. The host runs no binary of its own any more.
 *
 * It demanded `claude` until 005 (turns moved into containers) and `git` until
 * 007 step 6 (the checkout, the bundle and the push moved with them). What is
 * left on this machine is the server, sqlite and mailbox polling — so a
 * headless box with docker, the image and a pasted token starts, which is the
 * whole point of the decision. Kept as a function rather than deleted: it is
 * the one place to name a host binary if one is ever needed again, and the
 * caller already says the right thing when the list is not empty.
 */
export function missingBinaries(): string[] {
  return [];
}

/**
 * The panel is one localhost page for one person, and its bundle is `/dist/main.js`
 * with no hash in the name. Bun's file responses carry no etag and no
 * last-modified, so the browser heuristically cached the bundle and kept showing a
 * UI that had already been rebuilt — a deleted button stayed on screen through a
 * rebuild and a restart, and the PM ended up asking the boss to hard-refresh.
 *
 * `no-cache` is revalidate-every-time, not "never store". Over loopback that costs
 * nothing measurable.
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
 * One tick of the server's own work, separated from the timer that drives it.
 *
 * Only the re-arming stays in the callback, because that is about the timer
 * handle. Everything decided here — whether a watchdog is already queued, what
 * the boss is waiting on, whether the network is worth trying, and whether the
 * last index or poll has come back — used to be reachable only by starting the
 * process and waiting thirty seconds per branch.
 */
export function heartbeat({ ctx, db, sched, gh, url, notifier, track, inFlight }: HeartbeatDeps): void {
  // The watchdog is an ordinary job. One pending is enough: a second would only
  // re-examine the same groups, and the queue is not where it should pile up.
  const queued = db
    .query<{ c: number }, []>("SELECT count(*) AS c FROM job WHERE kind = 'watchdog' AND state = 'pending'")
    .get()!.c;
  if (queued === 0) sched.enqueue("watchdog", {});
  sched.tick();

  // Everything waiting on the boss, as one message. The CoS is meant to do this
  // in its own words; this is the backstop for when it does not run at all.
  const waiting = db
    .query<PendingItem, []>(
      `SELECT e.id, e.severity, e.question, e.grp_id AS grpId, g.name AS "group"
         FROM escalation e LEFT JOIN grp g ON g.id = e.grp_id
         WHERE e.chain_state = 'boss' AND e.answer IS NULL
         ORDER BY e.created_at`,
    )
    .all();
  const batched = batchForBoss(waiting, url);
  if (batched) void notifier.push(batched);

  // Both of these need the network — the index spawns a model, `pollPrs` asks
  // GitHub — so they sit behind the same gate the scheduler uses. Offline they
  // would each spend their timeout every thirty seconds and fill the feed with
  // failures the boss can do nothing about.
  if (!isOnline()) return;

  // Keep the PageIndex tree current. Incremental by file signature, so a quiet
  // repo costs zero model calls; a busy one pays for the files that changed.
  // `void` with no `.catch` sent every throw to the process backstop, which
  // emits a blocker — one per tick, forever, and `bus.emit` has no dedup.
  if (!inFlight.index) {
    inFlight.index = track(
      refreshIndex(ctx).catch((error: unknown) => {
        ctx.bus.emit({ author: "orchestrator", kind: "state_change", body: `索引刷新出错：${errText(error)}` });
      }),
    ).finally(() => {
      inFlight.index = null;
    });
  }

  // Polling is arithmetic, not judgement, so it happens here rather than in an
  // agent. Only a change wakes the PM.
  // The `.then` writes rows, enqueues turns and pushes notifications, so a group
  // dropped between the poll and the handler lands here as an unhandled
  // rejection — which is a process-wide blocker for one stale row.
  if (!inFlight.poll) {
    inFlight.poll = track(
      pollPrs(ctx, gh)
        .then((fs) => {
          for (const f of fs) applyPrOutcome(ctx, f, url, notifier);
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
 * What this catches is mostly the per-tick chains, so without the check a single
 * recurring bug is a blocker line every thirty seconds and the feed stops being
 * readable — worse than the bug it is reporting. The console keeps all of them.
 */
export function reportRejection(ctx: Ctx, e: unknown, said: string): string {
  const why = (e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 600);
  consola.error(`unhandled rejection (kept running):\n${why}`);
  if (why === said) return said;
  try {
    ctx.bus.emit({
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body: `有个后台任务崩了，服务没跟着退出。这是个 bug，请把这段贴给开发：\n${why.slice(0, 400)}`,
    });
  } catch {
    // The record is the thing that failed. The console line above is the report.
  }
  return why;
}

/**
 * What one poll result means for the group behind it.
 *
 * Four outcomes and they are not interchangeable: a merge lands the group, a
 * close stops it and asks the boss, a reopen puts it back, and anything else is
 * review feedback for the agents. Ordering matters — a PR can come back merged
 * and closed in the same poll, and treating that as a close would stop a group
 * whose work is already on the default branch.
 */
export function applyPrOutcome(ctx: Ctx, f: Feedback, url: string, notifier: Notifier): void {
  if (f.merged) {
    landGroup(ctx, f.grpId, "github");
    return;
  }
  if (f.closed) return prClosed(ctx, f.grpId, f.prNumber, url, notifier);
  if (f.reopened) return prReopened(ctx, f.grpId, f.prNumber);
  dispatchFeedback(ctx, f);
}

/**
 * The boss closed the PR on GitHub.
 *
 * Closing is a decision — "not like this" — and it can only be made there, so the
 * system has to read it from there. It leaves the merge queue rather than blocking
 * it (the queue is strictly serial; a group that will never merge at its head stops
 * every group behind it), and stops as a group waiting on the boss, with the two
 * exits stated: reopen the PR, or 不做了.
 *
 * Nothing here reopens it automatically. The close was deliberate, and undoing a
 * deliberate act because a poller disagreed with it is the worst kind of helpful.
 */
function prClosed(ctx: Ctx, grpId: number, prNumber: number, url: string, notifier: Notifier): void {
  const g = ctx.db.query<{ name: string }, [number]>("SELECT name FROM grp WHERE id = ?").get(grpId);
  hold(ctx, grpId, { reason: "merge", settled: true, from: "PR_OPEN", leaveQueue: true });
  raise(ctx.db, {
    grpId,
    brief: "PR 被关掉了，要不要重开",
    chain: "boss",
    question:
      `PR #${prNumber} 被关掉了（没有合入）。这一组已经停下并让出了合入队列。\n` +
      `要继续：在 GitHub 上重开这个 PR，它会自己回到队列。不想要了：在这个需求上点「不做了」。`,
  });
  ctx.bus.emit({
    grpId,
    author: "pr-watcher",
    kind: "escalation",
    intent: "ask",
    severity: "blocker",
    body: `PR #${prNumber} was closed without merging`,
    meta: { pr: prNumber },
  });
  void notifier.push({
    key: `pr-closed:${grpId}:${prNumber}`,
    tier: "immediate",
    body: `${g?.name ?? grpId}: PR #${prNumber} 被关了 — 重开或不做了`,
    url: `${url}/#g=${grpId}&v=progress`,
  });
}

/** Reopened on GitHub: back into the queue, and the question that asked is answered. */
function prReopened(ctx: Ctx, grpId: number, prNumber: number): void {
  ctx.db.run(
    "UPDATE grp SET status = 'PR_OPEN', paused_at = NULL, pause_reason = NULL WHERE id = ? AND status = 'PAUSED'",
    [grpId],
  );
  const prefix = `PR #${prNumber} 被关掉了`;
  ctx.db.run(
    `UPDATE escalation SET chain_state = 'answered', answered_by = 'github', answer = 'reopened'
     WHERE grp_id = ? AND answer IS NULL AND substr(question, 1, length(?)) = ?`,
    [grpId, prefix, prefix],
  );
  joinQueue(ctx.db, grpId);
  ctx.bus.emit({
    grpId,
    author: "pr-watcher",
    kind: "state_change",
    body: `PR #${prNumber} was reopened; back in the merge queue`,
    meta: { pr: prNumber },
  });
  ctx.sched.tick();
}

/**
 * Re-summarise what changed, once per tick, capped.
 *
 * The cap is the point: an index that could spend a hundred model calls in one
 * tick would be a worse version of the grepping it replaces. Twelve calls a tick
 * on the cheapest tier catches up over a few minutes and then costs nothing.
 */
const indexedAt = new Map<number, string>();

/** Projects already warned about index or model failure; said once, not per tick. */
const indexWarned = new Set<number>();
const indexModelDown = new Set<number>();

async function refreshIndex(ctx: Ctx): Promise<void> {
  const askIn = ctx.askIn;
  if (!askIn) return;
  const projects = ctx.db.query<{ id: number; remote: string | null }, []>("SELECT id, remote FROM project").all();
  for (const project of projects) {
    if (project.remote) await refreshProjectIndex(ctx, { id: project.id, remote: project.remote }, askIn);
  }
}

type AskIn = NonNullable<Ctx["askIn"]>;
type IndexProject = { id: number; remote: string };

async function refreshProjectIndex(ctx: Ctx, project: IndexProject, askIn: AskIn): Promise<void> {
  const base = await baseRefFor(ctx, project.id);
  const heads = await indexHeads(ctx, project, base);
  if (!heads) return;
  indexWarned.delete(project.id);
  const at = indexStamp(heads);
  if (at && indexedAt.get(project.id) === at) return;
  const result = await buildProjectIndex(ctx, project.id, heads, askIn);
  recordIndexResult(ctx, project.id, at, result);
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
    warnIndexOnce(ctx, project.id, error);
    return null;
  }
}

function warnIndexOnce(ctx: Ctx, projectId: number, error: unknown): void {
  if (indexWarned.has(projectId)) return;
  indexWarned.add(projectId);
  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body: `索引刷不了：这个项目的容器起不来（${errText(error)}）。`,
  });
}

function indexStamp(heads: Map<string, string>): string {
  return heads.size ? Bun.hash([...heads].map(([file, head]) => `${file}${head}`).join("\n")).toString(16) : "";
}

async function buildProjectIndex(ctx: Ctx, projectId: number, heads: Map<string, string>, askIn: AskIn) {
  const excludes = indexExcludes(ctx.db, projectId);
  const files = [...heads.keys()].filter((file) => indexable(file, excludes));
  const notes = noteLeaves(ctx.db, projectId);
  const result = await summarise(
    skeleton([...files, ...notes.ids]),
    (id) => (id.startsWith(NOTE_PREFIX) ? notes.read(id) : (heads.get(id) ?? null)),
    askIn({ project: projectId }),
    { previous: loadTree(ctx.db, projectId) ?? {}, maxCalls: 12 },
  );
  saveTree(ctx.db, projectId, result.tree);
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
export function recordIndexResult(
  ctx: Ctx,
  projectId: number,
  at: string,
  result: { calls: number; failed: number; files: number },
): void {
  if (at && result.calls < 12 && result.failed === 0) indexedAt.set(projectId, at);
  if (result.failed > 0 && result.failed === result.calls) return warnModelDownOnce(ctx, projectId, result.failed);
  if (!result.calls) return;
  indexModelDown.delete(projectId);
  ctx.bus.emit({
    author: "librarian",
    kind: "state_change",
    body: `PageIndex: summarised ${result.calls - result.failed} node(s), ${result.files} files indexed`,
  });
}

/**
 * Which project pays for an index model call.
 *
 * Charged to the project's `indexer` row, so the most frequent model call in the
 * system stops being invisible in every cost total. A project-scoped call bills
 * itself; a group-scoped one bills the group's project. There is no util case:
 * nothing in the utility container asks a model — it has no agent in it, which
 * is the entire reason it may hold real tokens.
 */
export function chargedProject(db: DB, scope: Scope): number | undefined {
  if ("project" in scope) return scope.project;
  if (!("grp" in scope)) return undefined;
  return db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(scope.grp)
    ?.project_id;
}

function warnModelDownOnce(ctx: Ctx, projectId: number, failed: number): void {
  if (indexModelDown.has(projectId)) return;
  indexModelDown.add(projectId);
  ctx.bus.emit({
    author: "librarian",
    kind: "escalation",
    intent: "inform",
    severity: "blocker",
    body: `PageIndex 建不起来：${failed} 次调用全部没有返回。去设置页看看索引用的那个账号还能不能用。`,
  });
}

export function start(overrides: Partial<Config> = {}): Started {
  // Overrides can put a relative dataDir back; the subprocesses cannot use one.
  const cfg = withAbsoluteDataDir({ ...loadConfig(), ...overrides });
  const missing = missingBinaries();
  if (missing.length) {
    throw new Error(
      `not on PATH: ${missing.join(", ")}. The host runs git itself — the branch goes out ` +
        `as a bundle and the PR is pushed from here — so nothing would work. Install it first.`,
    );
  }
  mkdirSync(cfg.dataDir, { recursive: true });

  const dbPath = join(cfg.dataDir, "orchestrator.sqlite");
  const db = open(dbPath);
  // The provider tokens are in `runtime_auth`, in plain text, and this file was
  // created 0644 under a 0755 directory — readable by every account on the
  // machine. `.gitignore` keeps it out of the repository, which is a different
  // question from who on this host may read it.
  //
  // Best-effort: chmod is a no-op for permission bits on Windows, and a file on a
  // filesystem that does not carry modes is not a reason to refuse to start.
  for (const p of [cfg.dataDir, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      chmodSync(p, p === cfg.dataDir ? 0o700 : 0o600);
    } catch {}
  }
  // The panel's settings, over the file's. Before anything reads `cfg`: the
  // scheduler, the watchdog timer and every handler share this one object.
  applyOverrides(db, cfg);

  const bus = new Bus(db);
  const roles = loadRoles();

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

  const gh = makeGithub(db, undefined, cfg.language);
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gh,
    sandbox: REAL,
    // Cheapest tier: navigating a tree of one-line summaries is not a reasoning
    // job, and this runs on every `orch ctx query`.
    // Charged to the project's `indexer` row, so the most frequent model call in
    // the system stops being invisible in every cost total. Group-scoped calls
    // bill the group's project; a project-scoped one bills itself.
    askIn: (scope) =>
      modelAsk(ctx, cfg.indexModel, scope, undefined, (u) => {
        const projectId = chargedProject(db, scope);
        if (projectId) chargeIndex(ctx, projectId, cfg.indexModel, u);
      }),
    waiters: new Map(),
    restoreWorkspace: (grpId) => restoreWorkspace(ctx, grpId),
    // One object, not a copy. See `Ctx` for what the copy used to cost.
    config: cfg,
  };
  const execDeps = { ctx, cfg, roles };

  /**
   * Squash, push, open the PR. Called when the Scribe files the message for a
   * branch whose audit passed — or by the watchdog when no message ever arrives,
   * with whatever the record can say by itself.
   */
  ctx.publishBranch = (grpId: number) => {
    const grp = db
      .query<{ name: string; repo_path: string }, [number]>(
        "SELECT g.name, p.repo_path FROM grp g JOIN project p ON p.id = g.project_id WHERE g.id = ?",
      )
      .get(grpId);
    void openPr({
      ctx,
      gh,
      grpId,
      title: prTitle(ctx.db, grpId),
      body: prBody(ctx.db, grpId),
    })
      .then((r) => {
        if ("error" in r) {
          // No remote, no gh auth, a rejected push: the branch is finished and has
          // nowhere to go. This used to be an event and nothing else — not a row in
          // `escalation`, so it never reached 待办 — while the group sat at PR_OPEN
          // holding the head of a strictly serial merge queue with a null
          // pr_number, which pollPrs skips forever. Everything behind it stopped,
          // and the only trace was one line in the feed.
          //
          // So: leave the queue rather than block it, and stop as a group that is
          // waiting on the boss. Answering the blocker un-pauses it, the watchdog
          // finds a live group with an empty queue and re-queues its last turn —
          // the Auditor's — which passes again and retries the PR. No new
          // mechanism, and no button that only exists for this.
          hold(ctx, grpId, { reason: "merge", settled: true, leaveQueue: true });
          raise(db, {
            grpId,
            question: `分支做完了但 PR 开不出来：${r.error}\n\n修好之后回答这条，这一组会自己重试。`,
            brief: "PR 开不出来",
            chain: "boss",
          });
          ctx.bus.emit({
            grpId,
            author: "orchestrator",
            kind: "escalation",
            intent: "ask",
            severity: "blocker",
            body: `could not open a PR: ${r.error}`,
          });
          void notifier.push({
            key: `pr-open:${grpId}`,
            tier: "immediate",
            body: `${grp?.name ?? grpId}: PR 开不出来 — ${r.error}`.slice(0, 200),
            url,
          });
        }
      })
      // Detached, and its handler writes rows and pushes notifications, so
      // anything it throws surfaces against whoever is running when it lands
      // rather than against the PR that caused it. The careful PAUSED path
      // above is the answer to a *failed* PR; this is the answer to a failure
      // while answering one.
      .catch((error: unknown) => consola.warn(`opening the PR for ${grpId} threw: ${errText(error)}`));
  };
  exec = makeExecutor(execDeps);
  ctx.knownRoles = () => [...roles.keys()];
  ctx.hire = (grpId, role, projectId) => {
    if (!roles.has(role)) return null;
    return hire(execDeps, grpId, role, null, projectId ?? null).id;
  };
  ctx.reviewVerdict = makeReviewVerdict(execDeps);
  ctx.auditVerdict = makeAuditVerdict(execDeps);

  const runtime = runtimeStatus(false);
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
    // See NO_CACHE: /dist/main.js has no hash in its name and Bun sends no
    // validators, so a rebuilt bundle kept being served from the browser's cache.

    idleTimeout: 0, // `ask-boss` holds a request open until the boss answers
    async fetch(req, bunServer) {
      const path = new URL(req.url).pathname;
      if (INDEX_PATHS.has(path)) {
        return new Response(Bun.file(join(webDir, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": NO_CACHE },
        });
      }
      if (path === "/metrics") {
        const ip = bunServer.requestIP(req)?.address;
        if (ip && !LOOPBACK_ADDRESSES.has(ip)) {
          return new Response("not found", { status: 404 });
        }
        return app(req);
      }
      if (isApplicationPath(path)) {
        return app(req);
      }

      const file = Bun.file(join(webDir, path.replace(/^\/+/, "")));
      if (await file.exists()) return new Response(file, { headers: { "cache-control": NO_CACHE } });
      return new Response("not found", { status: 404 });
    },
  });

  const url = `http://${cfg.host === "::1" ? "[::1]" : cfg.host}:${server.port}`;
  // Environment handed to every spawned turn: the URL plus the agent's own
  // token. Identity is never a request-body field.
  process.env.ORCH_URL = url;

  const notifier = new Notifier({ deliver: busDeliver(bus, cfg.notifyWebhook) });
  ctx.onFinding = (rule, severity, body, grpId) => {
    // The finding is already an event in the timeline. A notification on top of it
    // is a claim that the boss has to act, and most rules are the system reporting
    // that it handled something itself.
    if (!notifiable(rule, severity)) return;
    void notifier.push({ key: `${rule}:${grpId ?? 0}`, tier: tierFor(rule, severity), body, url });
  };
  ctx.notifyBoss = (escId, question, severity) => {
    const g = db
      .query<{ grp_id: number | null }, [number]>("SELECT grp_id FROM escalation WHERE id = ?")
      .get(escId)?.grp_id;
    void notifier.push({
      key: `escalation:${escId}`,
      tier: tierFor("blocker", severity),
      body: question.slice(0, 300),
      url: g ? `${url}/#g=${g}&v=progress` : url,
    });
  };

  // Before the first tick: a turn that was in flight when the last server stopped
  // still holds its group's only slot, and that group would never move again.
  const orphans = reclaimOrphans(db, { maxAgeMs: cfg.turnTimeoutMs * 4 });
  if (orphans.length > 0) {
    // Freeing the slot is not the same as resuming the work: the slice stays
    // `running`, so the group looks busy to `startNextSlice` and never moves again.
    const resumed = resumeReclaimed(sched, orphans);
    bus.emit({
      author: "orchestrator",
      kind: "state_change",
      body: `reclaimed ${orphans.length} turn(s) left running by the previous server, resumed ${resumed}`,
      meta: { orphans: orphans.length, resumed },
    });
  }

  // The watchdog is an ordinary job, enqueued on a timer. It bypasses the group
  // slot pool, or it could never fire on the very group that is stuck.
  // The period is a setting, and `setInterval` captures it. Rather than juggle a
  // timer handle from the settings route, the callback notices its own period
  // changed and re-arms — one place, and it cannot be forgotten by a new writer.
  let armed = cfg.watchdogIntervalMs;
  const inFlight: InFlight = { index: null, poll: null };
  let tick = setInterval(function beat() {
    if (cfg.watchdogIntervalMs !== armed) {
      clearInterval(tick);
      armed = cfg.watchdogIntervalMs;
      tick = setInterval(beat, armed);
    }
    heartbeat({ ctx, db, sched, gh, url, notifier, track, inFlight });
  }, armed);

  // The agents' only way out. Nothing in a sandbox can reach this process
  // directly, so their requests arrive as files and are replayed against these
  // same routes.
  const stopMailbox = startMailbox(ctx);

  // The directory every sandbox mounts read-only. Rebuilt here because the boss
  // installs and uninstalls skills outside this process; a tick box rebuilds it
  // again, and neither needs a container restarted.
  const skills = restageSkills(db, cfg.skillsDir);
  if (skills.failed.length) consola.warn(`skills skipped (dangling): ${skills.failed.join(", ")}`);

  // A server, if there is not one. Before preflight, so the check reports the
  // state after we have done what we can rather than the state we walked in on
  // — otherwise the first boot on a clean machine always prints a failure that
  // fixed itself two seconds later.
  //
  // It never takes over a server it did not start. See `ensureServer`.
  const sandboxServer = track(
    ensureServer(ctx)
      .then((st) => {
        if (st.kind === "started") {
          consola.success(`opensandbox-server started (pid ${st.pid}, ${st.config})`);
          ctx.bus.emit({
            author: "orchestrator",
            kind: "state_change",
            body: `沙盒服务器起好了（我们起的，pid ${st.pid}）`,
          });
        } else if (st.kind === "theirs") {
          consola.info(`opensandbox-server already running (pid ${st.pid}) — using it, not touching it`);
        } else if (st.kind === "stuck") {
          consola.warn(`opensandbox-server running (pid ${st.pid}) but not drivable: ${st.why}`);
          ctx.bus.emit({
            author: "orchestrator",
            kind: "escalation",
            intent: "inform",
            severity: "blocker",
            // Never restarted for them: this process may be someone else's, and
            // "we cannot drive it" is not evidence that nobody can.
            body:
              `沙盒服务器在跑（pid ${st.pid}），但我们驱动不了：${st.why}\n` +
              `没敢自动重启它 —— 这个进程可能是你自己起的，配的是别的东西。设置 → 沙盒服务器 那里有按钮。`,
          });
        } else if (st.kind === "down") {
          consola.warn(`opensandbox-server: ${st.why}`);
        }
      })
      .catch((e: unknown) => consola.error(`ensureServer: ${errText(e)}`)),
  );

  // Say what is missing here, once, rather than letting every group discover it
  // one failed turn at a time. Not fatal: the panel can be opened and the
  // settings page is where three of these are fixed.
  let readinessWork: Promise<void> | null = null;
  const refreshReadiness = () => {
    if (readinessWork) return;
    readinessWork = track(
      refreshRuntimeReadiness(runtime, () =>
        sandboxServer.then(() =>
          preflight({ db, sandbox: cfg.sandbox, skillsDir: cfg.skillsDir, cacheDirs: cfg.sandbox.cacheDirs }).then(
            (checks) => {
              db.query<{ ok: number }, []>("SELECT 1 AS ok").get();
              return [{ name: "database", ok: true, detail: "migrated and queryable" }, ...checks];
            },
          ),
        ),
      ).then(() => {
        const bad = report([...runtime.checks]);
        if (bad) consola.warn(`preflight:\n${bad}`);
      }),
    ).finally(() => {
      readinessWork = null;
    });
  };
  refreshReadiness();
  const readinessTick = setInterval(refreshReadiness, Math.min(Math.max(cfg.watchdogIntervalMs, 5_000), 30_000));

  sched.tick();
  let stopped = false;
  const stopIntake = () => {
    if (stopped) return false;
    stopped = true;
    runtime.accepting = false;
    runtime.ready = false;
    sched.quiesce();
    clearInterval(tick);
    clearInterval(readinessTick);
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
          reclaim: () => resumeReclaimed(sched, reclaimOrphans(db, { maxAgeMs: 0 })),
          abort: abortAll,
          forceStop: async () => {
            await server.stop(true);
          },
          close: () => {
            closeTelemetry();
            db.close();
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
    consola.box("配置有问题，起不来。改完 config/default.yaml 再跑一次。");
    process.exit(1);
  }
  consola.success(`配置 config/default.yaml · ${changed(cfg)} 项改过默认值`);
}

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === "--version") {
    console.log(VERSION);
    process.exit(0);
  }
  configureStructuredLogging();
  reportConfig(loadConfig());
  const { ctx, url, shutdown } = start();
  consola.info(`orchestrator on ${url}`);
  // The panel is served from `web/dist`, and nothing rebuilds it. A UI change that
  // is committed, tested and typechecked still shows the old page, which reads as
  // "the fix did not work" — measured, on a button that had already been deleted.
  // Not rebuilt here on purpose: in a worktree `web/dist` is a symlink to the main
  // checkout's build, so building would overwrite somebody else's bundle.
  // Skipped where there is no source to compare against — an image ships the
  // built panel and no `web/src`, and this crashed the container on boot rather
  // than reporting anything. A check that cannot run is not a failure.
  if (existsSync(join(ROOT, "web/src"))) {
    const dist = statSync(join(ROOT, "web/dist/main.js"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    const newest = readdirSync(join(ROOT, "web/src"), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .reduce((m, e) => Math.max(m, statSync(join(e.parentPath, e.name)).mtimeMs), 0);
    if (newest > dist) consola.warn("web/dist 比 web/src 旧 —— 跑一次 `bun run build:web`，不然页面是旧的");
  }

  // A detached rejection must not be the end of the fleet.
  //
  // bun exits the process on an unhandled rejection, which is right for a script
  // and wrong for a server that is the only thing driving twelve containers.
  // Observed: one `ECONNRESET` on a container's `files/upload` — a socket on this
  // same machine — and every group stopped, mid-turn, with a two-line error and
  // no stack.
  //
  // This is a backstop and not a licence. An unhandled rejection is still a bug:
  // something detached failed and nobody was told, so it is logged and put on the
  // record at `blocker` where the boss's own feed shows it. The fix for each one
  // is still at its source — `writeInto` retries the upload, `Scheduler.start`
  // and `acceptSlice` catch their own chains — because this line can only say
  // that something went wrong, never what should have happened instead.
  //
  // Installed once, here, for the same reason as the signal handlers below.
  let saidRejection = "";
  process.on("unhandledRejection", (e) => {
    saidRejection = reportRejection(ctx, e, saidRejection);
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
