import { Bench } from "tinybench";
import { Bus } from "../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../src/platform/config/load.ts";
import { openMemory } from "../src/platform/persistence/database.ts";
import { snapshot } from "../src/api/panel/snapshot.ts";
import { costReport } from "../src/mech/ops/cost.ts";
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
import { eq, gt, max } from "drizzle-orm";
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
 * user-facing latency tail. A tail percentile over a sixteen-sample task is close
 * to its maximum, so a budget there would be a budget on whichever GC pause it
 * caught. Each limit is the old whole-batch budget divided by the batch it
 * covered.
 */
/**
 * Which of these may fail the job, and it is not the ones that touch a database.
 *
 * A millisecond on a shared runner measures somebody else's machine: this job
 * failed at 624ms against 600 and was green the next night unchanged, and while
 * this was being written the same commit measured 250ms on a quiet laptop and
 * 922ms on a busy one. The statement counts underneath were 19, 37 and 6 in all
 * three.
 */
/** So work that talks to the database is gated by `statementBudget` and its time
 *  is printed for a person to read. What still gates on time is the pure-CPU pair,
 *  where the budget sits 25x to 65x above the measurement and no load this side of
 *  a swap storm reaches it — and where a statement count would see nothing. */
const TIMED_GATE = new Set(["prompt assemble", "reconcile"]);
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
// One group in the merge queue. With an empty queue the panel's queue read stops
// at "nobody is waiting" and the place lookup never runs — so the statements this
// budget exists to hold flat were the ones it was not measuring.
await db.update(grp).set({ status: "PR_OPEN", merge_seq: 1, merge_seq_at: 0, pr_number: 1 }).where(eq(grp.id, 1));
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
const runSnapshot = async () => void (await snapshot(ctx));
bench.add("snapshot", runSnapshot, { async: true });

/**
 * The other half of a panel refresh, and it had no budget at all.
 *
 * `web/src/shared/api.ts` invalidates `ORCH` on every `state_change` frame, so
 * this runs beside `snapshot` at up to four times a second — the same rate, the
 * same reason to pin its query count. `event` holds fifty rows here, so the
 * milliseconds say nothing about a loaded installation; the statement count is
 * the number this can gate on, exactly as it is for `snapshot`.
 */
limits.set("cost report", 90);
const runCostReport = async () => void (await costReport(db));
bench.add("cost report", runCostReport, { async: true });

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
const runSchedulerCycle = async () => {
  for (let i = 0; i < 500; i++) await scheduler.enqueue("agent_turn", { grp_id: (i % 50) + 1 });
  await scheduler.tick();
  await scheduler.drain();
};
const clearJobs = async () => void (await db.delete(job).where(gt(job.id, seededJobs)));
bench.add("scheduler cycle x500", runSchedulerCycle, { async: true, afterEach: clearJobs });

limits.set("watchdog tick", 60);
const runWatchdogTick = async () => void (await runWatchdog(watchdogDeps));
bench.add("watchdog tick", runWatchdogTick, { async: true });

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
// Awaited, every one. Unawaited these returned in 67µs against a 600ms budget —
// the cost of building five promises — so the guard could not have gone red for
// any regression at all. The panel awaits them in sequence; so does this.
const runTelemetryReport = async () => {
  await spanExtent(db, telemetryScope);
  await stageStats(db, telemetryScope, telemetryWindow);
  await traceList(db, telemetryScope, 20, telemetryWindow);
  await trend(db, telemetryScope, 3_600_000, telemetryWindow);
  await foldedStacks(db, telemetryScope, telemetryWindow);
};
bench.add("telemetry report", runTelemetryReport, { async: true });

/**
 * What each unit of work costs in **statements**, which is the number this job
 * can actually gate on.
 *
 * A millisecond budget on a GitHub runner is a budget on somebody else's
 * machine: this job failed on `telemetry report` at 624ms against 600 and was
 * green the next night with nothing changed, while the same commit measures
 * 250ms on a laptop. The budgets above are still useful as a *shape* — an added
 * pass moves the whole distribution — but they cannot be the gate.
 */
/** The query count can be, and the file already had one instance of the idea: the
 *  snapshot N+1 check above, which compares one group against fifty and is right
 *  on any hardware. These are the same thing for the rest of the work. An added
 *  query is exactly the regression these budgets were written to catch. */
const statements = new Map<string, () => Promise<void>>([
  ["snapshot", runSnapshot],
  ["cost report", runCostReport],
  ["watchdog tick", runWatchdogTick],
  ["telemetry report", runTelemetryReport],
  ["scheduler cycle x500", async () => (await runSchedulerCycle(), await clearJobs())],
]);

/**
 * Measured twice, then pinned. A change here is a decision, not a coin flip.
 *
 * Four are exact — 19, 6, 37 and 6, identical across runs — and the batch is not:
 * 500 enqueues and a drain measured 2250 and 2249, so it gets a ceiling. The
 * ceiling is what catches the regression this is for, one more query per job,
 * which would land at 2750.
 */
/**
 * The batch was 3427 until the admission check stopped asking four questions per
 * pending turn, and `cost report` was 11 until its statements stopped waiting on
 * each other. `snapshot` measures 19 with a group in the merge queue and measured
 * 21 there before the queue was read once instead of three times — the budget
 * that was already written down is what would have caught it.
 */
const statementBudget = new Map<string, number>([
  ["snapshot", 19],
  ["cost report", 6],
  ["watchdog tick", 37],
  ["telemetry report", 6],
  ["scheduler cycle x500", 2_300],
]);

async function countStatements(): Promise<string[]> {
  const over: string[] = [];
  for (const [name, run] of statements) {
    queries = 0;
    await run();
    const verdict = statementVerdict(name, queries);
    if (verdict) over.push(verdict);
  }
  return over;
}

/** Prints what it measured either way; returns text only when it is over. */
function statementVerdict(name: string, count: number): string | null {
  const budget = statementBudget.get(name);
  console.log(`${name}: ${count} statements${budget === undefined ? "" : ` / ${budget} budget`}`);
  return budget !== undefined && count > budget ? `${name} (${count} statements > ${budget})` : null;
}

/**
 * One task's mean against its guide. Text when it may fail the job, null when it
 * is over and the gate for it is elsewhere — which is said out loud, because a
 * measurement that drifts without failing is still something to look at.
 */
function timeVerdict(task: (typeof bench.tasks)[number]): string | null {
  const result = task.result;
  if (result.state !== "completed") throw new Error(`${task.name} did not complete: ${result.state}`);
  const limit = limits.get(task.name)!;
  const mean = result.latency.mean;
  console.log(`${task.name}: mean ${mean.toPrecision(3)}ms / ${limit}ms budget`);
  if (mean <= limit) return null;
  if (TIMED_GATE.has(task.name)) return `${mean.toPrecision(3)}ms > ${limit}ms`;
  console.warn(`${task.name} is over its ${limit}ms guide — the gate for it is its statement count`);
  return null;
}

/** One pass: run every task, print the means, and name the ones over budget. */
async function pass(): Promise<Map<string, string>> {
  await bench.run();
  console.table(bench.table());
  const over = new Map<string, string>();
  for (const task of bench.tasks) {
    const verdict = timeVerdict(task);
    if (verdict) over.set(task.name, verdict);
  }
  return over;
}

/**
 * Twice before it is a regression, and the reason is the runner.
 *
 * These budgets are means of sixteen samples on hardware nobody controls, so one
 * pass is a coin flip near the line: the nightly failed on `telemetry report` at
 * 624ms against 600 — four percent — and the next night was green with nothing
 * changed. Raising the number only moves the flip.
 */
/** A real regression is in both passes. A flake is in one, and says so out loud
 *  rather than passing in silence, because a budget quietly sitting near its line
 *  is a budget somebody should look at. */
let exceeded = await pass();
if (exceeded.size > 0) {
  console.warn(`over budget on the first pass: ${[...exceeded.keys()].join(", ")} — repeating before calling it`);
  const again = await pass();
  // Rebuilt rather than mutated while iterating: only the names in both passes
  // survive, and each keeps what it measured on either.
  exceeded = new Map(
    [...exceeded].flatMap(([name, first]) => {
      const second = again.get(name);
      if (second) return [[name, `${first} then ${second}`] as const];
      console.warn(`${name} was under budget on the second pass: noise, not a regression`);
      return [];
    }),
  );
}

// After the timings, because it runs the same work once more and the bench has
// its own warm-up: a counter does not care, and a mean does.
const overStatements = await countStatements();

const failures = [...overStatements, ...[...exceeded].map(([name, detail]) => `${name} (${detail}, both passes)`)];
if (failures.length > 0) {
  throw new Error(`over budget: ${failures.join(", ")}`);
}
