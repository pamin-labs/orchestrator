/**
 * Stored spans, turned into what the four blocks on the page draw.
 *
 * Everything that reduces — percentiles, bucketing, folded stacks, the scope
 * filter — happens in SQL. What is here is the shaping the browser does on rows
 * the server already sent. The views compose these and decide nothing, which is
 * what makes the page's rules unit tests rather than screenshots.
 */

import type { Folded, Stage, TraceRow, Trend } from "../../shared/api";
import { msg, t } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../../i18n";
import { clock, day, hourOnly } from "../../shared/format";
import { labelOf } from "../../shared/select";

/**
 * One frame of the flamegraph: a name, what it cost, and what it called.
 *
 * Ours rather than the library's, and structurally what `d3-flame-graph`
 * consumes: an ambient module declaration does not cross a project reference, so
 * a test importing it from the library's `.d.ts` gets an error type.
 */
export interface FlameNode {
  name: string;
  value: number;
  children?: FlameNode[];
}

/**
 * Folded stacks, as the tree a flamegraph consumes.
 *
 * A parent's `value` is its own summed time, not its children's, so `selfValue`
 * stays a display choice. Paths arrive sorted, so a parent is always seen before
 * its children, and the map is keyed by full path so two different parents'
 * identically named children never merge.
 */
export function flameTree(folded: readonly Folded[], rootName = t`All`): FlameNode {
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
  // otherwise the topmost frame is a zero-width bar with the chart hanging off it.
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
 * **No branch claims flatness.** A summary line may only say something the rows
 * can be checked against: either a gap was found and the slow stages are named,
 * or the leader is stated with the multiple that makes it one, or nothing is
 * rendered. `null` is the two cases with no fact — under two stages, and a tie.
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
    // Two names and a count, not seven names: the sentence exists to be read
    // instead of the table, so it has to be shorter than it. Unmapped identifiers
    // are counted rather than pasted in — "refresh the code index, git.ls_tree" reads as two
    // different kinds of thing, and half a translated sentence is worse than none.
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
  // A second place at zero makes the ratio infinite, and "Infinity×" is not a
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
 * An exact table and nothing cleverer: a pattern turning `foo.create` into
 * inventing "open a foo" makes up sentences about spans nobody has read. **Unmapped falls
 * through to the identifier** — the set of names grows every time somebody adds a
 * stage, and a missing entry must degrade to a name the reader can search for.
 */
const HUMAN: Record<string, MessageDescriptor> = {
  "sandbox.create": msg`Create new sandbox`,
  "sandbox.init": msg`Sandbox setup`,
  turn: msg`Run one turn`,
  "turn.prepare": msg`Prepare this turn`,
  "turn.provider": msg`Model processing`,
  "turn.checkpoint": msg`Save checkpoint`,
  "job watchdog": msg`Routine watchdog`,
  "job agent_turn": msg`Run one turn`,
  "watchdog.repo_map": msg`Update code index`,
  "watchdog.turn_timeout": msg`Check for stuck turns`,
  "GET /api/v1/auth/github": msg`Connect GitHub`,
};

/** The words for a span name, or the span name when nobody has written any. */
export const humanName = (id: string): string => labelOf(HUMAN[id], id);

/** Whether this name has words of its own, and therefore an identifier worth keeping on hover. */
export const isRenamed = (id: string): boolean => id in HUMAN;

/**
 * What the two percentiles are, said to somebody who has not read one.
 *
 * `p50` and `p95` are the vocabulary of the tool that produced them. The reader
 * wants to know what usually happens and what happens on a bad day, and those
 * are the words for it.
 */
export const P50_LABEL = msg`p50`;
export const P95_LABEL = msg`p95`;

/**
 * What kind of work a span name is, from its own prefix.
 *
 * Derived, never enumerated: the set of names grows constantly, and a hardcoded
 * list would silently drop each new one into nothing or into the wrong pile. The
 * names already encode the kind. The fallback bucket is part of the design — a
 * span with no prefix at all still has to land somewhere a reader can find it.
 */
const KIND_NAMES: Record<string, MessageDescriptor> = {
  watchdog: msg`Watchdog rule`,
  sandbox: msg`Sandbox operation`,
  git: msg`Code repository`,
  github: msg`GitHub`,
  turn: msg`Run one turn`,
  job: msg`Background job`,
  index: msg`Code index`,
  lease: msg`Resource lease`,
  gate: msg`Gate check`,
  pr: msg`Pull request`,
};

/** HTTP spans are named `METHOD /route`, which is a prefix of a different shape. */
const HTTP = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /;

export function spanKind(name: string): { key: string; label: string } {
  if (HTTP.test(name)) return { key: "http", label: t`HTTP request` };
  const prefix = name.split(".")[0] ?? "";
  const label = KIND_NAMES[prefix];
  // A prefix nobody has named keeps its own, so a new family of spans is its own
  // group on the day it ships rather than being swept into `Other`.
  if (label) return { key: prefix, label: i18n._(label) };
  return name.includes(".") ? { key: prefix, label: prefix } : { key: "other", label: t`Other` };
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
 * A ratio and not a threshold in milliseconds — "slow" on a fleet whose turns
 * take minutes is not "slow" on one that serves cached reads, so a millisecond
 * number would be right only for whichever fleet was on screen the day it was
 * chosen. A fourfold step is well outside what the same kind of work varies by.
 */
const GAP = 4;

/** Folding one row away saves no space and costs the reader the row. */
const MIN_FOLD = 2;

/**
 * Split the stages at their own largest gap.
 *
 * The cut is the largest multiplicative step in the p95 ordering, taken only if
 * that step is at least `GAP`: a list where every stage is within a factor of four
 * of its neighbour is comparable rows, and folding part of it invents a
 * distinction the numbers do not make. p95, because occasionally-seconds counts.
 */
export function splitStages(stages: readonly Stage[]): StageSplit {
  // Ties broken by total time so the order is stable across reads: two stages with
  // the same p95 would otherwise swap on whichever the query returned first.
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
 * Two rules: dragging from the first bucket means "all of it", the window the
 * caller already asked for and therefore not a change; and a window under a
 * minute is a drag nobody meant. `null` is "leave the caller's window alone",
 * which is a different answer from "a window of zero".
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
 * Zoom around the pointer, not the centre — zooming to the centre moves the frame
 * you were aiming at, so you chase it across the screen.
 *
 * `at` is the pointer as a fraction of the width, so the instant under it is
 * `from + at * span` and has to land on the same fraction after scaling by `k`.
 * Clamped at both ends: nothing outside `limit`, nothing narrower than the clock.
 */
export function zoomAt(
  window: TimeWindow,
  at: number,
  k: number,
  limit: TimeWindow,
  /**
   * The narrowest range worth showing, in the caller's own units: milliseconds by
   * default for the trend, while the flamegraph's axis is a fraction of the total
   * width and passes its own floor.
   */
  minSpan = MIN_SPAN_MS,
): TimeWindow {
  const span = window.to - window.from;
  const anchored = window.from + at * span;
  const next = Math.min(Math.max(span * k, minSpan), limit.to - limit.from);
  // Anchor first, then slide back inside the limit — sliding keeps the width the
  // reader asked for, where clamping each edge independently would shrink it.
  let from = anchored - at * next;
  from = Math.min(Math.max(from, limit.from), limit.to - next);
  return { from, to: from + next };
}

/**
 * Slide the window so it is centred on a point, without changing its width.
 *
 * The minimap's whole job. Clamped by sliding rather than by clamping each edge,
 * for the same reason `zoomAt` does: keeping the width the reader chose matters
 * more than honouring a centre they cannot reach at the ends of the range.
 */
export function panTo(window: TimeWindow, centre: number, limit: TimeWindow): TimeWindow {
  const span = window.to - window.from;
  const from = Math.min(Math.max(centre - span / 2, limit.from), limit.to - span);
  return { from, to: from + span };
}

/**
 * One wheel event in pixels, whatever unit it arrived in.
 *
 * `deltaMode` is 0 for pixels, 1 for lines and 2 for pages, and a factor tuned for
 * one is wrong by an order of magnitude for the others. The clamp is for the
 * gesture rather than the unit: one violent flick must not cross the whole range.
 */
const LINE_PX = 16;
const PAGE_PX = 800;
const MAX_PX = 120;

export const wheelPixels = (delta: number, deltaMode: number): number => {
  const px = deltaMode === 1 ? delta * LINE_PX : deltaMode === 2 ? delta * PAGE_PX : delta;
  return Math.max(-MAX_PX, Math.min(MAX_PX, px));
};

/**
 * The scale one wheel event asks for, from `d3-zoom`'s own normalisation.
 *
 * `deltaMode` is not optional: Firefox reports a wheel tick as `deltaY: ±1` in
 * *lines* where Chrome and Safari report hundreds of *pixels*. The exponential is
 * what makes one constant serve both, and it has to, because **there is no device
 * detection to be had**. Returned as a *span* multiplier, the inverse of d3's.
 */
export function wheelScale(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const delta = -deltaY * (deltaMode === 1 ? 0.05 : deltaMode ? 1 : 0.002) * (ctrlKey ? 10 : 1);
  return 2 ** -delta;
}

/**
 * Slide the window by a distance in its own units, clamped by sliding.
 *
 * A horizontal wheel — the two-finger swipe a trackpad makes — pans rather than
 * zooms, which is what speedscope and Chrome's Modern mode both do.
 */
export function panBy(window: TimeWindow, delta: number, limit: TimeWindow): TimeWindow {
  const span = window.to - window.from;
  const from = Math.min(Math.max(window.from + delta, limit.from), limit.to - span);
  return { from, to: from + span };
}

/**
 * The bucket widths a reader recognises, smallest first.
 *
 * Human units, not an arbitrary quotient of the window. A tick reading 02:14:37
 * is worse than one reading 02:15 even when the first is more precise, because
 * nobody reads a chart to five significant figures of clock.
 */
export const BUCKETS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 6 * 3_600_000] as const;

/** Above this the ticks crowd; the smallest bucket that stays under it wins. */
const MAX_BUCKETS = 40;

/**
 * How wide a bucket should be for a given window.
 *
 * It was a fixed hour, and it did not follow the zoom — so zooming past an hour
 * left one bucket, and a line needs two points to exist. The chart vanished
 * exactly when the reader had zoomed in far enough to care.
 */
export const bucketFor = (windowMs: number): number =>
  BUCKETS.find((b) => windowMs / b <= MAX_BUCKETS) ?? BUCKETS.at(-1)!;

/**
 * The window a pinned bucket needs, which is the other half of `bucketFor`.
 *
 * Only one of the two was ever wired: the window picked the bucket, and pinning a
 * bucket left the window where it was. Pin one wider than the window and the whole
 * window collapses into a single bucket — one point, and a line needs two, so the
 * chart went blank at exactly the moment the reader made a choice about it. Pin one
 * much finer and every run gets its own bucket with gaps either side.
 */
/**
 * Exact inverse of `bucketFor`, so pinning the width the window already implied
 * changes nothing: `bucketFor(windowFor(b)) === b` for every width offered.
 */
export const windowFor = (bucketMs: number): number => bucketMs * MAX_BUCKETS;

/**
 * The width and the stretch, resolved together, because they are one choice.
 *
 * Three inputs decide both and they do not compose in the view without a nest of
 * ternaries: a brush names a stretch and keeps its own width; a pinned width names
 * the stretch it needs; neither, and the caller's window picks the width.
 */
export function trendScale(
  pinnedBucket: number | null,
  chosen: { from: number; to: number } | null,
  windowMs: number | undefined,
  fallbackMs: number,
): { bucketMs: number; askedWindowMs: number | undefined } {
  if (chosen) return { bucketMs: pinnedBucket ?? bucketFor(chosen.to - chosen.from), askedWindowMs: windowMs };
  if (pinnedBucket !== null) return { bucketMs: pinnedBucket, askedWindowMs: windowFor(pinnedBucket) };
  return { bucketMs: bucketFor(windowMs ?? fallbackMs), askedWindowMs: windowMs };
}

/**
 * Whether the series can actually draw a line, which is not the same as having
 * points in it.
 *
 * An area is drawn between *adjacent* non-null points, so with `connectNulls` off a
 * sporadic fleet could put ten runs in the window, pass a "two or more points" test,
 * and still render an empty box. Measured on ten runs over a day: at every width
 * from a minute to an hour, ten points and zero adjacent pairs.
 */
export const adjacentPairs = (points: readonly { p50: number | null }[]): number => {
  let pairs = 0;
  for (let i = 1; i < points.length; i++) if (points[i]!.p50 !== null && points[i - 1]!.p50 !== null) pairs++;
  return pairs;
};

/**
 * How many points the trend will draw before it stops being a chart.
 *
 * Not `MAX_BUCKETS`, deliberately: that is a *taste* limit governing the bucket
 * nobody chose, and this is a *render* limit. A reader who pins a fine bucket has
 * asked for the dense chart on purpose, and answering with the comfortable one
 * would be overruling them.
 */
const MAX_POINTS = 1_500;

/**
 * Whether a bucket can actually be drawn across a window.
 *
 * The picker asks this before offering a width: the choice is refused where it is
 * made, rather than accepted and then quietly truncated somewhere the reader
 * cannot see.
 */
export const bucketFits = (windowMs: number, bucketMs: number): boolean => windowMs / bucketMs <= MAX_POINTS;

/**
 * The trend as a dense series, with a point for every bucket in the window.
 *
 * The server only returns buckets that had traces in them, so the empty ones have
 * to be invented here or the axis has nothing to place the rest against. They
 * carry `null`, which the chart joins across: the axis is a number line, so the
 * join is drawn the width of the silence rather than collapsing it.
 */
export function fillBuckets(
  points: readonly Trend[],
  window: TimeWindow,
  bucketMs: number,
): { at: number; count: number; p50: number | null; p95: number | null }[] {
  const byBucket = new Map(points.map((p) => [Math.floor(p.at / bucketMs), p]));
  const first = Math.floor(window.from / bucketMs);
  const last = Math.floor(window.to / bucketMs);
  // The ceiling, and which end it is taken from. It takes the *last* buckets,
  // because a window's recent end is the half somebody is looking at. `MAX_POINTS`
  // is high enough that the picker's own guard is what stops this being reached;
  // the clamp is kept as a floor under a caller who does not ask.
  const span = Math.min(last - first, MAX_POINTS);
  const start = last - span;
  return Array.from({ length: span + 1 }, (_, i) => {
    const bucket = start + i;
    const hit = byBucket.get(bucket);
    return {
      at: bucket * bucketMs,
      count: hit?.count ?? 0,
      p50: hit?.p50 ?? null,
      p95: hit?.p95 ?? null,
    };
  });
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
 * A trend point's label: the day, the hour, or the minute.
 *
 * Told what it is showing rather than guessing from the spacing of the points: a
 * quiet fleet produces gaps, and spacing read off gaps would relabel the axis
 * because nothing happened for two hours. Two inputs: the **window** decides
 * whether a clock is worth printing, the **bucket** decides the precision.
 */
/**
 * Both halves come from `Intl` at the reader's locale, not from string building.
 * `8/20` is 20 August here and 8 August to a German, French or Korean reader —
 * the day branch printed month-first for every one of the ten. The clock is
 * `clock()`, which is already `hourCycle: "h23"` so the column keeps its width.
 */
export const trendLabel = (at: number, windowMs: number, bucketMs: number): string => {
  if (windowMs > 48 * 60 * 60 * 1_000) return day(new Date(at));
  return bucketMs >= 3_600_000 ? hourOnly(new Date(at)) : clock(at);
};

/**
 * What one wheel event does to a window, for both charts.
 *
 * Vertical zooms at the pointer, horizontal pans — the split speedscope and
 * Chrome's Modern mode both use, and the one a trackpad's two-finger swipe
 * expects. Returns `null` when the event carries nothing usable, so a caller can
 * leave the window alone rather than anchor a zoom on a guess.
 */
/**
 * What sits between a chart's own box and the plot inside it.
 *
 * The flamegraph has none: its host element *is* the drawing. `recharts` reserves
 * the y axis on the left and the chart margin on the right, so reading the pointer
 * against the box anchors every zoom to the left of where the reader is pointing.
 */
export interface PlotInset {
  left: number;
  right: number;
}
const NO_INSET: PlotInset = { left: 0, right: 0 };

export function wheelWindow(
  event: WheelEvent,
  element: HTMLElement,
  window: TimeWindow,
  limit: TimeWindow,
  minSpan: number,
  inset: PlotInset = NO_INSET,
): TimeWindow | null {
  const box = element.getBoundingClientRect();
  const plot = box.width - inset.left - inset.right;
  if (plot <= 0) return null;
  // Whichever axis the gesture is mostly on. A trackpad swipe is never purely
  // one, and treating a mostly-horizontal one as a zoom is what made a pan
  // jitter the scale.
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    const px = wheelPixels(event.deltaX, event.deltaMode);
    return panBy(window, (px / plot) * (window.to - window.from), limit);
  }
  const at = (event.clientX - box.left - inset.left) / plot;
  if (!Number.isFinite(at)) return null;
  // Clamped, because the axis labels and the margin are inside the element that
  // catches the wheel: a scroll over the gutter is a real gesture at a negative
  // fraction, and the edge is what the reader means by pointing at the edge.
  const anchor = Math.min(Math.max(at, 0), 1);
  return zoomAt(window, anchor, wheelScale(event.deltaY, event.deltaMode, event.ctrlKey), limit, minSpan);
}

/** The flamegraph's axis is a fraction of its own width, so its limit is all of it. */
export const WHOLE: TimeWindow = { from: 0, to: 1 };
