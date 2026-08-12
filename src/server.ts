import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { makeApp, type Ctx } from "./api.ts";
import { Bus } from "./bus.ts";
import { loadConfig, loadRoles, ROOT, type Config } from "./config.ts";
import { open } from "./db.ts";
import { RepoLock } from "./mech/gitlock.ts";
import { makeGitRunner } from "./mech/worktree.ts";
import { makeExecutor, makeReviewVerdict } from "./runtime/executor.ts";
import { Scheduler } from "./scheduler.ts";

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
  stop: () => void;
}

export function start(overrides: Partial<Config> = {}): Started {
  const cfg = { ...loadConfig(), ...overrides };
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
  const ctx: Ctx = {
    db,
    bus,
    sched,
    gitLock,
    git,
    waiters: new Map(),
    config: { language: cfg.language, difficultyModel: cfg.difficultyModel, workRoot: cfg.workRoot },
  };
  const execDeps = { ctx, cfg, roles, git };
  exec = makeExecutor(execDeps);
  ctx.reviewVerdict = makeReviewVerdict(execDeps);

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

  process.env.ORCH_BIN_DIR = installOrchShim(cfg.dataDir);

  sched.tick();
  return { ctx, cfg, url, stop: () => server.stop(true) };
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
  const { url } = start();
  console.log(`orchestrator on ${url}`);
}
