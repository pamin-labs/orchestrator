import { afterEach, expect, test } from "bun:test";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { eq } from "drizzle-orm";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig, loadRoles } from "../../src/platform/config/load.ts";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { job, span } from "../../src/platform/persistence/schema.ts";
import type { Executor } from "../../src/platform/scheduling/scheduler.ts";
import { makeExecutor, type ExecDeps } from "../../src/application/executor.ts";
import type { TurnResult } from "../../src/runtime/claude.ts";
import { readTrace, StoredSpanExporter, type StoredSpan } from "../../src/platform/observability/span-store.ts";
import { saveTree } from "../../src/mech/knowledge/pageindex.ts";
import { installTracerProvider } from "../../src/platform/observability/traces.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import * as fx from "../support/factories.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { tempDir } from "../support/temp.ts";
import { newScheduler } from "../support/scheduler.ts";

/**
 * The span table is only worth having if the rows can answer "where did this
 * requirement's time go". That needs two things this suite checks and nothing
 * else does: the stage spans have to nest under the job that ran them, and every
 * row has to carry the scope it belongs to.
 */

afterEach(() => installTracerProvider(new NodeTracerProvider()));

async function harness(turn: () => Promise<TurnResult>) {
  const db = await openMemory();
  await seedAuth(db);
  const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(new StoredSpanExporter(db))] });
  installTracerProvider(provider);

  const cfg = { ...loadConfig(), dataDir: tempDir("orch-spans-") };
  let exec: Executor;
  const sched = newScheduler(db, (j) => exec(j));
  const ctx: Ctx = { db, bus: new Bus(db), sched, sandbox: fakeSandbox(), waiters: new Map(), config: cfg };
  const deps: ExecDeps = { ctx, cfg, roles: loadRoles("roles"), runTurn: turn };
  exec = makeExecutor(deps);

  const f = fx.on(db);
  const p = await f.project.create({ name: "p" });
  await f.runningGrp.create({ project_id: p.id, name: "g1" });
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
async function soleTrace(db: DB): Promise<StoredSpan[]> {
  const ids = await db.selectDistinct({ trace_id: span.trace_id }).from(span);
  expect(ids).toHaveLength(1);
  return readTrace(db, ids[0]!.trace_id);
}

/** The trace one named span belongs to. The HTTP request opens a trace of its own. */
async function traceContaining(db: DB, name: string): Promise<StoredSpan[]> {
  const [row] = await db.select({ trace_id: span.trace_id }).from(span).where(eq(span.name, name));
  if (!row) throw new Error(`no span named ${name} in any trace`);
  return readTrace(db, row.trace_id);
}

const byName = (spans: StoredSpan[], name: string): StoredSpan => {
  const found = spans.find((s) => s.name === name);
  if (!found) throw new Error(`no span named ${name}; saw ${spans.map((s) => s.name).join(", ")}`);
  return found;
};

test("a turn's stages are stored as one nested trace under the job that ran them", async () => {
  const { db, sched, provider } = await harness(ok);

  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  await provider.forceFlush();

  const spans = await soleTrace(db);
  expect(spans.map((s) => s.name).toSorted()).toEqual([
    "job agent_turn",
    // The container round trips the checkpoint makes, timed since the exec
    // funnel got a span. Listed exactly rather than filtered out, because an
    // unexpected span appearing here is itself worth failing on.
    "sandbox.exec",
    "sandbox.exec",
    "turn",
    "turn.checkpoint",
    "turn.prepare",
    "turn.provider",
    // The fourth quarter. `runAgentTurn`'s own comment named four stages and only
    // three were timed, and the missing one is ten serial awaits, two of which
    // enter a container — so "the turn took nine minutes" could resolve to the
    // provider or to here, with no way to tell which.
    "turn.settle",
  ]);

  // The nesting is the point: without an active-context bridge from the job span
  // these came out as five unrelated roots and the trace answered nothing.
  const job = byName(spans, "job agent_turn");
  const turn = byName(spans, "turn");
  expect(job.parentSpanId).toBeNull();
  expect(turn.parentSpanId).toBe(job.spanId);
  for (const stage of ["turn.prepare", "turn.checkpoint", "turn.provider", "turn.settle"]) {
    expect(byName(spans, stage).parentSpanId).toBe(turn.spanId);
  }

  // Every stage is aggregable on its own, not just the turn as a whole.
  for (const span of spans) expect(span.grpId).toBe(1);
  // And by project, which was NULL on every turn span ever written: the panel's
  // project scope filtered on a column nothing set. The read path derives it
  // through `grp` for rows already stored; a span leaving over OTLP reaches a
  // collector that has never heard of that table, so the column carries it too.
  expect(spans.filter((s) => s.projectId !== 1).map((s) => s.name)).toEqual([]);
  expect(spans.length).toBeGreaterThan(4);
  expect(turn.attributes["agent.role"]).toBe("engineer");
  expect(byName(spans, "turn.provider").durationMs).toBeGreaterThanOrEqual(0);
});

test("a failing provider marks its span an error and still fails the job", async () => {
  const { db, sched, provider } = await harness(() => Promise.reject(new Error("provider exploded")));

  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  await provider.forceFlush();

  const spans = await soleTrace(db);
  // Recorded at every level rather than swallowed at the innermost one.
  for (const name of ["turn.provider", "turn", "job agent_turn"]) {
    expect(byName(spans, name).status).toBe("error");
  }
  // The span did not eat the exception: the job is still failed.
  expect((await db.select({ state: job.state }).from(job))[0]?.state).toBe("failed");
});

test("a turn that fails without throwing marks its span too", async () => {
  // The case the throwing test above does not reach, and the common one: a
  // provider that emits no result line sets `ok` false and returns. The span
  // errored only in its `catch`, so a turn that spent its whole timeout
  // producing nothing measured exactly like one that worked — in the surface
  // built to tell them apart. Nothing in the span table carried `status =
  // 'error'` at all while this and its sibling in `git.ls_tree` were open.
  const { db, sched, provider } = await harness(async () => ({
    ...(await ok()),
    ok: false,
    terminalReason: "no_result",
  }));

  await sched.enqueue("agent_turn", { grp_id: 1, payload: { role: "engineer" } });
  await sched.drain();
  await provider.forceFlush();

  const stage = byName(await soleTrace(db), "turn.provider");
  expect(stage.status).toBe("error");
});

test("system work belongs to no project, and stays NULL rather than being guessed", async () => {
  const { db, sched, provider } = await harness(ok);

  await sched.enqueue("watchdog", {});
  await sched.drain();
  await provider.forceFlush();

  const span = byName(await soleTrace(db), "job watchdog");
  expect(span.grpId).toBeNull();
  expect(span.sliceId).toBeNull();
  expect(span.projectId).toBeNull();
});

test("an HTTP request is scoped by the id its own route names", async () => {
  const { db, app, provider } = await harness(ok);

  await app(new Request("http://x/api/v1/slices/1/evidence"));
  await app(new Request("http://x/healthz"));
  await provider.forceFlush();

  const stored = await db.select({ name: span.name, grp_id: span.grp_id, slice_id: span.slice_id }).from(span);

  const slice = stored.find((s) => s.name.includes("/slices/"))!;
  expect(slice.slice_id).toBe(1);
  // The route names a slice and not a group, and resolving one would be a query
  // on every request to fill a column that is allowed to be NULL.
  expect(slice.grp_id).toBeNull();

  const health = stored.find((s) => s.name === "GET /healthz")!;
  expect(health.slice_id).toBeNull();
  expect(health.grp_id).toBeNull();
});

test("a watchdog tick is stored rule by rule, not as one opaque number", async () => {
  // The tick reported a p50 of 50s against a 30s interval and the panel could
  // not say which of twenty-four rules spent it. A rule that reaches into a
  // container or asks GitHub costs a round trip; one that reads a table costs
  // nothing; and a single span for the whole tick cannot tell them apart.
  const { db, sched, provider } = await harness(ok);

  await sched.enqueue("watchdog", {});
  await sched.drain();
  await provider.forceFlush();

  const spans = await soleTrace(db);
  const rules = spans.map((s) => s.name).filter((n) => n.startsWith("watchdog."));
  expect(rules.length).toBeGreaterThan(1);

  // Every rule hangs off the job, so "which rule" is a query rather than a guess.
  const job = byName(spans, "job watchdog");
  for (const rule of rules) expect(byName(spans, rule).parentSpanId).toBe(job.spanId);

  // And the span carries the rule's name, not its number. Splitting the tick into
  // twenty-four spans only moves the guess if the panel reads `watchdog.7d2` and
  // `watchdog.7e`. The number survives as the id — ADR 007 cites "rule 15" and
  // `emit` dedups broken rules on `rule_broke:<id>` — but it is not what is shown.
  expect(rules).toContain("watchdog.turn_timeout");
  for (const rule of rules) expect(rule.slice("watchdog.".length)).not.toMatch(/^\d/);
});

test("`orch ctx query` is timed, and its two halves are timed apart", async () => {
  // The one command every role is told to run first, and the only waiting path
  // with no span at all: its whole justification is that it costs less than the
  // grep rounds it replaces, and that was the one claim nothing could measure.
  const { db, ctx, app, provider } = await harness(ok);
  const f = fx.on(db);
  const agent = await f.agent.create({ project_id: 1, grp_id: 1, role: "engineer", token: "tok-eng" });
  await f.note.create({ project_id: 1, grp_id: 1, kind: "decision", body: "we settled on zod" });
  await saveTree(db, 1, {
    "/": { id: "/", kind: "dir", summary: "", points: [], sig: "", children: ["notes/"] },
    "notes/": { id: "notes/", kind: "dir", summary: "the blackboard", points: [], sig: "", children: [] },
  });
  ctx.askIn = () => async () => "NONE";

  await app(
    new Request("http://x/orch/v1/ctx/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-orch-token": String(agent.token),
      },
      body: JSON.stringify({ question: "which validation library?" }),
    }),
  );
  await provider.forceFlush();

  const spans = await traceContaining(db, "ctx.query");
  // Separately, because they are not comparable costs: the lexical half is an
  // in-memory index at sub-millisecond, the page-index half spends up to three
  // serial model calls. One number over both cannot say which was paid.
  const query = byName(spans, "ctx.query");
  expect(byName(spans, "ctx.assemble").parentSpanId).toBe(query.spanId);
  expect(byName(spans, "ctx.pageindex").parentSpanId).toBe(query.spanId);
  expect(query.grpId).toBe(1);
});

test("pageindex off costs no model call, and the lexical half still answers", async () => {
  // The A/B switch Wave 5.1 turns on: the claim that the walk pays for itself is
  // measurable only against a run with it off, and "off" has to mean no model call
  // rather than a cheaper walk — `depth: 0` would still hand back the root's
  // children. Asserted on `askIn`, which is the thing that costs money.
  const { db, ctx, app, provider } = await harness(ok);
  const f = fx.on(db);
  const agent = await f.agent.create({ project_id: 1, grp_id: 1, role: "engineer", token: "tok-eng" });
  await f.note.create({ project_id: 1, grp_id: 1, kind: "decision", body: "we settled on zod" });
  await saveTree(db, 1, {
    "/": { id: "/", kind: "dir", summary: "", points: [], sig: "", children: ["notes/"] },
    "notes/": { id: "notes/", kind: "dir", summary: "the blackboard", points: [], sig: "", children: [] },
  });
  let asked = 0;
  ctx.askIn = () => async () => {
    asked += 1;
    return "NONE";
  };
  ctx.config = { ...ctx.config, pageindex: { ...ctx.config.pageindex, enabled: false } };

  const r = await app(
    new Request("http://x/orch/v1/ctx/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-orch-token": String(agent.token),
      },
      body: JSON.stringify({ question: "which validation library?" }),
    }),
  );
  await provider.forceFlush();

  expect(asked).toBe(0);
  // The other half is untouched — it is what the walk is being compared against —
  // so the answer still comes back assembled and still carries its own span.
  expect(await r.text()).toContain("This group right now");
  const spans = await traceContaining(db, "ctx.query");
  expect(spans.map((span) => span.name)).toContain("ctx.assemble");
  expect(spans.map((span) => span.name)).not.toContain("ctx.pageindex");
});

test("a page-index walk that throws ends its span red, not green", async () => {
  // The catch predates the span and is why it is worth having: a walk that threw
  // and a tree with no hits both fall through to the lexical half in silence, and
  // `span-store` aggregates on `status = 'error'`, so a green span here would make
  // a broken navigator indistinguishable from a quiet one.
  const { db, ctx, app, provider } = await harness(ok);
  const f = fx.on(db);
  const agent = await f.agent.create({ project_id: 1, grp_id: 1, role: "engineer", token: "tok-eng" });
  await saveTree(db, 1, {
    "/": { id: "/", kind: "dir", summary: "", points: [], sig: "", children: ["notes/"] },
    "notes/": { id: "notes/", kind: "dir", summary: "the blackboard", points: [], sig: "", children: [] },
  });
  ctx.askIn = () => async () => {
    throw new Error("the cheap model is unreachable");
  };

  const answer = await app(
    new Request("http://x/orch/v1/ctx/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-orch-token": String(agent.token),
      },
      body: JSON.stringify({ question: "which validation library?" }),
    }),
  );
  await provider.forceFlush();

  // The agent still gets its answer; only the span reports the failure.
  expect(answer.status).toBe(200);
  expect(byName(await traceContaining(db, "ctx.pageindex"), "ctx.pageindex").status).toBe("error");
});
