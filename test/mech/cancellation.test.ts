import { expect, test } from "bun:test";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { makeGithub, type GithubFetcher } from "../../src/mech/git/github.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";
import { abortJob } from "../../src/platform/process/running-turns.ts";
import { job } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { newScheduler } from "../support/scheduler.ts";

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

async function seededDb() {
  const db = await openMemory();
  const f = fx.on(db);
  await seedAuth(db);
  await saveAuth(db, { runtime: "github", mode: "api_key", secret: "ghp_test" });
  const p = await f.project.create({
    name: "p",
    repo_path: "me/p",
    remote: "https://github.com/me/p.git",
    base_branch: "main",
  });
  await f.runningGrp.create({ project_id: p.id, name: "g1" });
  return db;
}

test("an aborted HTTP request cancels an implicit GitHub call with the caller's reason", async () => {
  const db = await seededDb();
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
  const sched = newScheduler(db, async () => {});
  const ctx: Ctx = { db, bus, sched, gh, waiters: new Map(), config: loadConfig() };
  const response = makeApp(ctx)(new Request("http://x/api/v1/project/1/config", { signal: controller.signal }));

  await started;
  controller.abort(reason);

  expect(await response.catch((error: unknown) => error)).toBe(reason);
  expect(seenSignal?.reason).toBe(reason);
  expect(attempts).toBe(1);
});

test("cancelling a running queued job aborts GitHub fetch and retry backoff", async () => {
  const db = await seededDb();
  // Avoid colliding with job ids the rest of this process has used: the
  // production cancellation registry is process-global because production has
  // exactly one database, and `openMemory` restarts identities at 1 per test.
  await db.execute(sql`SELECT setval(pg_get_serial_sequence('job', 'id'), 910000, false)`);
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
  const scheduler = newScheduler(db, async () => {
    try {
      await gh.request("GET", "/user", z.json());
    } catch (error) {
      thrown = error;
      throw error;
    }
  });
  jobId = await scheduler.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await scheduler.drain();

  expect(cancelled).toBe(true);
  expect(seenSignal?.aborted).toBe(true);
  expect(thrown).toBe(seenSignal?.reason);
  expect(seenSignal?.reason).toEqual(new Error(`job ${jobId} cancelled`));
  expect(attempts).toBe(1);
  const [row] = await db.select({ state: job.state }).from(job).where(eq(job.id, jobId));
  expect(row?.state).toBe("failed");
});
