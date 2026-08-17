import { expect, test } from "bun:test";
import { z } from "zod";
import { makeApp } from "../src/api.ts";
import type { Ctx } from "../src/ctx.ts";
import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { openMemory } from "../src/db.ts";
import { makeGithub, type GithubFetcher } from "../src/mech/git/github.ts";
import { saveAuth } from "../src/mech/sandbox/auth.ts";
import { abortJob } from "../src/platform/process/running-turns.ts";
import { Scheduler } from "../src/scheduler.ts";
import { seedAuth } from "./seed-auth.ts";

function blockedFetch(onStart: (signal: AbortSignal) => void): GithubFetcher {
  return async (_url, init) => {
    const signal = init.signal;
    if (!signal) throw new Error("GitHub request has no cancellation signal");
    onStart(signal);
    return await new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

function seededDb() {
  const db = openMemory();
  seedAuth(db);
  saveAuth(db, { runtime: "github", mode: "api_key", secret: "ghp_test" });
  db.run(
    "INSERT INTO project (name, repo_path, remote, base_branch, created_at) VALUES ('p', 'me/p', 'https://github.com/me/p.git', 'main', 0)",
  );
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  return db;
}

test("an aborted HTTP request cancels an implicit GitHub call with the caller's reason", async () => {
  const db = seededDb();
  try {
    const controller = new AbortController();
    const reason = new Error("browser disconnected");
    let attempts = 0;
    let seenSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gh = makeGithub(
      db,
      blockedFetch((signal) => {
        attempts += 1;
        seenSignal = signal;
        entered();
      }),
    );
    const bus = new Bus(db);
    const sched = new Scheduler(db, async () => {});
    const ctx: Ctx = { db, bus, sched, gh, waiters: new Map(), config: loadConfig() };
    const response = makeApp(ctx)(new Request("http://x/api/v1/project/1/config", { signal: controller.signal }));

    await started;
    controller.abort(reason);

    expect(await response.catch((error: unknown) => error)).toBe(reason);
    expect(seenSignal?.reason).toBe(reason);
    expect(attempts).toBe(1);
  } finally {
    db.close();
  }
});

test("cancelling a running queued job aborts GitHub fetch and retry backoff", async () => {
  const db = seededDb();
  try {
    // Avoid colliding with job ids from another in-process test database: the
    // production cancellation registry is process-global because production has
    // exactly one database.
    db.run("UPDATE sqlite_sequence SET seq = 910000 WHERE name = 'job'");
    let attempts = 0;
    let seenSignal: AbortSignal | undefined;
    let thrown: unknown;
    let jobId = 0;
    let cancelled = false;
    const gh = makeGithub(db, async (_url, init) => {
      attempts += 1;
      seenSignal = init.signal;
      // Cancel after GitHub returns a retryable answer. The request continuation
      // reaches its retry backoff with an already-aborted job signal; a second
      // fetch would prove that backoff ignored job cancellation.
      queueMicrotask(() => {
        cancelled = abortJob(jobId);
      });
      return new Response('{"message":"try later"}', { status: 502 });
    });
    const scheduler = new Scheduler(db, async () => {
      try {
        await gh.request("GET", "/user", z.json());
      } catch (error) {
        thrown = error;
        throw error;
      }
    });
    jobId = scheduler.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
    await scheduler.drain();

    expect(cancelled).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    expect(thrown).toBe(seenSignal?.reason);
    expect(seenSignal?.reason).toEqual(new Error(`job ${jobId} cancelled`));
    expect(attempts).toBe(1);
    expect(db.query<{ state: string }, [number]>("SELECT state FROM job WHERE id = ?").get(jobId)?.state).toBe(
      "failed",
    );
  } finally {
    db.close();
  }
});
