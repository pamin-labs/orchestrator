import { expect, test } from "bun:test";
import { makeApp } from "../../src/composition/api.ts";
import { missingBinaries, readinessPeriodMs } from "../../src/composition/server.ts";
import { ErrorResponseSchema } from "../../src/contracts/protocol.ts";
import { asc, sql } from "drizzle-orm";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { job } from "../../src/platform/persistence/schema.ts";
import { runtimeStatus } from "../../src/platform/observability/metrics.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { refreshRuntimeReadiness, shutdownRuntime } from "../../src/composition/server.ts";
import { makeCheck } from "../../src/mech/ops/preflight.ts";
import * as fx from "../support/factories.ts";
import { said } from "../support/said.ts";

import { testContext } from "../support/test-context.ts";

test("health, cached readiness, metrics, and correlation describe the running process", async () => {
  const status = runtimeStatus(false);
  status.checks = [makeCheck("sandbox", false, said("not reachable"))];
  const app = makeApp(await testContext(), status);

  const health = await app(new Request("http://x/healthz", { headers: { "x-request-id": "request-123" } }));
  expect(health.status).toBe(200);
  expect(health.headers.get("x-request-id")).toBe("request-123");
  expect(health.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  const notReady = await app(new Request("http://x/readyz"));
  expect(notReady.status).toBe(503);
  expect(await notReady.json()).toMatchObject({ status: "not_ready", checks: [{ name: "sandbox", ok: false }] });

  status.ready = true;
  status.checks = [makeCheck("sandbox", true, said("reachable"))];
  expect((await app(new Request("http://x/readyz"))).status).toBe(200);

  const metrics = await (await app(new Request("http://x/metrics"))).text();
  expect(metrics).toContain("orchestrator_http_requests_total");
  expect(metrics).toContain('route="/healthz"');
  expect(metrics).toContain("orchestrator_event_loop_delay_seconds");
});

test("readiness refreshes through failure and recovery without a real server", async () => {
  const status = runtimeStatus(false);

  const reachable = makeCheck("sandbox", true, said("reachable"));
  await refreshRuntimeReadiness(status, async () => [reachable]);
  expect(status.ready).toBe(true);
  expect(status.checks).toEqual([reachable]);

  await refreshRuntimeReadiness(status, async () => [
    makeCheck("sandbox", false, { ...said("cannot reach it: {error}"), values: { error: "offline" } }),
    makeCheck("migration", true, said("migrated and queryable")),
  ]);
  expect(status.ready).toBe(false);
  expect(status.checks).toHaveLength(2);

  await refreshRuntimeReadiness(status, async () => {
    throw new Error("probe crashed");
  });
  expect(status.ready).toBe(false);
  // The crash is a key too: the pane that shows it holds nine catalogues, and
  // the error text is the value inside the sentence rather than the sentence.
  expect(status.checks).toEqual([
    makeCheck("preflight", false, { ...said("the checks could not run: {error}"), values: { error: "probe crashed" } }),
  ]);

  await refreshRuntimeReadiness(status, async () => [reachable]);
  expect(status.ready).toBe(true);
  expect(status.checks).toEqual([reachable]);
});

test("shutdown admission refuses new mutations with the public error contract", async () => {
  const status = runtimeStatus();
  status.accepting = false;
  const app = makeApp(await testContext(), status);
  const response = await app(
    new Request("http://x/api/v1/ideas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, text: "too late" }),
    }),
  );

  expect(response.status).toBe(503);
  expect(ErrorResponseSchema.parse(await response.json())).toMatchObject({ code: "shutting_down" });
});

test("unexpected failures keep details in logs and return a stable generic body", async () => {
  const ctx = await testContext();
  // Renamed rather than dropped, and put back: one database serves the whole
  // process, and a table this file removed is a table every later `openMemory()`
  // cannot truncate. The query fails the same way either road.
  await ctx.db.execute(sql`ALTER TABLE grp RENAME TO grp_gone`);
  try {
    const response = await makeApp(ctx)(new Request("http://x/api/v1/state"));
    const body = ErrorResponseSchema.parse(await response.json());
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: "internal server error", code: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("does not exist");
    expect(JSON.stringify(body)).not.toContain("grp");
  } finally {
    await ctx.db.execute(sql`ALTER TABLE grp_gone RENAME TO grp`);
  }
});

test("a quiesced scheduler drains only work already in flight", async () => {
  const db = await openMemory();
  {
    const f = fx.on(db);
    const p = await f.project.create({ name: "quiesce", repo_path: "acme/quiesce" });
    await f.runningGrp.create({ project_id: p.id, name: "workers" });
    await f.runtimeAuth.create({ mode: "api_key", secret: "test" });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: number[] = [];
    const scheduler = new Scheduler(db, async (job) => {
      ran.push(job.id);
      entered();
      await held;
    });
    const first = await scheduler.enqueue("agent_turn", { grp_id: 1 });
    await scheduler.enqueue("agent_turn", { grp_id: 1 });
    void scheduler.tick();
    await started;

    scheduler.quiesce();
    release();
    await scheduler.drain();

    expect(ran).toEqual([first]);
    expect((await db.select({ state: job.state }).from(job).orderBy(asc(job.id))).map((row) => row.state)).toEqual([
      "done",
      "pending",
    ]);
  }
});

test("shutdown drains gracefully before closing resources", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const draining = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = shutdownRuntime({
    stopIntake: () => (calls.push("stop-intake"), true),
    drain: () => {
      calls.push("drain");
      return draining;
    },
    gracefulStop: async () => {
      calls.push("graceful-stop");
    },
    reclaim: async () => {
      calls.push("reclaim");
    },
    abort: () => calls.push("abort"),
    forceStop: async () => {
      calls.push("force-stop");
    },
    close: () => calls.push("close"),
    sleep: () => new Promise(() => {}),
  });

  await Bun.sleep(0);
  expect(calls).toEqual(["stop-intake", "drain", "graceful-stop"]);
  release();
  expect(await done).toBe(0);
  expect(calls).toEqual(["stop-intake", "drain", "graceful-stop", "close"]);
});

test("forced shutdown reclaims before aborting and closes after the forced drain", async () => {
  const calls: string[] = [];
  let drains = 0;
  const result = await shutdownRuntime({
    stopIntake: () => (calls.push("stop-intake"), true),
    drain: async () => {
      calls.push(`drain-${++drains}`);
      if (drains === 1) await new Promise(() => {});
    },
    gracefulStop: async () => {
      calls.push("graceful-stop");
    },
    reclaim: async () => {
      calls.push("reclaim");
    },
    abort: () => calls.push("abort"),
    forceStop: async () => {
      calls.push("force-stop");
    },
    close: () => calls.push("close"),
    sleep: async () => {},
  });

  expect(result).toBe(1);
  expect(calls).toEqual([
    "stop-intake",
    "drain-1",
    "graceful-stop",
    "reclaim",
    "abort",
    "force-stop",
    "drain-2",
    "close",
  ]);
});

test("unmatched request paths cannot create unbounded metrics labels", async () => {
  const ctx = await testContext();
  {
    const app = makeApp(ctx);
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) => app(new Request(`http://x/secret-token-${i}`))),
    );
    expect(responses.filter((response) => response.status !== 404)).toEqual([]);
    const metrics = await (await app(new Request("http://x/metrics"))).text();
    expect(metrics).toContain('route="unmatched",status="404"');
    expect(metrics).not.toContain("secret-token-");
  }
});

/**
 * The self-check's period, which is not the watchdog's despite being derived from it.
 *
 * The clamp is the policy: below five seconds the three `spawnSync` calls to the
 * docker daemon block the event loop more often than they report anything, and above
 * thirty a machine that has lost its sandbox server takes half a minute to say so on
 * a page somebody is watching.
 */
/**
 * The re-arm around it is deliberately not tested here: four lines identical to the
 * watchdog timer's, and reaching it needs a live server and a manipulated clock. The
 * part with a decision in it is this function.
 */
test("the self-check period follows the watchdog's interval, within bounds", () => {
  expect(readinessPeriodMs(15_000)).toBe(15_000);
  // A one-second watchdog does not get a one-second docker probe.
  expect(readinessPeriodMs(1_000)).toBe(5_000);
  // Nor does a ten-minute one leave the panel half a minute behind.
  expect(readinessPeriodMs(600_000)).toBe(30_000);
  expect(readinessPeriodMs(5_000)).toBe(5_000);
  expect(readinessPeriodMs(30_000)).toBe(30_000);
});

/**
 * The host needs no binary of its own, which is a product claim and not a constant.
 *
 * `README.md` asks for Docker and nothing else, and `start()` refuses to boot for
 * anything `missingBinaries()` names. Since ADR 007 the answer is nothing: git runs
 * in the group's container and the CLIs in the sandbox. So a host binary added back
 * changes what a user must install, and this is where they are made to notice.
 */
test("a headless box needs nothing on PATH that this process checks for", () => {
  expect(missingBinaries()).toEqual([]);
});

test("the boss's watchdog interval is followed; only the readiness probe is clamped", () => {
  // Worth pinning because the two look alike: `readinessPeriodMs` bounds a
  // `spawnSync` self-check to 5–30s, and it is *derived* from the interval rather
  // than replacing it. A reading that confuses them concludes the panel's own knob
  // is silently overridden, which would be worth fixing — and is not what happens.
  expect(readinessPeriodMs(60_000)).toBe(30_000);
  expect(readinessPeriodMs(1_000)).toBe(5_000);
  // And the clamp is one-directional in neither: a value already inside the band
  // is returned as it stands, which is what makes it a bound rather than a fixed
  // period wearing a parameter.
  expect(readinessPeriodMs(15_000)).toBe(15_000);
});
