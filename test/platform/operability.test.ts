import { expect, test } from "bun:test";
import { makeApp } from "../../src/composition/api.ts";
import { readinessPeriodMs } from "../../src/composition/server.ts";
import { ErrorResponseSchema } from "../../src/contracts/protocol.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { runtimeStatus } from "../../src/platform/observability/metrics.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { refreshRuntimeReadiness, shutdownRuntime } from "../../src/composition/server.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

test("health, cached readiness, metrics, and correlation describe the running process", async () => {
  const status = runtimeStatus(false);
  status.checks = [{ name: "sandbox", ok: false, detail: "not reachable" }];
  const app = makeApp(testContext(), status);

  const health = await app(new Request("http://x/healthz", { headers: { "x-request-id": "request-123" } }));
  expect(health.status).toBe(200);
  expect(health.headers.get("x-request-id")).toBe("request-123");
  expect(health.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  const notReady = await app(new Request("http://x/readyz"));
  expect(notReady.status).toBe(503);
  expect(await notReady.json()).toMatchObject({ status: "not_ready", checks: [{ name: "sandbox", ok: false }] });

  status.ready = true;
  status.checks = [{ name: "sandbox", ok: true, detail: "reachable" }];
  expect((await app(new Request("http://x/readyz"))).status).toBe(200);

  const metrics = await (await app(new Request("http://x/metrics"))).text();
  expect(metrics).toContain("orchestrator_http_requests_total");
  expect(metrics).toContain('route="/healthz"');
  expect(metrics).toContain("orchestrator_event_loop_delay_seconds");
});

test("readiness refreshes through failure and recovery without a real server", async () => {
  const status = runtimeStatus(false);

  await refreshRuntimeReadiness(status, async () => [{ name: "sandbox", ok: true, detail: "reachable" }]);
  expect(status.ready).toBe(true);
  expect(status.checks).toEqual([{ name: "sandbox", ok: true, detail: "reachable" }]);

  await refreshRuntimeReadiness(status, async () => [
    { name: "sandbox", ok: false, detail: "offline" },
    { name: "migration", ok: true, detail: "current" },
  ]);
  expect(status.ready).toBe(false);
  expect(status.checks).toHaveLength(2);

  await refreshRuntimeReadiness(status, async () => {
    throw new Error("probe crashed");
  });
  expect(status.ready).toBe(false);
  expect(status.checks).toEqual([{ name: "preflight", ok: false, detail: "probe crashed" }]);

  await refreshRuntimeReadiness(status, async () => [{ name: "sandbox", ok: true, detail: "recovered" }]);
  expect(status.ready).toBe(true);
  expect(status.checks).toEqual([{ name: "sandbox", ok: true, detail: "recovered" }]);
});

test("shutdown admission refuses new mutations with the public error contract", async () => {
  const status = runtimeStatus();
  status.accepting = false;
  const app = makeApp(testContext(), status);
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
  const ctx = testContext();
  ctx.db.run("DROP TABLE grp");
  const response = await makeApp(ctx)(new Request("http://x/api/v1/state"));
  const body = ErrorResponseSchema.parse(await response.json());
  expect(response.status).toBe(500);
  expect(body).toMatchObject({ error: "internal server error", code: "internal_error" });
  expect(JSON.stringify(body)).not.toContain("no such table");
});

test("a quiesced scheduler drains only work already in flight", async () => {
  const db = openMemory();
  try {
    const p = fx.project.insert(db, { name: "quiesce", repo_path: "acme/quiesce" });
    fx.runningGrp.insert(db, { project_id: p.id, name: "workers" });
    fx.runtimeAuth.insert(db, { mode: "api_key", secret: "test" });
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
    const first = scheduler.enqueue("agent_turn", { grp_id: 1 });
    scheduler.enqueue("agent_turn", { grp_id: 1 });
    scheduler.tick();
    await started;

    scheduler.quiesce();
    release();
    await scheduler.drain();

    expect(ran).toEqual([first]);
    expect(
      db
        .query<{ state: string }, []>("SELECT state FROM job ORDER BY id")
        .all()
        .map((row) => row.state),
    ).toEqual(["done", "pending"]);
  } finally {
    db.close();
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
    reclaim: () => calls.push("reclaim"),
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
    reclaim: () => calls.push("reclaim"),
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
  const ctx = testContext();
  try {
    const app = makeApp(ctx);
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) => app(new Request(`http://x/secret-token-${i}`))),
    );
    expect(responses.filter((response) => response.status !== 404)).toEqual([]);
    const metrics = await (await app(new Request("http://x/metrics"))).text();
    expect(metrics).toContain('route="unmatched",status="404"');
    expect(metrics).not.toContain("secret-token-");
  } finally {
    ctx.db.close();
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
