import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig, loadRoles } from "../../src/platform/config/load.ts";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { Scheduler, type Executor } from "../../src/platform/scheduling/scheduler.ts";
import { makeExecutor, type ExecDeps } from "../../src/application/executor.ts";
import type { TurnResult } from "../../src/runtime/claude.ts";
import { readTrace, SqliteSpanExporter, type StoredSpan } from "../../src/platform/observability/span-store.ts";
import { installTracerProvider } from "../../src/platform/observability/traces.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";

/**
 * The span table is only worth having if the rows can answer "where did this
 * requirement's time go". That needs two things this suite checks and nothing
 * else does: the stage spans have to nest under the job that ran them, and every
 * row has to carry the scope it belongs to.
 */

afterEach(() => installTracerProvider(new NodeTracerProvider()));

function harness(turn: () => Promise<TurnResult>) {
  const db = openMemory();
  seedAuth(db);
  const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(new SqliteSpanExporter(db))] });
  installTracerProvider(provider);

  const cfg = { ...loadConfig(), dataDir: mkdtempSync(join(tmpdir(), "orch-spans-")) };
  let exec: Executor;
  const sched = new Scheduler(db, (j) => exec(j));
  const ctx: Ctx = { db, bus: new Bus(db), sched, sandbox: fakeSandbox(), waiters: new Map(), config: cfg };
  const deps: ExecDeps = { ctx, cfg, roles: loadRoles("roles"), runTurn: turn };
  exec = makeExecutor(deps);

  const p = fx.project.insert(db, { name: "p" });
  fx.runningGrp.insert(db, { project_id: p.id, name: "g1" });
  return { db, ctx, sched, provider, app: makeApp(ctx) };
}

const ok = async (): Promise<TurnResult> => ({
  sessionId: "s1",
  ok: true,
  terminalReason: "completed",
  text: "done",
  usage: { input: 10, output: 20, cacheRead: 0, cacheCreate: 0, thinking: 0 },
  numTurns: 1,
  toolSummaries: [],
  filesTouched: [],
});

/** The one trace a single job produced, whatever id it was given. */
function soleTrace(db: DB): StoredSpan[] {
  const ids = db.query<{ trace_id: string }, []>("SELECT DISTINCT trace_id FROM span").all();
  expect(ids).toHaveLength(1);
  return readTrace(db, ids[0]!.trace_id);
}

const byName = (spans: StoredSpan[], name: string): StoredSpan => {
  const found = spans.find((s) => s.name === name);
  if (!found) throw new Error(`no span named ${name}; saw ${spans.map((s) => s.name).join(", ")}`);
  return found;
};

test("a turn's stages are stored as one nested trace under the job that ran them", async () => {
  const { db, sched, provider } = harness(ok);

  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  await provider.forceFlush();

  const spans = soleTrace(db);
  expect(spans.map((s) => s.name).toSorted()).toEqual([
    "job agent_turn",
    "turn",
    "turn.checkpoint",
    "turn.prepare",
    "turn.provider",
  ]);

  // The nesting is the point: without an active-context bridge from the job span
  // these came out as five unrelated roots and the trace answered nothing.
  const job = byName(spans, "job agent_turn");
  const turn = byName(spans, "turn");
  expect(job.parentSpanId).toBeNull();
  expect(turn.parentSpanId).toBe(job.spanId);
  for (const stage of ["turn.prepare", "turn.checkpoint", "turn.provider"]) {
    expect(byName(spans, stage).parentSpanId).toBe(turn.spanId);
  }

  // Every stage is aggregable on its own, not just the turn as a whole.
  for (const span of spans) expect(span.grpId).toBe(1);
  expect(turn.attributes["agent.role"]).toBe("engineer");
  expect(byName(spans, "turn.provider").durationMs).toBeGreaterThanOrEqual(0);
});

test("a failing provider marks its span an error and still fails the job", async () => {
  const { db, sched, provider } = harness(() => Promise.reject(new Error("provider exploded")));

  sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  await provider.forceFlush();

  const spans = soleTrace(db);
  // Recorded at every level rather than swallowed at the innermost one.
  for (const name of ["turn.provider", "turn", "job agent_turn"]) {
    expect(byName(spans, name).status).toBe("error");
  }
  // The span did not eat the exception: the job is still failed.
  expect(db.query<{ state: string }, []>("SELECT state FROM job").get()!.state).toBe("failed");
});

test("system work belongs to no project, and stays NULL rather than being guessed", async () => {
  const { db, sched, provider } = harness(ok);

  sched.enqueue("watchdog", {});
  await sched.drain();
  await provider.forceFlush();

  const span = byName(soleTrace(db), "job watchdog");
  expect(span.grpId).toBeNull();
  expect(span.sliceId).toBeNull();
  expect(span.projectId).toBeNull();
});

test("an HTTP request is scoped by the id its own route names", async () => {
  const { db, app, provider } = harness(ok);

  await app(new Request("http://x/api/v1/slices/1/evidence"));
  await app(new Request("http://x/healthz"));
  await provider.forceFlush();

  const stored = db
    .query<{ name: string; grp_id: number | null; slice_id: number | null }, []>(
      "SELECT name, grp_id, slice_id FROM span",
    )
    .all();

  const slice = stored.find((s) => s.name.includes("/slices/"))!;
  expect(slice.slice_id).toBe(1);
  // The route names a slice and not a group, and resolving one would be a query
  // on every request to fill a column that is allowed to be NULL.
  expect(slice.grp_id).toBeNull();

  const health = stored.find((s) => s.name === "GET /healthz")!;
  expect(health.slice_id).toBeNull();
  expect(health.grp_id).toBeNull();
});
