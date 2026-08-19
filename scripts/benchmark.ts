import { Bench } from "tinybench";
import { Bus } from "../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../src/platform/config/load.ts";
import { openMemory, type DB } from "../src/platform/persistence/database.ts";
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
import type { Ctx } from "../src/mech/ctx.ts";

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

const db = openMemory();
const cfg = loadConfig();
const bus = new Bus(db);
const scheduler = new Scheduler(db, async () => {}, { maxGroups: 1_000 });
const ctx: Ctx = { db, bus, sched: scheduler, waiters: new Map(), config: cfg };

db.run("INSERT INTO project (name, repo_path, base_branch, created_at) VALUES ('bench', 'acme/bench', 'main', 0)");
db.run("INSERT INTO runtime_auth (runtime, mode, secret, updated_at) VALUES ('claude', 'api_key', 'bench-secret', 0)");

function seedGroup(index: number): void {
  const group = db
    .query<{ id: number }, [string, string]>(
      "INSERT INTO grp (project_id, name, branch, status, created_at) VALUES (1, ?, ?, 'RUNNING', 0) RETURNING id",
    )
    .get(`bench-${index}`, `orch/bench-${index}`)!;
  const slice = db
    .query<{ id: number }, [number, string]>(
      "INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at) VALUES (?, 1, ?, 'passes', 'running', 0) RETURNING id",
    )
    .get(group.id, `slice-${index}`)!;
  const agent = db
    .query<{ id: number }, [number, string]>(
      "INSERT INTO agent (project_id, grp_id, role, model, runtime, created_at) VALUES (1, ?, 'engineer', ?, 'claude', 0) RETURNING id",
    )
    .get(group.id, `model-${index % 3}`)!;
  const channel = db
    .query<{ id: number }, [number]>(
      "INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (1, ?, 'group', 0) RETURNING id",
    )
    .get(group.id)!;
  db.run("INSERT INTO task (grp_id, slice_id, title, status, created_at) VALUES (?, ?, 'work', 'pending', 0)", [
    group.id,
    slice.id,
  ]);
  db.run(
    "INSERT INTO event (channel_id, grp_id, author, kind, body, at) VALUES (?, ?, 'engineer', 'say', 'working', 0)",
    [channel.id, group.id],
  );
  db.run(
    "INSERT INTO job (kind, grp_id, agent_id, slice_id, payload_json, state, enqueued_at, ended_at) VALUES ('agent_turn', ?, ?, ?, '{}', 'done', 0, 1)",
    [group.id, agent.id, slice.id],
  );
}

function snapshotQueries(): number {
  let queries = 0;
  const counted = new Proxy(db, {
    get(target, property) {
      if (property !== "query") throw new Error(`snapshot accessed unsupported database member ${String(property)}`);
      return (...args: Parameters<DB["query"]>) => {
        queries += 1;
        return target.query(...args);
      };
    },
  });
  snapshot({ ...ctx, db: counted });
  return queries;
}

seedGroup(1);
const oneGroupQueries = snapshotQueries();
for (let i = 2; i <= 50; i++) seedGroup(i);
const fiftyGroupQueries = snapshotQueries();
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

type SpanRow = [
  string,
  string,
  string | null,
  string,
  number,
  number,
  string,
  number | null,
  number | null,
  number | null,
];

/** One row's worth of shape, so the loop that writes 90,000 of them is a loop. */
function spanRow(row: number): SpanRow {
  const scoped = row % 16 === 0 ? 1 : null;
  const root = row % 8 === 0;
  return [
    String(Math.floor(row / 8)).padStart(32, "0"),
    String(row).padStart(16, "0"),
    root ? null : String(row - 1).padStart(16, "0"),
    SPAN_NAMES[row % SPAN_NAMES.length]!,
    SPAN_CLOCK - ((row * 937) % (24 * 60 * 60 * 1_000)),
    (row % 500) + 1,
    row % 50 === 0 ? "error" : "ok",
    scoped,
    scoped,
    scoped,
  ];
}

function seedSpans(rows: number): void {
  const insert = db.prepare<unknown, SpanRow>(
    `INSERT INTO span (trace_id, span_id, parent_span_id, name, kind, started_at, duration_ms, status,
                       attributes_json, project_id, grp_id, slice_id)
     VALUES (?, ?, ?, ?, 'INTERNAL', ?, ?, ?, '{}', ?, ?, ?)`,
  );
  db.run("BEGIN");
  for (let row = 0; row < rows; row++) insert.run(...spanRow(row));
  db.run("COMMIT");
}

/** Rows present before any task runs. The scheduler cycle is rolled back to this. */
const seededJobs = db.query<{ id: number }, []>("SELECT COALESCE(MAX(id), 0) AS id FROM job").get()!.id;

limits.set("snapshot", 1);
bench.add("snapshot", () => snapshot(ctx), { async: false });

limits.set("prompt assemble", 0.004);
bench.add("prompt assemble", () => assemble(stable, delta), { async: false });

limits.set("reconcile", 0.006);
bench.add("reconcile", () => reconcile(claim), { async: false });

// One full dispatch cycle. The 500 enqueues are the subject, not a batching
// trick: this guards dispatch throughput with a loaded queue, which a single
// enqueue would not show. The cycle leaves its jobs behind and the watchdog
// adds more, so the hook restores the row count the next cycle starts from.
limits.set("scheduler cycle x500", 400);
bench.add(
  "scheduler cycle x500",
  async () => {
    for (let i = 0; i < 500; i++) scheduler.enqueue("agent_turn", { grp_id: (i % 50) + 1 });
    scheduler.tick();
    await scheduler.drain();
  },
  { async: true, afterEach: () => void db.run("DELETE FROM job WHERE id > ?", [seededJobs]) },
);

limits.set("watchdog tick", 60);
bench.add("watchdog tick", async () => void (await runWatchdog(watchdogDeps)), { async: true });

/**
 * The 系统耗时 report, at the volume one idle day produces.
 *
 * Five queries over the whole table, synchronous, so while it computes it blocks
 * every request and the SSE heartbeat. `system` scope because its predicate
 * (`project_id IS NULL AND grp_id IS NULL`) is the one no index can seek — indexes
 * were measured and do not help here, the sorting does. 739ms when this budget was
 * added, 281ms once the trace list and the stage table stopped sorting the whole
 * window; and the ceiling sits above what a loaded machine measures rather than a quiet one.
 */
seedSpans(SPAN_ROWS);
const telemetryWindow = recentWindow(undefined, SPAN_CLOCK);
const telemetryScope = { kind: "system" } as const;
limits.set("telemetry report", 600);
bench.add(
  "telemetry report",
  () => {
    spanExtent(db, telemetryScope);
    stageStats(db, telemetryScope, telemetryWindow);
    traceList(db, telemetryScope, 20, telemetryWindow);
    trend(db, telemetryScope, 3_600_000, telemetryWindow);
    foldedStacks(db, telemetryScope, telemetryWindow);
  },
  { async: false },
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

db.close();

if (exceeded.length > 0) {
  throw new Error(`mean exceeded the significant-regression budget: ${exceeded.join(", ")}`);
}
