import { expect, test } from "bun:test";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import * as fx from "../support/factories.ts";
import {
  foldedStacks,
  type SpanRow,
  type ReadScope,
  sliceCosts,
  spanExtent,
  recentWindow,
  stageStats,
  traceList,
  trend,
  writeSpans,
} from "../../src/platform/observability/span-store.ts";

/**
 * The aggregation is SQL, so it is tested against SQLite rather than against a
 * reimplementation of it in the test.
 *
 * Spans go in through `writeSpans`, the production ingest, which is also why
 * there is no factory for this table: the scope columns are derived from
 * attributes on the way in, and a factory that set `project_id` directly would
 * let a broken derivation pass. Every scope assertion below therefore also
 * asserts that `project.id` and `grp.id` attributes still become columns.
 */

const NOW = 1_700_000_000_000;

/** A hex id of the right width, from a counter, so ids stay readable in failures. */
const traceId = (n: number) => String(n).padStart(32, "0");
const spanId = (n: number) => String(n).padStart(16, "0");

let next = 0;

function span(over: Partial<SpanRow> & { attributes: Record<string, unknown> }): SpanRow {
  next += 1;
  return {
    traceId: traceId(next),
    spanId: spanId(next),
    parentSpanId: null,
    name: "turn",
    kind: "internal",
    startedAt: NOW - 60_000,
    durationMs: 10,
    status: "ok",
    statusMessage: null,
    ...over,
  };
}

/** A scope's spans, all in one trace unless the caller says otherwise. */
function write(db: DB, rows: (Partial<SpanRow> & { attributes: Record<string, unknown> })[]): void {
  writeSpans(db, rows.map(span));
}

const inProject = { "project.id": 7, "grp.id": 3 };
const otherProject = { "project.id": 8, "grp.id": 4 };

test("a p95 is the p95, and a p50 is the p50", () => {
  const db = openMemory();
  // 99 samples of 1..99ms, and the count is the point. At 100 samples the
  // nearest rank divides exactly — ceil(50.0) and ceil(95.0) — so a rank that
  // rounded the wrong way would land on the same two values and this test would
  // pass over the bug. 99 puts both ranks on a fraction: p50 is ceil(49.5) = 50
  // and p95 is ceil(94.05) = 95, one sample away from what truncation gives.
  write(
    db,
    Array.from({ length: 99 }, (_, i) => ({
      name: "turn.provider",
      durationMs: i + 1,
      startedAt: NOW - 60_000 + i,
      attributes: inProject,
    })),
  );

  const [stage] = stageStats(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW));
  expect(stage?.name).toBe("turn.provider");
  expect(stage?.count).toBe(99);
  expect(stage?.p50).toBe(50);
  expect(stage?.p95).toBe(95);
  expect(stage?.totalMs).toBe(4950);
});

test("one sample is its own p50 and p95 rather than a null", () => {
  const db = openMemory();
  write(db, [{ name: "sandbox.create", durationMs: 4200, attributes: inProject }]);

  const [stage] = stageStats(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW));
  expect(stage?.p50).toBe(4200);
  expect(stage?.p95).toBe(4200);
});

test("a project's spans include the ones that only name its group", () => {
  // The defect that made the project panel look unbuilt. `turnScope` emits
  // `{ grpId, sliceId }` and no `projectId`, so `span.project_id` is NULL on
  // every stage span ever written; filtering on that column alone found nothing
  // and the view rendered its empty state.
  const db = openMemory();
  fx.project.insert(db, { name: "mine" });
  fx.project.insert(db, { name: "theirs" });
  fx.runningGrp.insert(db, { project_id: 1, name: "g1" });
  fx.runningGrp.insert(db, { project_id: 2, name: "g2" });
  write(db, [
    // What a turn actually writes: a group, no project.
    { name: "turn.provider", durationMs: 800, attributes: { "grp.id": 1 } },
    { name: "turn.provider", durationMs: 100, attributes: { "grp.id": 2 } },
    // And what an HTTP route writes, which does name the project.
    { name: "GET /api/v1/state", durationMs: 5, attributes: { "project.id": 1 } },
  ]);

  const mine = stageStats(db, { kind: "project", id: 1 }, recentWindow(600_000, NOW));
  expect(mine.map((s) => s.name).toSorted()).toEqual(["GET /api/v1/state", "turn.provider"]);
  expect(mine.find((s) => s.name === "turn.provider")?.totalMs).toBe(800);

  // The other project's group is still somebody else's time.
  const theirs = stageStats(db, { kind: "project", id: 2 }, recentWindow(600_000, NOW));
  expect(theirs.map((s) => s.name)).toEqual(["turn.provider"]);
  expect(theirs[0]?.totalMs).toBe(100);
});

test("a group with no project row does not fall into some other project", () => {
  const db = openMemory();
  fx.project.insert(db, { name: "mine" });
  // A span naming a group that no longer exists — retention outlives a delete,
  // which is why the scope columns are deliberately not foreign keys.
  write(db, [{ name: "turn", durationMs: 40, attributes: { "grp.id": 999 } }]);
  expect(stageStats(db, { kind: "project", id: 1 }, recentWindow(600_000, NOW))).toEqual([]);
});

test("a scope filter excludes another project's spans", () => {
  const db = openMemory();
  write(db, [
    { name: "turn", durationMs: 100, attributes: inProject },
    { name: "turn", durationMs: 900, attributes: otherProject },
  ]);

  const mine = stageStats(db, { kind: "project", id: 7 }, recentWindow(600_000, NOW));
  expect(mine).toHaveLength(1);
  expect(mine[0]?.count).toBe(1);
  expect(mine[0]?.totalMs).toBe(100);

  const theirs = stageStats(db, { kind: "project", id: 8 }, recentWindow(600_000, NOW));
  expect(theirs[0]?.totalMs).toBe(900);
});

test("a group scope excludes a sibling group inside the same project", () => {
  const db = openMemory();
  write(db, [
    { name: "turn", durationMs: 100, attributes: { "project.id": 7, "grp.id": 3 } },
    { name: "turn", durationMs: 900, attributes: { "project.id": 7, "grp.id": 5 } },
  ]);

  expect(stageStats(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW))[0]?.totalMs).toBe(100);
  expect(stageStats(db, { kind: "group", id: 5 }, recentWindow(600_000, NOW))[0]?.totalMs).toBe(900);
  // The project sees both, which is the point of having the two scopes.
  expect(stageStats(db, { kind: "project", id: 7 }, recentWindow(600_000, NOW))[0]?.count).toBe(2);
});

test("a span with no scope is counted in the system view and nowhere else", () => {
  const db = openMemory();
  write(db, [
    { name: "scheduler.tick", durationMs: 5, attributes: {} },
    { name: "turn", durationMs: 900, attributes: inProject },
  ]);

  const system = stageStats(db, { kind: "system" }, recentWindow(600_000, NOW));
  expect(system).toHaveLength(1);
  expect(system[0]?.name).toBe("scheduler.tick");

  // And the converse: the scoped span is absent from the system view, so the
  // three scopes partition the table rather than overlapping.
  expect(stageStats(db, { kind: "project", id: 7 }, recentWindow(600_000, NOW)).map((s) => s.name)).toEqual(["turn"]);
  expect(stageStats(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW)).map((s) => s.name)).toEqual(["turn"]);
});

test("a span carrying a group but no project is system work in neither view", () => {
  const db = openMemory();
  // `system` is both columns NULL, so a half-scoped span belongs to its group
  // and not to the host. This is the case a `project_id IS NULL` system filter
  // alone would have got wrong.
  write(db, [{ name: "job.reconcile", durationMs: 5, attributes: { "grp.id": 3 } }]);

  expect(stageStats(db, { kind: "system" }, recentWindow(600_000, NOW))).toHaveLength(0);
  expect(stageStats(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW))[0]?.name).toBe("job.reconcile");
});

test("errors are counted per stage without being dropped from the timing", () => {
  const db = openMemory();
  write(db, [
    { name: "turn.provider", durationMs: 10, attributes: inProject },
    { name: "turn.provider", durationMs: 30, status: "error", attributes: inProject },
  ]);

  const [stage] = stageStats(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW));
  expect(stage?.errors).toBe(1);
  expect(stage?.count).toBe(2);
  // A failed call still consumed its wall clock, and a timing view that hid it
  // would report the fleet as faster than it was.
  expect(stage?.totalMs).toBe(40);
});

test("the window excludes what is older than it", () => {
  const db = openMemory();
  write(db, [
    { name: "turn", durationMs: 10, startedAt: NOW - 30_000, attributes: inProject },
    { name: "turn", durationMs: 10, startedAt: NOW - 3 * 60 * 60 * 1_000, attributes: inProject },
  ]);

  expect(stageStats(db, { kind: "group", id: 3 }, recentWindow(60_000, NOW))[0]?.count).toBe(1);
  // And the other end is a bound too, which is what a brush needs: a window
  // ending before a span started excludes it, where a duration-from-now could
  // only ever move the start.
  expect(stageStats(db, { kind: "group", id: 3 }, { from: NOW - 60_000, to: NOW - 40_000 })).toEqual([]);
  expect(stageStats(db, { kind: "group", id: 3 }, recentWindow(24 * 60 * 60 * 1_000, NOW))[0]?.count).toBe(2);
});

test("stages are ordered by what they cost, so the expensive one reads first", () => {
  const db = openMemory();
  write(db, [
    { name: "turn.prepare", durationMs: 5, attributes: inProject },
    { name: "turn.provider", durationMs: 500, attributes: inProject },
    { name: "turn.checkpoint", durationMs: 50, attributes: inProject },
  ]);

  expect(stageStats(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW)).map((s) => s.name)).toEqual([
    "turn.provider",
    "turn.checkpoint",
    "turn.prepare",
  ]);
});

test("a trace's span is measured across the scope, not taken from a root", () => {
  const db = openMemory();
  // Deliberately parented, and deliberately overlapping: this is the real shape.
  // `turn` is parented to the job span that enqueued it, so nothing in this
  // scope has a NULL parent and a root-based measure would find nothing at all.
  writeSpans(db, [
    span({
      traceId: traceId(900),
      spanId: spanId(901),
      parentSpanId: spanId(999),
      name: "turn",
      startedAt: NOW - 10_000,
      durationMs: 8_000,
      attributes: inProject,
    }),
    span({
      traceId: traceId(900),
      spanId: spanId(902),
      parentSpanId: spanId(901),
      name: "turn.provider",
      startedAt: NOW - 9_000,
      durationMs: 6_000,
      attributes: inProject,
    }),
  ]);

  const [trace] = traceList(db, { kind: "group", id: 3 }, 20, recentWindow(600_000, NOW));
  expect(trace?.traceId).toBe(traceId(900));
  // Earliest start to latest end: 8s, not the 14s the two durations sum to.
  expect(trace?.durationMs).toBe(8_000);
  expect(trace?.startedAt).toBe(NOW - 10_000);
  // The earliest span names the trace.
  expect(trace?.name).toBe("turn");
  expect(trace?.failed).toBe(false);
});

test("a trace is failed when any span in it failed", () => {
  const db = openMemory();
  writeSpans(db, [
    span({ traceId: traceId(910), spanId: spanId(911), name: "turn", attributes: inProject }),
    span({ traceId: traceId(910), spanId: spanId(912), name: "turn.provider", status: "error", attributes: inProject }),
  ]);

  expect(traceList(db, { kind: "group", id: 3 }, 20, recentWindow(600_000, NOW))[0]?.failed).toBe(true);
});

test("traces come back newest first and no more than the limit", () => {
  const db = openMemory();
  writeSpans(
    db,
    Array.from({ length: 5 }, (_, i) =>
      span({
        traceId: traceId(920 + i),
        spanId: spanId(920 + i),
        startedAt: NOW - 50_000 + i * 1_000,
        attributes: inProject,
      }),
    ),
  );

  const traces = traceList(db, { kind: "group", id: 3 }, 3, recentWindow(600_000, NOW));
  expect(traces).toHaveLength(3);
  expect(traces.map((t) => t.startedAt)).toEqual([NOW - 46_000, NOW - 47_000, NOW - 48_000]);
});

test("the trend buckets by time and takes percentiles of whole traces", () => {
  const db = openMemory();
  const hour = 60 * 60 * 1_000;
  // Two buckets, ten traces each, durations 1..10ms and 101..110ms. One trace
  // per id, so a bucket's percentile is over units of work rather than spans.
  for (const [bucket, base] of [
    [2, 0],
    [1, 100],
  ] as const) {
    writeSpans(
      db,
      Array.from({ length: 10 }, (_, i) =>
        span({
          traceId: traceId(1_000 + bucket * 100 + i),
          spanId: spanId(1_000 + bucket * 100 + i),
          startedAt: NOW - bucket * hour,
          durationMs: base + i + 1,
          attributes: inProject,
        }),
      ),
    );
  }

  const points = trend(db, { kind: "group", id: 3 }, hour, recentWindow(6 * hour, NOW));
  expect(points).toHaveLength(2);
  expect(points.map((p) => p.count)).toEqual([10, 10]);
  // Ascending in time: the older, faster bucket first.
  expect(points[0]?.p50).toBe(5);
  expect(points[0]?.p95).toBe(10);
  expect(points[1]?.p50).toBe(105);
  expect(points[1]?.p95).toBe(110);
  // Each bucket is stamped with the millisecond it opens at, not an index.
  expect(points[0]!.at % hour).toBe(0);
  expect(points[1]!.at - points[0]!.at).toBe(hour);
});

test("a scope with nothing in it reports nothing rather than failing", () => {
  const db = openMemory();
  const empty: ReadScope = { kind: "project", id: 404 };
  expect(stageStats(db, empty, recentWindow(600_000, NOW))).toEqual([]);
  expect(traceList(db, empty, 20, recentWindow(600_000, NOW))).toEqual([]);
  expect(trend(db, empty, 60_000, recentWindow(600_000, NOW))).toEqual([]);
});

// ── folded stacks, the flamegraph's data ───────────────────────────────────

test("call paths are summed across every trace in the scope", () => {
  const db = openMemory();
  // The same shape twice, so the aggregate is the thing being checked rather
  // than one trace wearing a different name.
  for (const [t, root, child] of [
    [500, 501, 502],
    [510, 511, 512],
  ] as const) {
    writeSpans(db, [
      span({
        traceId: traceId(t),
        spanId: spanId(root),
        parentSpanId: null,
        name: "turn",
        durationMs: 100,
        attributes: inProject,
      }),
      span({
        traceId: traceId(t),
        spanId: spanId(child),
        parentSpanId: spanId(root),
        name: "turn.provider",
        durationMs: 80,
        attributes: inProject,
      }),
    ]);
  }

  expect(foldedStacks(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW))).toEqual([
    { path: "turn", totalMs: 200, count: 2 },
    { path: "turn;turn.provider", totalMs: 160, count: 2 },
  ]);
});

test("a root is a span whose parent is outside the scope, not one with no parent", () => {
  const db = openMemory();
  // The real shape: `startChildTrace` gives a job's span a remote parent, so a
  // requirement's own spans never have a NULL parent. Anchoring on NULL would
  // have returned nothing at all here.
  writeSpans(db, [
    span({
      traceId: traceId(520),
      spanId: spanId(521),
      parentSpanId: spanId(999),
      name: "turn",
      durationMs: 100,
      attributes: inProject,
    }),
    span({
      traceId: traceId(520),
      spanId: spanId(522),
      parentSpanId: spanId(521),
      name: "turn.provider",
      durationMs: 80,
      attributes: inProject,
    }),
  ]);

  expect(foldedStacks(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW)).map((row) => row.path)).toEqual([
    "turn",
    "turn;turn.provider",
  ]);
});

test("span ids are only unique within a trace, and the walk respects that", () => {
  const db = openMemory();
  // Two traces reusing the same span ids. A join on span id alone would graft
  // one trace's children onto the other's parent and invent a call path.
  for (const t of [530, 531]) {
    writeSpans(db, [
      span({ traceId: traceId(t), spanId: spanId(1), parentSpanId: null, name: `root${t}`, attributes: inProject }),
      span({ traceId: traceId(t), spanId: spanId(2), parentSpanId: spanId(1), name: "leaf", attributes: inProject }),
    ]);
  }

  const paths = foldedStacks(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW)).map((row) => row.path);
  expect(paths.toSorted()).toEqual(["root530", "root530;leaf", "root531", "root531;leaf"]);
});

test("the scope filter applies to the walk, not only to its roots", () => {
  const db = openMemory();
  writeSpans(db, [
    span({ traceId: traceId(540), spanId: spanId(541), parentSpanId: null, name: "turn", attributes: inProject }),
    span({
      traceId: traceId(540),
      spanId: spanId(542),
      parentSpanId: spanId(541),
      name: "mine",
      attributes: inProject,
    }),
    span({
      traceId: traceId(540),
      spanId: spanId(543),
      parentSpanId: spanId(541),
      name: "theirs",
      attributes: otherProject,
    }),
  ]);

  // One trace, two projects. A flamegraph that walked out of its scope would
  // put somebody else's time under this project's heading.
  expect(foldedStacks(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW)).map((row) => row.path)).toEqual([
    "turn",
    "turn;mine",
  ]);
});

test("a cycle in the parent ids terminates, and still counts what it cost", () => {
  const db = openMemory();
  writeSpans(db, [
    span({ traceId: traceId(550), spanId: spanId(551), parentSpanId: null, name: "root", attributes: inProject }),
    span({ traceId: traceId(550), spanId: spanId(552), parentSpanId: spanId(551), name: "a", attributes: inProject }),
    span({ traceId: traceId(550), spanId: spanId(553), parentSpanId: spanId(552), name: "b", attributes: inProject }),
  ]);
  // Close the loop: `a`'s parent becomes `b`, which is `a`'s own child. That
  // detaches both from the root, which is the only shape a cycle can take here —
  // one parent column plus a primary key on (trace_id, span_id) means a span has
  // at most one parent, so anything reachable from a root is a tree and a cycle
  // is always unreachable. The query cannot recurse forever; it can only fail to
  // reach these two.
  db.run("UPDATE span SET parent_span_id = ? WHERE span_id = ?", [spanId(553), spanId(552)]);

  const rows = foldedStacks(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW));

  // Three properties, and not an exact path: where a cycle "starts" is arbitrary
  // — there is no root to walk down from — so any ancestry this reports is a
  // choice rather than a fact, and pinning one would be asserting the
  // implementation instead of the guarantee.
  //
  // It terminates, it counts every span it was given, and no path repeats a name
  // — the last is the one that matters, because a walk without cycle detection
  // recurses to the depth cap and emits the ring sixty-four times.
  expect(rows.reduce((n, r) => n + r.count, 0)).toBe(3);
  expect(rows.some((r) => r.path === "root")).toBe(true);
  for (const row of rows) {
    const names = row.path.split(";");
    expect(new Set(names).size).toBe(names.length);
  }

  // Deliberately not "the cycle contributes nothing", which is what the query
  // this replaced did. Dropping a span because its ancestry is unknowable is the
  // same mechanism that silently lost 374 of 7,382 real rows on live data — a
  // span that happened and cost time belongs on the graph even when nothing can
  // say what it hung off.
});

test("a deep trace is walked, and the path names every level of it", () => {
  const db = openMemory();
  // Thirty levels, which is the depth the panel states an answer for. Well
  // inside MAX_STACK_DEPTH, so this is the walk working rather than the bound.
  writeSpans(
    db,
    Array.from({ length: 30 }, (_, i) =>
      span({
        traceId: traceId(560),
        spanId: spanId(600 + i),
        parentSpanId: i === 0 ? null : spanId(600 + i - 1),
        name: `level.${i}`,
        durationMs: 100 - i,
        attributes: inProject,
      }),
    ),
  );

  const rows = foldedStacks(db, { kind: "group", id: 3 }, recentWindow(600_000, NOW));
  expect(rows).toHaveLength(30);
  const deepest = rows.map((row) => row.path).toSorted((a, b) => b.length - a.length)[0];
  expect(deepest?.split(";")).toHaveLength(30);
  expect(deepest?.split(";").at(-1)).toBe("level.29");
});

test("a scope with nothing in it folds to nothing", () => {
  expect(foldedStacks(openMemory(), { kind: "system" }, recentWindow(600_000, NOW))).toEqual([]);
});

// ── a requirement, split by slice ──────────────────────────────────────────

test("a requirement's time is split by the slice that spent it", () => {
  const db = openMemory();
  write(db, [
    { name: "turn.provider", durationMs: 800, attributes: { "grp.id": 3, "slice.id": 1 } },
    { name: "turn.prepare", durationMs: 200, attributes: { "grp.id": 3, "slice.id": 1 } },
    { name: "turn.provider", durationMs: 5_000, status: "error", attributes: { "grp.id": 3, "slice.id": 2 } },
    // Planning: a turn of this requirement that belongs to no slice.
    { name: "turn", durationMs: 90, attributes: { "grp.id": 3 } },
    // Another requirement's slice 1, which must not be added to this one's.
    { name: "turn.provider", durationMs: 400, attributes: { "grp.id": 9, "slice.id": 1 } },
  ]);

  expect(sliceCosts(db, 3, recentWindow(600_000, NOW))).toEqual([
    { sliceId: 1, totalMs: 1_000, count: 2, errors: 0 },
    { sliceId: 2, totalMs: 5_000, count: 1, errors: 1 },
    // Unsliced work is a row and it sorts last. Dropping it would make the parts
    // add up to less than the requirement with nothing explaining the gap.
    { sliceId: null, totalMs: 90, count: 1, errors: 0 },
  ]);
});

test("a requirement that has run nothing splits into nothing", () => {
  expect(sliceCosts(openMemory(), 3, recentWindow(600_000, NOW))).toEqual([]);
});

test("the data extent is where the spans are, not where the query looked", () => {
  const db = openMemory();
  write(db, [
    { name: "turn", startedAt: NOW - 600_000, durationMs: 10, attributes: inProject },
    { name: "turn", startedAt: NOW - 120_000, durationMs: 5_000, attributes: inProject },
    { name: "turn", startedAt: NOW - 60_000, durationMs: 10, attributes: otherProject },
  ]);

  // The pair a chart clamps its pan and zoom against. It has to be the scope's
  // own rows: clamping to the requested window instead lets a pan walk into
  // stretches with nothing in them, where a blank chart cannot be told apart
  // from having scrolled off the end.
  const extent = spanExtent(db, { kind: "project", id: 7 }, NOW);
  expect(extent).toEqual({ from: NOW - 600_000, to: NOW - 120_000 + 5_000 });
  // The other project's span is later and is not in it.
  expect(extent!.to).toBeLessThan(NOW - 60_000);
});

test("a scope with no spans has no extent, which is not a window of zero width", () => {
  const db = openMemory();
  expect(spanExtent(db, { kind: "group", id: 3 }, NOW)).toBeNull();

  // And one span is widened to something a range can be clamped inside: `from`
  // and `to` equal is not a window anything fits in.
  write(db, [{ name: "turn", startedAt: NOW - 1_000, durationMs: 0, attributes: inProject }]);
  const one = spanExtent(db, { kind: "project", id: 7 }, NOW);
  expect(one!.to - one!.from).toBeGreaterThan(0);
});
