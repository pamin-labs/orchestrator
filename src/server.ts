import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { landGroup, makeApp, type Ctx } from "./api.ts";
import { Bus } from "./bus.ts";
import { loadConfig, loadRoles, ROOT, withAbsoluteDataDir, type Config } from "./config.ts";
import { open } from "./db.ts";
import { RepoLock } from "./mech/gitlock.ts";
import { makeGitRunner } from "./mech/worktree.ts";
import { batchForBoss, Notifier, tierFor, type PendingItem } from "./mech/notify.ts";
import { dispatchFeedback, makeGhRunner, openPr, pollPrs } from "./mech/prwatch.ts";
import { hire, makeAuditVerdict, makeExecutor, makeReviewVerdict } from "./runtime/executor.ts";
import { reclaimOrphans, resumeReclaimed, Scheduler } from "./scheduler.ts";

/**
 * Wires the pieces together and serves them.
 *
 * One process: HTTP + SSE for the web UI, the same routes for `orch`, the job
 * queue, and the subprocesses it spawns. Bound to 127.0.0.1 — the sandbox
 * allows localhost TCP but no unix sockets (docs/decisions/001).
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
    waiters: new Map(),
    config: {
      language: cfg.language,
      difficultyModel: cfg.difficultyModel,
      workRoot: cfg.workRoot,
      dataDir: cfg.dataDir,
      autoAdvance: cfg.autoAdvance,
      autoAcceptTiers: cfg.autoAcceptTiers,
      maxGroups: cfg.maxGroups,
      leaseSlots: cfg.leaseSlots,
      feedbackSediment: cfg.feedbackSedimentThreshold,
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
        body: "Opened by the orchestrator after the audit passed. Journals are in docs/journal/.",
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
            `INSERT INTO escalation (grp_id, severity, question, chain_state, created_at)
             VALUES (?, 'blocker', ?, 'boss', unixepoch() * 1000)`,
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
    idleTimeout: 0, // `ask-boss` holds a request open until the boss answers
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/" || path === "/index.html") {
        return new Response(Bun.file(join(webDir, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path.startsWith("/api/") || path.startsWith("/orch/")) return app(req);

      const file = Bun.file(join(webDir, path.replace(/^\/+/, "")));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  // Environment handed to every spawned turn: the URL plus the agent's own
  // token. Identity is never a request-body field.
  process.env.ORCH_URL = url;

  const notifier = new Notifier({ ntfyTopic: process.env.ORCH_NTFY_TOPIC });
  ctx.onFinding = (rule, severity, body, grpId) => {
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

  process.env.ORCH_BIN_DIR = installOrchShim(cfg.dataDir);

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

    // Polling is arithmetic, not judgement, so it happens here rather than in an
    // agent. Only a change wakes the PM.
    void pollPrs(ctx, gh).then((fs) => {
      for (const f of fs) {
        if (f.merged) landGroup(ctx, f.grpId, "github");
        else dispatchFeedback(ctx, f);
      }
    });
  }, cfg.watchdogIntervalMs);

  sched.tick();
  return {
    ctx,
    cfg,
    url,
    notifier,
    stop: () => {
      clearInterval(tick);
      server.stop(true);
    },
  };
}

/**
 * Agents invoke a plain `orch`, so one has to exist on their PATH. A two-line
 * shim beats shipping a compiled binary: it always matches the running source.
 */
export function installOrchShim(dataDir: string): string {
  const binDir = join(dataDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const cli = join(ROOT, "src/orch/cli.ts");
  const path = join(binDir, "orch");
  writeFileSync(path, `#!/bin/sh\nexec bun run ${JSON.stringify(cli)} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return binDir;
}

if (import.meta.main) {
  const { ctx, url, stop } = start();
  console.log(`orchestrator on ${url}`);

  // Ctrl-C left the turns' subprocesses running. Next boot then saw a live pid and
  // declined to reclaim the job — so the group stayed wedged for four turn timeouts
  // while an unowned `claude` kept writing into its worktree. Only installed here:
  // `start()` is called many times per test run, and each would add a listener.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      for (const j of ctx.db
        .query<{ pid: number }, []>("SELECT pid FROM job WHERE state = 'running' AND pid IS NOT NULL")
        .all()) {
        try {
          process.kill(j.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
      stop();
      process.exit(0);
    });
  }
}
