/**
 * Stored spans, turned into what the four blocks on the page draw.
 *
 * Everything that reduces — percentiles, bucketing, folded stacks, the scope
 * filter — happens in SQL, and none of it is here. What is here is the shaping
 * the browser does on rows the server already sent: a flame tree, a grouping by
 * kind, the fold that decides which stages are worth a row, and the names the
 * reader sees instead of span identifiers.
 *
 * The views compose these; they decide nothing. That split is why "an unmapped
 * identifier falls through to itself" and "twenty-four rules are one line" are
 * unit tests rather than screenshots.
 */

import type { Folded, Stage, TraceRow } from "../../shared/api";

/**
 * One frame of the flamegraph: a name, what it cost, and what it called.
 *
 * Ours rather than the library's, and structurally what `d3-flame-graph`
 * consumes. It lives here because this is the shape the model produces and the
 * tests assert on, and an ambient module declaration does not cross a project
 * reference — a test importing it from the library's `.d.ts` gets an error type.
 */
export interface FlameNode {
  name: string;
  value: number;
  children?: FlameNode[];
}

/**
 * Folded stacks, as the tree a flamegraph consumes.
 *
 * The server sends `turn;turn.provider` with a total, which is the format
 * flamegraphs have taken since the original Perl ones; this is the one place
 * that turns it back into `{name, value, children}`. Doing it here rather than
 * in SQL is deliberate — it is a reshaping of rows the browser already holds,
 * not a reduction, and it is the part worth having a unit test on.
 *
 * A parent's `value` is its own summed time, not its children's. `selfValue` on
 * the chart is what decides which of the two a frame's width means, and giving
 * the library the real number for both keeps that a display choice rather than
 * something baked in here.
 *
 * Paths arrive sorted, so a parent is always seen before its children; the map
 * is keyed by full path so two different parents' identically named children
 * never merge.
 */
export function flameTree(folded: readonly Folded[], rootName = "全部"): FlameNode {
  const root: FlameNode = { name: rootName, value: 0, children: [] };
  const byPath = new Map<string, FlameNode>();

  for (const { path, totalMs } of folded) {
    const parts = path.split(";");
    let parent = root;
    let prefix = "";
    for (const [index, part] of parts.entries()) {
      prefix = prefix ? `${prefix};${part}` : part;
      let node = byPath.get(prefix);
      if (!node) {
        node = { name: part, value: 0, children: [] };
        byPath.set(prefix, node);
        parent.children?.push(node);
      }
      // Only the frame this row names gets the time. An ancestor already had
      // its own row, and adding here as well would count it twice.
      if (index === parts.length - 1) node.value = totalMs;
      parent = node;
    }
  }

  // The root spans everything under it, so it is the sum of what it holds —
  // otherwise the topmost frame is a zero-width bar with the whole chart
  // hanging off it.
  root.value = (root.children ?? []).reduce((total, child) => total + child.value, 0);
  return root;
}

/** How deep the flame tree goes — one row of frames per level. */
export function flameDepth(node: FlameNode): number {
  const children = node.children ?? [];
  return children.length === 0 ? 1 : 1 + Math.max(...children.map(flameDepth));
}

/**
 * The verdict that goes above the table: is anything actually slow.
 *
 * Three outcomes, and the middle one exists because of a bug this shipped with.
 * The first version had two: name the slow stages when the fold found a gap, and
 * otherwise assert 「各阶段耗时接近，没有特别慢的。」 That second branch was
 * false on real data and the table under it said so — `splitStages` cuts at the
 * largest *adjacent* ratio, so a smooth ramp from 41.9s down to 8.7s has no
 * single fourfold step in it and folded nothing, while being a fivefold spread
 * end to end. The page asserted an absence its own rows contradicted one line
 * below, which is worse than having no summary at all.
 *
 * So there is no branch that claims flatness any more. Either a gap was found
 * and the slow stages are named, or the leader is stated as a fact with the
 * multiple that makes it the leader, or nothing is rendered. A summary line may
 * only ever say something the rows can be checked against.
 *
 * `null` covers the two cases with no fact in them: fewer than two stages, where
 * "the slowest of one thing" is not a finding, and a genuine tie, where a
 * sentence reading 「是第二名的 1.0 倍」 is noise dressed as a result.
 */
export type Verdict =
  | { kind: "slow"; names: string[]; unnamed: number; more: number }
  | { kind: "lead"; name: string; p95: number; ratio: number };

/** How many slow stages the sentence names before it starts counting instead. */
const NAMED = 2;

/** Below this the leader is not leading, and the line is not worth its row. */
const LEAD = 1.15;

export function verdict(split: StageSplit): Verdict | null {
  if (split.fast.length > 0) {
    // Two names and a count, not seven names. Seven things in one sentence is a
    // list, and a list is what the table underneath already is — the sentence
    // exists to be read instead of the table, so it has to be shorter than it.
    //
    // Unmapped identifiers are counted rather than pasted in. Half a translated
    // sentence is worse than none: 「更新代码索引、git.ls_tree」 reads as two
    // different kinds of thing, and the reader cannot tell which of the two is
    // the name of a stage and which is a leak.
    const named = split.slow.filter((stage) => isRenamed(stage.name));
    const unnamed = split.slow.length - named.length;
    return {
      kind: "slow",
      names: named.slice(0, NAMED).map((stage) => stage.name),
      unnamed,
      more: Math.max(named.length - NAMED, 0),
    };
  }
  const [worst, second] = split.slow;
  if (!worst || !second) return null;
  // A second place at zero makes the ratio infinite, and 「Infinity 倍」 is not a
  // number. It is also the clearest possible gap, so it is reported as one.
  if (second.p95 <= 0) {
    const named = isRenamed(worst.name);
    return worst.p95 > 0 ? { kind: "slow", names: named ? [worst.name] : [], unnamed: named ? 0 : 1, more: 0 } : null;
  }
  const ratio = worst.p95 / second.p95;
  return ratio >= LEAD ? { kind: "lead", name: worst.name, p95: worst.p95, ratio } : null;
}

/**
 * What each span name is, in words, for the person reading this page.
 *
 * The boss runs a company. `sandbox.create`, `GET /api/v1/auth/github` and
 * `watchdog.repo_map` are instrumentation keys — the names the code calls
 * itself — and a page built out of them asks the reader to be a debugger before
 * it will tell them where four hours went. `ui.md` sets the register: 「白干的
 * 单位」, 「去合并 PR」. This is that rule applied to the one place the interface
 * was still speaking to the compiler.
 *
 * An exact table and nothing cleverer. A pattern that turned `foo.create` into
 * 「开一个 foo」 would be a translator that invents sentences about spans nobody
 * has read, and the first one it got wrong would be indistinguishable from a
 * name somebody chose.
 *
 * **Unmapped falls through to the identifier**, which is the property that
 * matters most here: the set of span names grows every time somebody adds a
 * stage, and a missing entry has to degrade to a name the reader can search for
 * rather than to a blank or to a guess. The raw identifier stays reachable
 * everywhere it is replaced — on hover in the aggregate views, and plainly in
 * the waterfall, which is the drill-down somebody debugging is already in.
 */
const HUMAN: Record<string, string> = {
  "sandbox.create": "开一个新环境",
  "sandbox.init": "环境装配",
  turn: "跑一轮",
  "turn.prepare": "准备这一轮",
  "turn.provider": "模型在想",
  "turn.checkpoint": "存一次档",
  "job watchdog": "例行巡检",
  "job agent_turn": "跑一轮",
  "watchdog.repo_map": "更新代码索引",
  "watchdog.turn_timeout": "查有没有卡住的轮次",
  "GET /api/v1/auth/github": "连 GitHub",
};

/** The words for a span name, or the span name when nobody has written any. */
export const humanName = (id: string): string => HUMAN[id] ?? id;

/** Whether this name has words of its own, and therefore an identifier worth keeping on hover. */
export const isRenamed = (id: string): boolean => id in HUMAN;

/**
 * What the two percentiles are, said to somebody who has not read one.
 *
 * `p50` and `p95` are the vocabulary of the tool that produced them. The reader
 * wants to know what usually happens and what happens on a bad day, and those
 * are the words for it.
 */
export const P50_LABEL = "一半的情况";
export const P95_LABEL = "最慢的那几次";

/**
 * What kind of work a span name is, from its own prefix.
 *
 * Derived, never enumerated. The set of names grows every hour — `github.request`,
 * `index.ask`, `lease.run`, `gate.run`, `pr.poll`, `sandbox.reconnect` all landed
 * today — and a hardcoded list would silently drop each new one into nothing or
 * into the wrong pile. The names already encode the kind, so the prefix is the
 * grouping and a name nobody has seen slots in without a code change.
 *
 * The fallback bucket is the point of the design rather than an afterthought: a
 * span with no prefix at all still has to land somewhere a reader can find it.
 */
const KIND_NAMES: Record<string, string> = {
  watchdog: "巡检规则",
  sandbox: "容器操作",
  git: "代码仓库",
  github: "GitHub",
  turn: "跑一轮",
  job: "后台任务",
  index: "代码索引",
  lease: "借用资源",
  gate: "闸门检查",
  pr: "合并请求",
};

/** HTTP spans are named `METHOD /route`, which is a prefix of a different shape. */
const HTTP = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /;

export function spanKind(name: string): { key: string; label: string } {
  if (HTTP.test(name)) return { key: "http", label: "接口请求" };
  const prefix = name.split(".")[0] ?? "";
  const label = KIND_NAMES[prefix];
  // A prefix nobody has named keeps its own, so a new family of spans is its own
  // group on the day it ships rather than being swept into 其他.
  if (label) return { key: prefix, label };
  return name.includes(".") ? { key: prefix, label: prefix } : { key: "other", label: "其他" };
}

/** One kind of work, with everything under it and what it cost together. */
export interface SpanGroup<T> {
  key: string;
  label: string;
  rows: T[];
  totalMs: number;
  count: number;
  errors: number;
}

/**
 * Rows grouped by kind, costliest group first.
 *
 * Twenty-four watchdog rules summing to 1.1s is one line, not twenty-four. The
 * header carries the total and the count so a shut group still answers "did this
 * category cost anything", which is usually the whole question.
 */
export function groupByKind<T extends { name: string; durationMs?: number; totalMs?: number; errors?: number }>(
  rows: readonly T[],
): SpanGroup<T>[] {
  const groups = new Map<string, SpanGroup<T>>();
  for (const row of rows) {
    const { key, label } = spanKind(row.name);
    const group = groups.get(key) ?? { key, label, rows: [], totalMs: 0, count: 0, errors: 0 };
    group.rows.push(row);
    group.totalMs += row.totalMs ?? row.durationMs ?? 0;
    group.count += 1;
    group.errors += row.errors ?? 0;
    groups.set(key, group);
  }
  return [...groups.values()].toSorted((a, b) => b.totalMs - a.totalMs);
}

/** The stage list, cut where the data itself stops being comparable. */
export interface StageSplit {
  /** Above the gap, slowest first. The rows the reader came for. */
  slow: Stage[];
  /** Below the gap. One sentence, not nine rows. */
  fast: Stage[];
  /** The slowest p95 among `fast` — the number that sentence quotes. 0 when none. */
  ceiling: number;
}

/**
 * How large a step has to be before it is a gap rather than a spread: fourfold.
 *
 * A threshold in milliseconds would be the wrong kind of constant — "slow" on a
 * fleet whose turns take minutes is not "slow" on one that serves cached reads,
 * and a number written here would be right for whichever of the two was on the
 * screen the day it was chosen. A ratio asks the distribution instead, and a
 * fourfold step is well outside what the same kind of work varies by.
 */
const GAP = 4;

/** Folding one row away saves no space and costs the reader the row. */
const MIN_FOLD = 2;

/**
 * Split the stages at their own largest gap.
 *
 * Eleven rows at equal weight is eleven rows nobody reads, and it is what the
 * data looks like when two stages take seconds and the other nine take under a
 * handful of milliseconds. Those nine are not an answer to "is anything slow",
 * they are the absence of one, and `docs/design/ui.md` is explicit that absence
 * gets a sentence rather than equal billing.
 *
 * The cut is the largest multiplicative step in the p95 ordering, and it is
 * taken only if that step is at least `GAP`. A list with no gap — every stage
 * within a factor of four of its neighbour — is genuinely a list of comparable
 * rows, and folding part of it would be inventing a distinction the numbers do
 * not make.
 *
 * p95 and not p50, because the question is whether anything is slow and a stage
 * that is usually instant and occasionally seconds is exactly the row worth
 * keeping above the fold.
 */
export function splitStages(stages: readonly Stage[]): StageSplit {
  // Ties broken by total time so the order is stable across reads: two stages
  // with the same p95 would otherwise swap places on the strength of whichever
  // the query happened to return first.
  const sorted = stages.toSorted((a, b) => b.p95 - a.p95 || b.totalMs - a.totalMs);
  let cut = 0;
  let widest = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const above = sorted[i - 1]!.p95;
    const below = sorted[i]!.p95;
    // A row at zero is below anything the clock can measure, so the step over it
    // is as large as steps get. `>` and not `>=` keeps the earliest of equal
    // steps, which is the cut that folds the most away.
    const step = below > 0 ? above / below : Infinity;
    if (step > widest) {
      widest = step;
      cut = i;
    }
  }
  if (widest < GAP || cut === 0 || sorted.length - cut < MIN_FOLD) {
    return { slow: sorted, fast: [], ceiling: 0 };
  }
  const fast = sorted.slice(cut);
  return { slow: sorted.slice(0, cut), fast, ceiling: fast[0]!.p95 };
}

/**
 * What a drag on the trend means, as a window.
 *
 * Its own function because it is policy rather than event handling, and it was
 * six branches inlined in a `Brush` callback where nothing could reach it. Two
 * rules live here: dragging from the first bucket means "all of it", which is
 * the window the caller already asked for and therefore not a change; and a
 * window under a minute is a drag nobody meant, since the buckets are hours.
 *
 * `null` is "leave the caller's window alone", which is a different answer from
 * "a window of zero" and is why it is not a number.
 */
const MIN_DRAG_MS = 60_000;

export function draggedWindow(bucketAt: number | undefined, startIndex: number, now = Date.now()): number | null {
  if (bucketAt === undefined || startIndex <= 0) return null;
  return Math.max(now - bucketAt, MIN_DRAG_MS);
}

/**
 * The stretch of time a chart is showing.
 *
 * Two instants, matching the store: a duration backwards from now cannot say
 * "01:30 to 02:00", which is the only thing a brush or a wheel is for.
 */
export interface TimeWindow {
  from: number;
  to: number;
}

/** Below this the range is shorter than the clock can usefully resolve. */
const MIN_SPAN_MS = 1_000;

/**
 * Zoom around the pointer, not the centre.
 *
 * Every profiler does this — DevTools, Grafana, speedscope — and the reason is
 * that the frame you are pointing at stays under the pointer while everything
 * else spreads away from it. Zooming to the centre moves the thing you were
 * aiming at, so you chase it across the screen.
 *
 * `at` is the pointer as a fraction of the width, so the instant under it is
 * `from + at * span`. After scaling the span by `k` that instant has to land on
 * the same fraction again, which fixes the new start: everything else follows.
 *
 * Clamped at both ends. It cannot zoom out past `limit`, because there are no
 * rows outside it, and it cannot zoom in below a second, because a window
 * narrower than the clock resolves is a window showing nothing.
 */
export function zoomAt(
  window: TimeWindow,
  at: number,
  k: number,
  limit: TimeWindow,
  /**
   * The narrowest range worth showing, in the caller's own units.
   *
   * A millisecond default for the trend, whose axis is time. The flamegraph's
   * axis is a fraction of the total width, so it passes its own floor — one
   * constant here would have meant a second copy of this function for the sake
   * of a unit.
   */
  minSpan = MIN_SPAN_MS,
): TimeWindow {
  const span = window.to - window.from;
  const anchored = window.from + at * span;
  const next = Math.min(Math.max(span * k, minSpan), limit.to - limit.from);
  // Anchor first, then slide back inside the limit if the anchor pushed an edge
  // out — sliding keeps the width the reader asked for, where clamping each edge
  // independently would silently shrink it.
  let from = anchored - at * next;
  from = Math.min(Math.max(from, limit.from), limit.to - next);
  return { from, to: from + next };
}

/**
 * Whether there is anything to draw.
 *
 * Separate from "the request failed", which the toast already said. A scope with
 * no spans is the ordinary state of a requirement that has not run a turn yet,
 * and it wants a sentence rather than an empty chart with axes.
 */
export const hasSpans = (stages: readonly Stage[], traces: readonly TraceRow[]): boolean =>
  stages.length > 0 || traces.length > 0;

/**
 * A trend point's label: the hour, or the day once the window is wider than one.
 *
 * The bucket carries no unit of its own — it is the epoch millisecond the bucket
 * opens at — so the axis has to be told which of the two it is showing, and it
 * is told by the window rather than by guessing from the spacing of the points.
 * A quiet fleet produces gaps, and spacing read off gaps would relabel the axis
 * because nothing happened for two hours.
 */
export const trendLabel = (at: number, windowMs: number): string => {
  const when = new Date(at);
  if (windowMs > 48 * 60 * 60 * 1_000) return `${when.getMonth() + 1}/${when.getDate()}`;
  return `${String(when.getHours()).padStart(2, "0")}:00`;
};
