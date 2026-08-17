import { expect, test } from "bun:test";
import type { Stage } from "../../web/src/shared/api.ts";
import {
  flameDepth,
  flameTree,
  hasSpans,
  humanName,
  isRenamed,
  draggedWindow,
  bucketFor,
  fillBuckets,
  groupByKind,
  panBy,
  wheelPixels,
  wheelScale,
  panTo,
  zoomAt,
  spanKind,
  splitStages,
  verdict,
  trendLabel,
} from "../../web/src/features/telemetry/model.ts";
import { duration } from "../../web/src/shared/format.ts";

/**
 * The shaping, without a browser.
 *
 * These are the functions the waterfall is made of, and the reason they are
 * functions: "a child that starts late is drawn further right" and "a span whose
 * parent is missing is still drawn" are claims about numbers, and a render test
 * asserting them would be measuring CSS instead.
 */

const T0 = 1_700_000_000_000;

const stage = (over: Partial<Stage> & { name: string }): Stage => ({
  count: 1,
  totalMs: 100,
  p50: 100,
  p95: 100,
  errors: 0,
  ...over,
});

test("stages split at their own largest gap, and only when there is one", () => {
  const split = splitStages([
    stage({ name: "provider", p95: 8_000 }),
    stage({ name: "checkpoint", p95: 4_000 }),
    stage({ name: "prepare", p95: 12 }),
    stage({ name: "settle", p95: 4 }),
  ]);
  // The fourfold step is between 4,000ms and 12ms, not between the two fast ones.
  expect(split.slow.map((s) => s.name)).toEqual(["provider", "checkpoint"]);
  expect(split.fast.map((s) => s.name)).toEqual(["prepare", "settle"]);
  expect(split.ceiling).toBe(12);
});

test("a list with no gap is a list, and is not folded", () => {
  // Every stage within a factor of four of its neighbour is genuinely comparable
  // rows; folding part of it would invent a distinction the numbers do not make.
  const split = splitStages([
    stage({ name: "a", p95: 100 }),
    stage({ name: "b", p95: 60 }),
    stage({ name: "c", p95: 40 }),
  ]);
  expect(split.fast).toEqual([]);
  expect(split.slow).toHaveLength(3);
  expect(split.ceiling).toBe(0);
});

test("one row is never folded away, because that saves nothing", () => {
  const split = splitStages([stage({ name: "slow", p95: 9_000 }), stage({ name: "fast", p95: 1 })]);
  expect(split.fast).toEqual([]);
  expect(split.slow).toHaveLength(2);
});

test("a stage list that is all sub-millisecond folds to a ceiling of zero", () => {
  // The view has to spell this one as "都不到 1ms" rather than quoting a
  // ceiling, because `duration(0)` is "0ms" and "都在 0ms 以内" reads as broken.
  const split = splitStages([
    stage({ name: "slow", p95: 900 }),
    stage({ name: "a", p95: 0 }),
    stage({ name: "b", p95: 0 }),
    stage({ name: "c", p95: 0 }),
  ]);
  expect(split.slow.map((s) => s.name)).toEqual(["slow"]);
  expect(split.fast).toHaveLength(3);
  expect(split.ceiling).toBe(0);
});

test("splitting an empty list is empty rather than an error", () => {
  const split = splitStages([]);
  expect(split.slow).toEqual([]);
  expect(split.fast).toEqual([]);
  expect(split.ceiling).toBe(0);
});

test("the fold reproduces the shape it was written for", () => {
  // Two stages in seconds and nine under 6ms: the case the redesign started
  // from. The 6ms in the sentence is read off the data, not written into it.
  const split = splitStages([
    stage({ name: "turn.provider", p95: 4_900 }),
    stage({ name: "sandbox.create", p95: 4_500 }),
    ...Array.from({ length: 9 }, (_, i) => stage({ name: `GET /api/v1/${i}`, p95: 6 - i * 0.5 })),
  ]);
  expect(split.slow.map((s) => s.name)).toEqual(["turn.provider", "sandbox.create"]);
  expect(split.fast).toHaveLength(9);
  expect(duration(split.ceiling)).toBe("6ms");
});

test("a scope has something to draw when it has either stages or traces", () => {
  expect(hasSpans([], [])).toBe(false);
  expect(hasSpans([stage({ name: "turn" })], [])).toBe(true);
  expect(hasSpans([], [{ traceId: "a", name: "turn", startedAt: T0, durationMs: 1, failed: false }])).toBe(true);
});

test("the trend axis reads as hours inside two days and as dates beyond", () => {
  const day = 24 * 60 * 60 * 1_000;
  expect(trendLabel(new Date(2026, 7, 17, 9, 0).getTime(), day)).toBe("09:00");
  expect(trendLabel(new Date(2026, 7, 17, 9, 0).getTime(), 7 * day)).toBe("8/17");
});

test("a duration is printed in the coarsest unit that keeps its meaning", () => {
  expect(duration(0)).toBe("0ms");
  expect(duration(4)).toBe("4ms");
  expect(duration(999)).toBe("999ms");
  expect(duration(1_000)).toBe("1.0s");
  expect(duration(59_940)).toBe("59.9s");
  expect(duration(60_000)).toBe("1m00s");
  expect(duration(192_400)).toBe("3m12s");
  // A missing or impossible measurement says so rather than printing "NaNms".
  expect(duration(Number.NaN)).toBe("—");
  expect(duration(-1)).toBe("—");
});

// ── the bar chart's rows ────────────────────────────────────────────────────

test("folded stacks become a tree, and a shared prefix becomes one node", () => {
  const tree = flameTree([
    { path: "turn", totalMs: 9_000, count: 2 },
    { path: "turn;turn.prepare", totalMs: 200, count: 2 },
    { path: "turn;turn.provider", totalMs: 8_000, count: 2 },
  ]);
  expect(tree.children).toHaveLength(1);
  const turn = tree.children?.[0];
  expect(turn?.name).toBe("turn");
  expect(turn?.value).toBe(9_000);
  expect(turn?.children?.map((c) => c.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
    "turn.prepare",
    "turn.provider",
  ]);
  expect(turn?.children?.find((c) => c.name === "turn.provider")?.value).toBe(8_000);
});

test("two parents' identically named children stay apart", () => {
  // Keyed on the full path, not the frame name: merging these would attribute
  // one stage's time to another that happens to call something with the name.
  const tree = flameTree([
    { path: "a;work", totalMs: 10, count: 1 },
    { path: "b;work", totalMs: 90, count: 1 },
  ]);
  const values = (tree.children ?? []).map((child) => child.children?.[0]?.value);
  expect(values.toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([10, 90]);
});

test("the root spans what it holds rather than sitting at zero", () => {
  // A zero-width root is the whole chart hanging off a frame with no width.
  const tree = flameTree([
    { path: "a", totalMs: 30, count: 1 },
    { path: "b", totalMs: 70, count: 1 },
  ]);
  expect(tree.value).toBe(100);
});

test("an ancestor is not counted again by its descendants' rows", () => {
  const tree = flameTree([
    { path: "a", totalMs: 100, count: 1 },
    { path: "a;b", totalMs: 60, count: 1 },
    { path: "a;b;c", totalMs: 20, count: 1 },
  ]);
  const a = tree.children?.[0];
  expect(a?.value).toBe(100);
  expect(a?.children?.[0]?.value).toBe(60);
  expect(a?.children?.[0]?.children?.[0]?.value).toBe(20);
});

test("an empty scope makes an empty tree rather than throwing", () => {
  const tree = flameTree([]);
  expect(tree.value).toBe(0);
  expect(tree.children).toEqual([]);
  expect(flameDepth(tree)).toBe(1);
});

test("the tree's depth is what sizes the block", () => {
  expect(flameDepth(flameTree([{ path: "a;b;c", totalMs: 1, count: 1 }]))).toBe(4);
  const deep = flameTree([{ path: Array.from({ length: 30 }, (_, i) => `l${i}`).join(";"), totalMs: 1, count: 1 }]);
  // Thirty levels plus the synthetic root, and no cap: a flamegraph grows in
  // height, never in width, so depth costs rows rather than overflow.
  expect(flameDepth(deep)).toBe(31);
});

// ── the verdict line ───────────────────────────────────────────────────────

test("a real gap names the slow stages it has words for", () => {
  const answer = verdict(
    splitStages([
      stage({ name: "sandbox.create", p95: 9_000 }),
      stage({ name: "turn.prepare", p95: 10 }),
      stage({ name: "turn.provider", p95: 8 }),
    ]),
  );
  expect(answer).toEqual({ kind: "slow", names: ["sandbox.create"], unnamed: 0, more: 0 });
});

test("unmapped identifiers are counted, never pasted into the sentence", () => {
  // Half a translated sentence is worse than none: 「更新代码索引、git.ls_tree」
  // reads as two different kinds of thing, and the reader cannot tell which is
  // a stage and which is a leak.
  const answer = verdict(
    splitStages([
      stage({ name: "sandbox.create", p95: 9_000 }),
      stage({ name: "git.ls_tree", p95: 8_000 }),
      stage({ name: "watchdog.7e", p95: 7_000 }),
      stage({ name: "turn.prepare", p95: 5 }),
      stage({ name: "turn.provider", p95: 4 }),
    ]),
  );
  expect(answer).toEqual({ kind: "slow", names: ["sandbox.create"], unnamed: 2, more: 0 });
});

test("a long list is two names and a count, not seven names", () => {
  // Seven things in one sentence is a list, and the table underneath already is
  // one. The sentence exists to be read instead of the table.
  const slow = ["sandbox.create", "sandbox.init", "turn.provider", "turn.prepare", "turn.checkpoint"];
  const answer = verdict(
    splitStages([
      ...slow.map((name, i) => stage({ name, p95: 9_000 - i })),
      stage({ name: "job watchdog", p95: 3 }),
      stage({ name: "watchdog.repo_map", p95: 2 }),
    ]),
  );
  expect(answer && "names" in answer && answer.names).toHaveLength(2);
  expect(answer).toMatchObject({ kind: "slow", unnamed: 0, more: 3 });
});

test("no gap states the leader as a fact rather than asserting flatness", () => {
  // The shipped bug: this branch used to return 「各阶段耗时接近，没有特别慢的。」
  // `splitStages` cuts at the largest *adjacent* ratio, so a smooth ramp folds
  // nothing while still being a fivefold spread end to end — and the page
  // asserted an absence its own table contradicted one row below.
  const answer = verdict(
    splitStages([
      stage({ name: "sandbox.create", p95: 41_900 }),
      stage({ name: "job.watchdog", p95: 26_000 }),
      stage({ name: "GET /api/v1/auth/github", p95: 14_000 }),
      stage({ name: "watchdog.repo_map", p95: 8_700 }),
    ]),
  );
  expect(answer).toEqual({ kind: "lead", name: "sandbox.create", p95: 41_900, ratio: 41_900 / 26_000 });
});

test("a genuine tie says nothing at all", () => {
  // "If you cannot state a fact, render nothing." 「是第二名的 1.0 倍」 is noise
  // wearing the shape of a result.
  expect(verdict(splitStages([stage({ name: "a", p95: 100 }), stage({ name: "b", p95: 98 })]))).toBeNull();
});

test("one stage is not a ranking", () => {
  expect(verdict(splitStages([stage({ name: "only", p95: 100 })]))).toBeNull();
  expect(verdict(splitStages([]))).toBeNull();
});

test("a second place at zero is reported as a gap, not as an infinite ratio", () => {
  const answer = verdict(
    splitStages([stage({ name: "a", p95: 500 }), stage({ name: "b", p95: 0 }), stage({ name: "c", p95: 0 })]),
  );
  // Whichever branch it takes, it must not produce a ratio nobody can read.
  expect(answer).not.toBeNull();
  expect(answer && "ratio" in answer ? Number.isFinite(answer.ratio) : true).toBe(true);
});

test("the verdict never contradicts the rows it sits above", () => {
  // The property the shipped bug violated, over the shapes that reach it.
  const shapes = [
    [stage({ name: "a", p95: 9_000 }), stage({ name: "b", p95: 10 })],
    [stage({ name: "a", p95: 41_900 }), stage({ name: "b", p95: 26_000 }), stage({ name: "c", p95: 8_700 })],
    [stage({ name: "a", p95: 100 }), stage({ name: "b", p95: 99 })],
    [stage({ name: "a", p95: 0 }), stage({ name: "b", p95: 0 })],
  ];
  for (const stages of shapes) {
    const split = splitStages(stages);
    const answer = verdict(split);
    if (answer?.kind === "lead") {
      // The number it quotes is the top row's, and the multiple is real.
      expect(answer.p95).toBe(split.slow[0]!.p95);
      expect(answer.ratio).toBeGreaterThanOrEqual(1.15);
    }
    if (answer?.kind === "slow") {
      // It names exactly the rows that stayed above the fold.
      expect(answer.names).toEqual(split.slow.map((s) => s.name));
    }
  }
});

// ── the names the reader sees ──────────────────────────────────────────────

test("a known span name reads as what it is", () => {
  expect(humanName("sandbox.create")).toBe("开一个新环境");
  expect(humanName("turn.provider")).toBe("模型在想");
  expect(humanName("watchdog.repo_map")).toBe("更新代码索引");
  expect(humanName("GET /api/v1/auth/github")).toBe("连 GitHub");
});

test("an unmapped name falls through to itself, never to nothing", () => {
  // The property that matters: the set of span names grows every time somebody
  // adds a stage, and a missing entry has to leave a name the reader can still
  // search for rather than a blank row or an invented sentence.
  for (const id of ["turn.settle", "watchdog.7e", "POST /api/v1/ideas", "brand.new.stage", ""]) {
    expect(humanName(id)).toBe(id);
    expect(isRenamed(id)).toBe(false);
  }
});

test("a span's kind comes from its own prefix, so a new name needs no code change", () => {
  // Six span families landed in one afternoon. A hardcoded list would have
  // dropped each of them into nothing or into the wrong pile.
  expect(spanKind("watchdog.repo_map").label).toBe("巡检规则");
  expect(spanKind("sandbox.exec").label).toBe("容器操作");
  expect(spanKind("git.ls_tree").label).toBe("代码仓库");
  expect(spanKind("GET /api/v1/auth/github").label).toBe("接口请求");
  expect(spanKind("POST /api/v1/ideas").label).toBe("接口请求");
});

test("a prefix nobody has named becomes its own group, not a dumping ground", () => {
  // `pr.poll` and `lease.run` are named; something invented tomorrow is not, and
  // it still has to be findable as itself rather than swept into 其他.
  expect(spanKind("pr.poll").label).toBe("合并请求");
  expect(spanKind("brandnew.thing")).toEqual({ key: "brandnew", label: "brandnew" });
  // Only a name with no prefix at all falls back.
  expect(spanKind("standalone")).toEqual({ key: "other", label: "其他" });
});

test("groups carry their own total, so a shut one still answers the question", () => {
  const rows = [
    ...Array.from({ length: 24 }, (_, i) => ({ name: `watchdog.r${i}`, totalMs: 50, errors: 0 })),
    { name: "sandbox.create", totalMs: 9_000, errors: 1 },
    { name: "GET /api/v1/state", totalMs: 12, errors: 0 },
  ];
  const groups = groupByKind(rows);

  // Costliest first, and 24 rules are one line rather than twenty-four.
  expect(groups.map((g) => g.label)).toEqual(["容器操作", "巡检规则", "接口请求"]);
  const watchdog = groups.find((g) => g.key === "watchdog")!;
  expect(watchdog.count).toBe(24);
  expect(watchdog.totalMs).toBe(1_200);
  expect(watchdog.rows).toHaveLength(24);
  expect(groups.find((g) => g.key === "sandbox")?.errors).toBe(1);
});

test("grouping nothing is nothing", () => {
  expect(groupByKind([])).toEqual([]);
});

// ── what a drag means ──────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

test("dragging from the first bucket changes nothing", () => {
  // "All of it" is the window the caller already asked for, so there is nothing
  // to override — and `null` says that, where a number would say "no time".
  expect(draggedWindow(NOW - 3_600_000, 0, NOW)).toBeNull();
});

test("dragging from a later bucket scopes back to it", () => {
  expect(draggedWindow(NOW - 3 * 3_600_000, 2, NOW)).toBe(3 * 3_600_000);
});

test("a bucket that is not there is not a window", () => {
  expect(draggedWindow(undefined, 4, NOW)).toBeNull();
});

test("a drag narrower than a minute is a drag nobody meant", () => {
  // The buckets are hours, so anything under a minute is a stray pointer rather
  // than a range, and clamping keeps the re-read from asking for nothing.
  expect(draggedWindow(NOW - 200, 3, NOW)).toBe(60_000);
});

// ── zooming around the pointer ─────────────────────────────────────────────

/** An hour of data, in milliseconds, so the 1s floor is not in the way. */
const LIMIT = { from: 0, to: 3_600_000 };

test("the instant under the pointer stays under the pointer", () => {
  // The whole property. Every profiler does this, and the reason is that
  // zooming to the centre moves the frame you were aiming at.
  for (const at of [0, 0.25, 0.5, 0.75, 1]) {
    const before = { from: 200_000, to: 600_000 };
    const anchored = before.from + at * (before.to - before.from);
    const after = zoomAt(before, at, 0.5, LIMIT);
    expect(after.from + at * (after.to - after.from)).toBeCloseTo(anchored, 6);
  }
});

test("zooming in halves the span and zooming out doubles it", () => {
  expect(zoomAt({ from: 200_000, to: 600_000 }, 0.5, 0.5, LIMIT)).toEqual({ from: 300_000, to: 500_000 });
  expect(zoomAt({ from: 300_000, to: 500_000 }, 0.5, 2, LIMIT)).toEqual({ from: 200_000, to: 600_000 });
});

test("it cannot zoom out past the data, and the width is kept by sliding", () => {
  // Clamping each edge on its own would silently narrow the window the reader
  // asked for; sliding keeps the width and moves it inside the limit.
  const out = zoomAt({ from: 0, to: 400_000 }, 0, 40, LIMIT);
  expect(out).toEqual(LIMIT);

  const atEdge = zoomAt({ from: 3_500_000, to: 3_600_000 }, 1, 2, LIMIT);
  expect(atEdge.to - atEdge.from).toBe(200_000);
  expect(atEdge.to).toBeLessThanOrEqual(LIMIT.to);
  expect(atEdge.from).toBeGreaterThanOrEqual(LIMIT.from);
});

test("it cannot zoom in below what the clock resolves", () => {
  const tiny = zoomAt({ from: 500_000, to: 502_000 }, 0.5, 0.001, LIMIT);
  expect(tiny.to - tiny.from).toBe(1_000);
});

test("the zoom floor is the caller's unit, not milliseconds", () => {
  // The flamegraph's axis is a fraction of the total width, so its floor is a
  // fraction too. One constant would have meant a second copy of this function
  // for the sake of a unit.
  const whole = { from: 0, to: 1 };
  const deep = zoomAt({ from: 0.4, to: 0.6 }, 0.5, 0.001, whole, 0.002);
  expect(deep.to - deep.from).toBeCloseTo(0.002, 6);
  // And the anchoring rule is the same one, on the same function.
  expect(deep.from + 0.5 * (deep.to - deep.from)).toBeCloseTo(0.5, 6);
});

test("a fractional zoom cannot leave the whole width", () => {
  expect(zoomAt({ from: 0, to: 0.5 }, 0, 10, { from: 0, to: 1 }, 0.002)).toEqual({ from: 0, to: 1 });
});

// ── panning ────────────────────────────────────────────────────────────────

test("panning centres the window without changing its width", () => {
  const moved = panTo({ from: 0.2, to: 0.4 }, 0.6, { from: 0, to: 1 });
  expect(moved).toEqual({ from: 0.5, to: 0.7 });
});

test("panning to an edge slides rather than shrinking", () => {
  // The same rule `zoomAt` follows: the width the reader chose survives, even
  // when the centre they asked for is unreachable.
  const left = panTo({ from: 0.4, to: 0.6 }, 0, { from: 0, to: 1 });
  expect(left.from).toBeCloseTo(0, 6);
  expect(left.to - left.from).toBeCloseTo(0.2, 6);
  const right = panTo({ from: 0.4, to: 0.6 }, 1, { from: 0, to: 1 });
  expect(right.to).toBeCloseTo(1, 6);
  expect(right.to - right.from).toBeCloseTo(0.2, 6);
});

// ── the bucket follows the window ──────────────────────────────────────────

test("the bucket narrows as the window does, so a line always has points", () => {
  // The defect: a fixed hour meant zooming past an hour left one bucket, and a
  // line needs two points. The chart vanished exactly when the reader had zoomed
  // in far enough to care.
  const hour = 3_600_000;
  // Each is the smallest human unit that keeps the count under forty, so the
  // point count stays in the teens-to-thirties at every zoom level.
  expect(bucketFor(24 * hour)).toBe(hour); // 24 points
  expect(bucketFor(6 * hour)).toBe(15 * 60_000); // 24 points
  expect(bucketFor(hour)).toBe(5 * 60_000); // 12 points
  expect(bucketFor(15 * 60_000)).toBe(60_000); // 15 points
  // And the case that broke: a fixed hour gave this window one bucket.
  expect(bucketFor(30 * 60_000)).toBe(60_000); // 30 points
});

test("no window is given a bucket below a minute", () => {
  // The endpoint refuses one, and below a minute the buckets are noise rather
  // than resolution.
  expect(bucketFor(1_000)).toBe(60_000);
  expect(bucketFor(0)).toBe(60_000);
});

test("every bucket in the window gets a point, and the empty ones are gaps", () => {
  const m = 60_000;
  const filled = fillBuckets([{ at: 2 * m, count: 3, p50: 10, p95: 20 }], { from: 0, to: 4 * m }, m);
  // A quiet minute and a minute with no data are not the same fact; `null`
  // renders as a break where a missing point would be smoothed straight over.
  expect(filled).toHaveLength(5);
  expect(filled.map((p) => p.p50)).toEqual([null, null, 10, null, null]);
  expect(filled.map((p) => p.count)).toEqual([0, 0, 3, 0, 0]);
});

// ── the wheel ──────────────────────────────────────────────────────────────

test("a wheel event is normalised to pixels whatever unit it arrived in", () => {
  expect(wheelPixels(3, 0)).toBe(3);
  expect(wheelPixels(3, 1)).toBe(48);
  // Clamped, because one violent flick should not cross the whole range — which
  // is what "太灵敏" was describing.
  expect(wheelPixels(3, 2)).toBe(120);
  expect(wheelPixels(-9999, 0)).toBe(-120);
});

test("one formula serves both devices, because nothing can tell them apart", () => {
  // A browser gives no way to distinguish a trackpad from a mouse; they emit
  // identical events. The exponential is what makes one constant work for both.
  const mouse = wheelScale(-100, 0, false); // Chrome mouse click
  const pad = wheelScale(-3, 0, false); // trackpad increment
  expect(1 / mouse).toBeCloseTo(2 ** 0.2, 6); // ~13% a click
  expect(1 / pad).toBeCloseTo(2 ** 0.006, 6); // ~0.4% an increment
  // Up zooms in — the span multiplier is below one.
  expect(mouse).toBeLessThan(1);
  expect(wheelScale(100, 0, false)).toBeGreaterThan(1);
});

test("a line-mode wheel is not two orders of magnitude off a pixel-mode one", () => {
  // Firefox reports a tick as `deltaY: ±1` in lines where Chrome reports
  // hundreds of pixels. Without `deltaMode` one of the two is unusable.
  expect(wheelScale(-1, 1, false)).toBeCloseTo(wheelScale(-25, 0, false), 6);
});

test("a pinch is ten times a scroll, which is the one gesture that is knowable", () => {
  expect(1 / wheelScale(-100, 0, true)).toBeCloseTo((1 / wheelScale(-100, 0, false)) ** 10, 6);
});

test("panning by a distance keeps the width and clamps by sliding", () => {
  expect(panBy({ from: 0.2, to: 0.4 }, 0.1, { from: 0, to: 1 })).toEqual({ from: 0.30000000000000004, to: 0.5 });
  const stuck = panBy({ from: 0.8, to: 1 }, 0.5, { from: 0, to: 1 });
  expect(stuck.to).toBeCloseTo(1, 6);
  expect(stuck.to - stuck.from).toBeCloseTo(0.2, 6);
});
