import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { landGroup, makeApp, type Ctx } from "./api.ts";
import { joinQueue } from "./mech/mergequeue.ts";
import { Bus } from "./bus.ts";
import { consola } from "consola";
import { loadConfig, loadRoles, ROOT, withAbsoluteDataDir, type Config } from "./config.ts";
import { changed, checkConfig, checkRoles } from "./mech/checkconfig.ts";
import { open } from "./db.ts";
import { RepoLock } from "./mech/gitlock.ts";
import { makeGitRunner } from "./mech/worktree.ts";
import { REAL } from "./mech/sandbox.ts";
import { startMailbox } from "./mech/mailbox.ts";
import { preflight, report } from "./mech/preflight.ts";
import { restageSkills } from "./mech/skills.ts";
import { batchForBoss, notifiable, Notifier, tierFor, type PendingItem } from "./mech/notify.ts";
import { dispatchFeedback, makeGhRunner, openPr, pollPrs, prBody } from "./mech/prwatch.ts";
import { bothRead, modelAsk, noteLeaves, saveTree, skeleton, summarise, loadTree } from "./mech/pageindex.ts";
import { hire, makeAuditVerdict, makeExecutor, makeReviewVerdict } from "./runtime/executor.ts";
import { reclaimOrphans, resumeReclaimed, Scheduler } from "./scheduler.ts";
import { abortAll } from "./runtime/running.ts";

/**
 * Wires the pieces together and serves them.
 *
 * One process: HTTP + SSE for the web UI, the same routes for `orch`, the job
 * queue, and the sandboxes it drives. Bound to 127.0.0.1: nothing outside this
 * machine needs it, and agents reach it through the mailbox rather than the
 * network (docs/decisions/005).
 */

export interface Started {
  ctx: Ctx;
  cfg: Config;
  url: string;
  notifier: Notifier;
  stop: () => void;
}

/**
 * Binaries without which nothing works, checked once instead of discovered per
 * turn. `Bun.spawn` throws on a missing executable, so a missing `claude` would
 * otherwise fail every job one at a time with the same error and no summary.
 * `gh` is deliberately not here — PR preflight reports that per project.
 */
export function missingBinaries(): string[] {
  return ["git", "claude"].filter((bin) => {
    try {
      Bun.spawnSync([bin, "--version"], { stdout: "ignore", stderr: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
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
  ctx.db.run(
    `UPDATE grp SET status = 'PAUSED', paused_at = unixepoch() * 1000, merge_seq = NULL, merge_seq_at = NULL
     WHERE id = ? AND status = 'PR_OPEN'`,
    [grpId],
  );
  ctx.db.run(
    `INSERT INTO escalation (grp_id, severity, question, brief, chain_state, created_at)
     VALUES (?, 'blocker', ?, 'PR 被关掉了，要不要重开', 'boss', unixepoch() * 1000)`,
    [
      grpId,
      `PR #${prNumber} 被关掉了（没有合入）。这一组已经停下并让出了合入队列。\n` +
        `要继续：在 GitHub 上重开这个 PR，它会自己回到队列。不想要了：在这个需求上点「不做了」。`,
    ],
  );
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
    "UPDATE grp SET status = 'PR_OPEN', paused_at = NULL WHERE id = ? AND status = 'PAUSED'",
    [grpId],
  );
  ctx.db.run(
    `UPDATE escalation SET chain_state = 'answered', answered_by = 'github', answer = 'reopened'
     WHERE grp_id = ? AND answer IS NULL AND question LIKE ?`,
    [grpId, `PR #${prNumber} 被关掉了%`],
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

async function refreshIndex(ctx: Ctx, _workRoot: string): Promise<void> {
  if (!ctx.git || !ctx.ask) return;
  for (const p of ctx.db
    .query<{ id: number; repo_path: string }, []>("SELECT id, repo_path FROM project")
    .all()) {
    // Nothing to do when the repo has not moved. Without this the tick still read
    // the head of every tracked file to compute signatures — no model calls, but
    // 125 file reads every thirty seconds to prove nothing changed.
    const head = await ctx.git(p.repo_path, ["rev-parse", "HEAD"], p.repo_path);
    const at = head.code === 0 ? head.out.trim() : "";
    if (at && indexedAt.get(p.id) === at) continue;

    const ls = await ctx.git(p.repo_path, ["ls-files"], p.repo_path);
    if (ls.code !== 0) continue;
    const files = ls.out.split("\n").map((l) => l.trim()).filter((f) => /\.(ts|tsx|js|jsx|md|yaml|yml)$/.test(f));
    // One tree over both corpora: the repo answers "where is the code" and the
    // blackboard answers "what did we already decide about it", and an agent
    // asking either question should not have to know which one it is asking.
    const notes = noteLeaves(ctx.db, p.id);
    const { tree, calls } = await summarise(skeleton([...files, ...notes.ids]), bothRead(p.repo_path, notes.read), ctx.ask, {
      previous: loadTree(ctx.db, p.id) ?? {},
      maxCalls: 12,
    });
    saveTree(ctx.db, p.id, tree);
    // Only when the budget was not spent: a partial pass has more to do, and
    // marking it done would leave the tail of the repo unsummarised until the next
    // commit.
    if (at && calls < 12) indexedAt.set(p.id, at);
    if (calls > 0) {
      ctx.bus.emit({
        author: "librarian",
        kind: "state_change",
        body: `PageIndex: summarised ${calls} node(s), ${files.length} files indexed`,
      });
    }
  }
}

export function start(overrides: Partial<Config> = {}): Started {
  // Overrides can put a relative dataDir back; the subprocesses cannot use one.
  const cfg = withAbsoluteDataDir({ ...loadConfig(), ...overrides });
  const missing = missingBinaries();
  if (missing.length) {
    throw new Error(
      `not on PATH: ${missing.join(", ")}. Every agent turn would fail with the same error, ` +
        `one job at a time. Install them first.`,
    );
  }
  mkdirSync(cfg.dataDir, { recursive: true });

  const db = open(join(cfg.dataDir, "orchestrator.sqlite"));
  const bus = new Bus(db);
  const gitLock = new RepoLock();
  const roles = loadRoles();

  // The executor needs the ctx that the scheduler lives in, so the scheduler is
  // created with a thunk that resolves once both exist.
  let exec: ReturnType<typeof makeExecutor> | null = null;
  const sched = new Scheduler(db, (job) => exec!(job), {
    maxGroups: cfg.maxGroups,
    leaseSlots: cfg.leaseSlots,
  });

  const git = makeGitRunner(gitLock);
  const gh = makeGhRunner();
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gitLock,
    git,
    gh,
    sandbox: REAL,
    // Cheapest tier: navigating a tree of one-line summaries is not a reasoning
    // job, and this runs on every `orch ctx query`.
    ask: modelAsk(cfg.indexModel, ROOT),
    waiters: new Map(),
    config: {
      language: cfg.language,
      workRoot: cfg.workRoot,
      sliceBudgetTokens: cfg.sliceBudgetTokens,
      dataDir: cfg.dataDir,
      skillsDir: cfg.skillsDir,
      autoAdvance: cfg.autoAdvance,
      autoAcceptTiers: cfg.autoAcceptTiers,
      maxGroups: cfg.maxGroups,
      leaseSlots: cfg.leaseSlots,
      feedbackSediment: cfg.feedbackSedimentThreshold,
      port: cfg.port,
      sandbox: cfg.sandbox,
      installTimeoutMs: cfg.installTimeoutMs,
      ctxBudgetChars: cfg.ctxBudgetChars,
    },
  };
  const execDeps = {
    ctx,
    cfg,
    roles,
    git,
    onAuditPass: (grpId: number) => {
      const grp = db
        .query<{ name: string; repo_path: string }, [number]>(
          "SELECT g.name, p.repo_path FROM grp g JOIN project p ON p.id = g.project_id WHERE g.id = ?",
        )
        .get(grpId);
      void openPr({
        ctx,
        gh,
        git,
        repo: grp?.repo_path ?? "",
        grpId,
        title: `orch: ${grp?.name ?? "changes"}`,
        body: prBody(ctx, grpId),
      }).then((r) => {
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
          db.run("UPDATE grp SET merge_seq = NULL, merge_seq_at = NULL, status = 'PAUSED', paused_at = unixepoch() * 1000 WHERE id = ?", [grpId]);
          db.run(
            `INSERT INTO escalation (grp_id, severity, question, brief, chain_state, created_at)
             VALUES (?, 'blocker', ?, 'PR 开不出来', 'boss', unixepoch() * 1000)`,
            [grpId, `分支做完了但 PR 开不出来：${r.error}\n\n修好之后回答这条，这一组会自己重试。`],
          );
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
      });
    },
  };
  exec = makeExecutor(execDeps);
  ctx.knownRoles = () => [...roles.keys()];
  ctx.hire = (grpId, role, projectId) => {
    if (!roles.has(role)) return null;
    return hire(execDeps, grpId, role, null, projectId ?? null).id;
  };
  ctx.reviewVerdict = makeReviewVerdict(execDeps);
  ctx.auditVerdict = makeAuditVerdict(execDeps);


  const app = makeApp(ctx);
  const webDir = join(ROOT, "web");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    // See NO_CACHE: /dist/main.js has no hash in its name and Bun sends no
    // validators, so a rebuilt bundle kept being served from the browser's cache.

    idleTimeout: 0, // `ask-boss` holds a request open until the boss answers
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/" || path === "/index.html") {
        return new Response(Bun.file(join(webDir, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": NO_CACHE },
        });
      }
      if (path.startsWith("/api/") || path.startsWith("/orch/")) return app(req);

      const file = Bun.file(join(webDir, path.replace(/^\/+/, "")));
      if (await file.exists()) return new Response(file, { headers: { "cache-control": NO_CACHE } });
      return new Response("not found", { status: 404 });
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  // Environment handed to every spawned turn: the URL plus the agent's own
  // token. Identity is never a request-body field.
  process.env.ORCH_URL = url;

  const notifier = new Notifier({ ntfyTopic: process.env.ORCH_NTFY_TOPIC });
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
  const tick = setInterval(() => {
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

    // Keep the PageIndex tree current. Incremental by file signature, so a quiet
    // repo costs zero model calls; a busy one pays for the files that changed.
    void refreshIndex(ctx, cfg.workRoot);

    // Polling is arithmetic, not judgement, so it happens here rather than in an
    // agent. Only a change wakes the PM.
    void pollPrs(ctx, gh).then((fs) => {
      for (const f of fs) {
        if (f.merged) landGroup(ctx, f.grpId, "github");
        else if (f.closed) prClosed(ctx, f.grpId, f.prNumber, url, notifier);
        else if (f.reopened) prReopened(ctx, f.grpId, f.prNumber);
        else dispatchFeedback(ctx, f);
      }
    });
  }, cfg.watchdogIntervalMs);

  // The agents' only way out. Nothing in a sandbox can reach this process
  // directly, so their requests arrive as files and are replayed against these
  // same routes.
  const stopMailbox = startMailbox(ctx);

  // The directory every sandbox mounts read-only. Rebuilt here because the boss
  // installs and uninstalls skills outside this process; a tick box rebuilds it
  // again, and neither needs a container restarted.
  const skills = restageSkills(db, cfg.skillsDir);
  if (skills.failed.length) consola.warn(`skills skipped (dangling): ${skills.failed.join(", ")}`);

  // Say what is missing here, once, rather than letting every group discover it
  // one failed turn at a time. Not fatal: the panel can be opened and the
  // settings page is where three of these are fixed.
  void preflight({ db, sandbox: cfg.sandbox, skillsDir: cfg.skillsDir }).then((checks) => {
    const bad = report(checks);
    if (bad) consola.warn(`preflight:\n${bad}`);
  });

  sched.tick();
  return {
    ctx,
    cfg,
    url,
    notifier,
    stop: () => {
      clearInterval(tick);
      stopMailbox();
      server.stop(true);
    },
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
  reportConfig(loadConfig());
  const { ctx, url, stop } = start();
  consola.info(`orchestrator on ${url}`);
  // The panel is served from `web/dist`, and nothing rebuilds it. A UI change that
  // is committed, tested and typechecked still shows the old page, which reads as
  // "the fix did not work" — measured, on a button that had already been deleted.
  // Not rebuilt here on purpose: in a worktree `web/dist` is a symlink to the main
  // checkout's build, so building would overwrite somebody else's bundle.
  {
    const dist = statSync(join(ROOT, "web/dist/main.js"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    const newest = readdirSync(join(ROOT, "web/src"), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .reduce((m, e) => Math.max(m, statSync(join(e.parentPath, e.name)).mtimeMs), 0);
    if (newest > dist) consola.warn("web/dist 比 web/src 旧 —— 跑一次 `bun run build:web`，不然页面是旧的");
  }

  // Let go of every turn we are reading before exiting, so the next boot sees
  // them as orphans and requeues instead of leaving the group wedged behind a
  // job that nothing will ever finish. Only installed here: `start()` is called
  // many times per test run, and each would add a listener.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      abortAll();
      stop();
      process.exit(0);
    });
  }
}
