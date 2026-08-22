import { Bench } from "tinybench";
import { Bus } from "../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../src/platform/config/load.ts";
import { openMemory } from "../src/platform/persistence/database.ts";
import { snapshot } from "../src/api/panel/snapshot.ts";
import { reconcile } from "../src/mech/flow/reconcile.ts";
import { runWatchdog } from "../src/mech/ops/watchdog.ts";
import { assemble, type StablePrompt } from "../src/prompt/assemble.ts";
import { Scheduler } from "../src/platform/scheduling/scheduler.ts";
import {
  foldedStacks,
  recentWindow,
  spanExtent,
  stageStats,
  traceList,
  trend,
} from "../src/platform/observability/span-store.ts";
import { gt, max } from "drizzle-orm";
import type { Ctx } from "../src/mech/ctx.ts";
import {
  agent,
  channel,
  event,
  grp,
  job,
  project,
  runtime_auth,
  slice,
  span,
  task,
} from "../src/platform/persistence/schema.ts";

/**
 * `time` and `iterations` are both *minimums* and a cycle ends once both are
 * met, which is why stating both needs no per-task tuning: a 140ns prompt
 * assembly takes millions of samples to fill the clock, and a watchdog tick
 * reaches sixteen samples long before it.
 */
const bench = new Bench({
  time: 500,
  iterations: 16,
  warmupTime: 100,
  warmupIterations: 4,
  // A benchmark that throws is a broken benchmark, not a slow one: fail the run
  // rather than report statistics over the samples that happened to survive.
  throws: true,
});

/**
 * Raised when latency approaches the timer grain, as the sub-microsecond tasks
 * here do: the mean over millions of samples stays sound but the median and the
 * percentiles quantise, which is worth saying out loud rather than swallowing.
 */
bench.addEventListener("warning", (event) => {
  console.warn(`warning: ${event.task.name} samples are timer-saturated (${event.reason ?? "unknown"})`);
});

/**
 * Budgets are checked against the mean, not a tail percentile.
 *
 * These catch a significant regression in work the nightly job repeats, not a
 * user-facing latency tail: an added query or an added pass moves the whole
 * distribution. A tail percentile over a sixteen-sample task is close to its
 * maximum, so a budget there would be a budget on whichever GC pause it caught.
 *
 * Each limit is the old whole-batch budget divided by the batch it covered.
 */
const limits = new Map<string, number>();

/**
 * The counter is Drizzle's own `logger` hook, which fires once per statement.
 *
 * `snapshotQueries` used to Proxy the handle and intercept `query`/`prepare`.
 * Neither member exists on a Drizzle database, so that guard would have counted
 * zero for ever — silently, which is the shape it was written to catch.
 */
let queries = 0;
const db = await openMemory({ logQuery: () => void (queries += 1) });
const cfg = loadConfig();
const bus = new Bus(db);
const scheduler = new Scheduler(db, async () => {}, { maxGroups: 1_000 });
const ctx: Ctx = { db, bus, sched: scheduler, waiters: new Map(), config: cfg };

await db.insert(project).values({ name: "bench", repo_path: "acme/bench", base_branch: "main", created_at: 0 });
await db.insert(runtime_auth).values({ runtime: "claude", mode: "api_key", secret: "bench-secret", updated_at: 0 });

async function seedGroup(index: number): Promise<void> {
  const [group] = await db
    .insert(grp)
    .values({ project_id: 1, name: `bench-${index}`, branch: `orch/bench-${index}`, status: "RUNNING", created_at: 0 })
    .returning({ id: grp.id });
  const [sliceRow] = await db
    .insert(slice)
    .values({
      grp_id: group!.id,
      seq: 1,
      title: `slice-${index}`,
      accept_spec: "passes",
      status: "running",
      created_at: 0,
    })
    .returning({ id: slice.id });
  const [agentRow] = await db
    .insert(agent)
    .values({
      project_id: 1,
      grp_id: group!.id,
      role: "engineer",
      model: `model-${index % 3}`,
      runtime: "claude",
      created_at: 0,
    })
    .returning({ id: agent.id });
  const [channelRow] = await db
    .insert(channel)
    .values({ project_id: 1, grp_id: group!.id, kind: "group", created_at: 0 })
    .returning({ id: channel.id });
  await db
    .insert(task)
    .values({ grp_id: group!.id, slice_id: sliceRow!.id, title: "work", status: "pending", created_at: 0 });
  await db
    .insert(event)
    .values({ channel_id: channelRow!.id, grp_id: group!.id, author: "engineer", kind: "say", body: "working", at: 0 });
  await db.insert(job).values({
    kind: "agent_turn",
    grp_id: group!.id,
    agent_id: agentRow!.id,
    slice_id: sliceRow!.id,
    state: "done",
    enqueued_at: 0,
    ended_at: 1,
  });
}

async function snapshotQueries(): Promise<number> {
  queries = 0;
  await snapshot(ctx);
  return queries;
}

await seedGroup(1);
const oneGroupQueries = await snapshotQueries();
for (let i = 2; i <= 50; i++) await seedGroup(i);
const fiftyGroupQueries = await snapshotQueries();
console.log(`snapshot query count: 1 group=${oneGroupQueries}, 50 groups=${fiftyGroupQueries}`);
if (fiftyGroupQueries !== oneGroupQueries) throw new Error("snapshot query count grows with group rows");

/**
 * Inputs, not subjects. `assemble` and `reconcile` neither cache nor mutate
 * what they are handed, so a constant argument does the same work a fresh one
 * does — it just no longer builds inside the measured window. The delta used to
 * be `{ card: \`slice ${i}\` }`, charging prompt assembly for an interpolation.
 */
const stable: StablePrompt = {
  systemAppend: "system",
  model: "benchmark",
  tools: [],
  allowedTools: [],
  addDirs: [],
  hash: "stable",
};
const delta = { card: "slice 1", extra: "delta" };
const claim = {
  claims: [{ files: ["src/a.ts"], summary: "changed" }],
  changedFiles: ["src/a.ts", "test/a.test.ts"],
};
const watchdogDeps = {
  ctx,
  cfg,
  now: () => 1_000_000,
  pollUsage: async () => {},
  probe: async () => ({ online: true, changed: false }),
};

/**
 * A day of spans, shaped like a real one.
 *
 * 94% carry no scope, which is not padding: the watchdog, the HTTP server and the
 * retention trim belong to no project, and that skew is what makes the system scope
 * the expensive read. A fixed clock and a deterministic spread, so the budget fails
 * on the code rather than on the sample.
 */
const SPAN_ROWS = 90_000;
const SPAN_CLOCK = 1_700_000_000_000;
const SPAN_NAMES = [
  "turn",
  "sandbox.exec",
  "gate.run",
  "lease.run",
  "pr.poll",
  "index.ask",
  "git.tree_heads",
  "ctx.query",
  "ctx.assemble",
  "ctx.pageindex",
  ...Array.from({ length: 26 }, (_, rule) => `watchdog.rule_${rule}`),
];

/** One span row, as the column names rather than a positional tuple. */
function spanValues(row: number) {
  const scoped = row % 16 === 0 ? 1 : null;
  const root = row % 8 === 0;
  return {
    trace_id: String(Math.floor(row / 8)).padStart(32, "0"),
    span_id: String(row).padStart(16, "0"),
    parent_span_id: root ? null : String(row - 1).padStart(16, "0"),
    name: SPAN_NAMES[row % SPAN_NAMES.length]!,
    kind: "INTERNAL",
    started_at: SPAN_CLOCK - ((row * 937) % (24 * 60 * 60 * 1_000)),
    duration_ms: (row % 500) + 1,
    status: row % 50 === 0 ? "error" : "ok",
    project_id: scoped,
    grp_id: scoped,
    slice_id: scoped,
  };
}

async function seedSpans(rows: number): Promise<void> {
  // One statement, not one per row inside a transaction: `insert().values([])`
  // is what a bulk write looks like here, and the 65,535 bind-parameter ceiling
  // is what the chunk is for — twelve columns puts the limit near 5,400 rows.
  const values = Array.from({ length: rows }, (_, row) => spanValues(row));
  for (let at = 0; at < values.length; at += 1_000) {
    await db.insert(span).values(values.slice(at, at + 1_000));
  }
}

/** Rows present before any task runs. The scheduler cycle is rolled back to this. */
const [highest] = await db.select({ id: max(job.id) }).from(job);
const seededJobs = highest?.id ?? 0;

// 1ms when the database was in this process. Measured after the move: 35ms on a
// real Postgres and 54ms on the PGlite this runs against, for the same 19
// statements — the cost is nineteen round trips, not slower code. The number to
// watch is the query count above, which is pinned flat; this catches a twentieth.
limits.set("snapshot", 90);
bench.add("snapshot", async () => void (await snapshot(ctx)), { async: true });

limits.set("prompt assemble", 0.004);
bench.add("prompt assemble", () => assemble(stable, delta), { async: false });

limits.set("reconcile", 0.006);
bench.add("reconcile", () => reconcile(claim), { async: false });

// One full dispatch cycle. The 500 enqueues are the subject, not a batching
// trick: this guards dispatch throughput with a loaded queue, which a single
// enqueue would not show. The cycle leaves its jobs behind and the watchdog
// adds more, so the hook restores the row count the next cycle starts from.
// 400ms in-process. 500 enqueues are 500 round trips now, which is where the
// 1.8s goes — batching them is the fix if this ever matters, not a faster query.
limits.set("scheduler cycle x500", 2_600);
bench.add(
  "scheduler cycle x500",
  async () => {
    for (let i = 0; i < 500; i++) await scheduler.enqueue("agent_turn", { grp_id: (i % 50) + 1 });
    await scheduler.tick();
    await scheduler.drain();
  },
  { async: true, afterEach: async () => void (await db.delete(job).where(gt(job.id, seededJobs))) },
);

limits.set("watchdog tick", 60);
bench.add("watchdog tick", async () => void (await runWatchdog(watchdogDeps)), { async: true });

/**
 * The `System timing` report, at the volume one idle day produces.
 *
 * Five queries over the whole table. `system` scope because its predicate
 * (`project_id IS NULL AND grp_id IS NULL`) is the one no index can seek — indexes
 * were measured and do not help here, the sorting does. 739ms when this budget was
 * added, 281ms once the trace list and the stage table stopped sorting the whole
 * window, **176ms** on PostgreSQL; the ceiling sits above what a loaded machine
 * measures rather than a quiet one.
 */
await seedSpans(SPAN_ROWS);
const telemetryWindow = recentWindow(undefined, SPAN_CLOCK);
const telemetryScope = { kind: "system" } as const;
limits.set("telemetry report", 600);
bench.add(
  "telemetry report",
  // Awaited, every one. Unawaited these returned in 67µs against a 600ms budget —
  // the cost of building five promises — so the guard could not have gone red for
  // any regression at all. The panel awaits them in sequence; so does this.
  async () => {
    await spanExtent(db, telemetryScope);
    await stageStats(db, telemetryScope, telemetryWindow);
    await traceList(db, telemetryScope, 20, telemetryWindow);
    await trend(db, telemetryScope, 3_600_000, telemetryWindow);
    await foldedStacks(db, telemetryScope, telemetryWindow);
  },
  { async: true },
);

await bench.run();

console.table(bench.table());

const exceeded = bench.tasks.flatMap((task) => {
  const result = task.result;
  if (result.state !== "completed") throw new Error(`${task.name} did not complete: ${result.state}`);
  const limit = limits.get(task.name)!;
  const mean = result.latency.mean;
  console.log(`${task.name}: mean ${mean.toPrecision(3)}ms / ${limit}ms budget`);
  return mean > limit ? [`${task.name} (${mean.toPrecision(3)}ms > ${limit}ms)`] : [];
});

if (exceeded.length > 0) {
  throw new Error(`mean exceeded the significant-regression budget: ${exceeded.join(", ")}`);
}
