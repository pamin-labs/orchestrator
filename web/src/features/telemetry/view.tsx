import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { select } from "d3-selection";
import flamegraph, { type FlameFrame, type FlameGraph } from "d3-flame-graph";
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { scalePoint } from "d3-scale";
// `Report` and not `Telemetry`: the component exported at the foot of this file
// is called `Telemetry`, and a type import of the same name shadows it, so the
// one place that renders the component could not see it.
import { readTelemetry, type Telemetry as Report, type TelemetryScope } from "../../shared/api";
import { duration } from "../../shared/format";
import { Head } from "../../ui/bits";
import { AXIS, ChartTooltip } from "../../ui/chart";
import { cn } from "../../ui/cn";
import { Segment, Segments } from "../../ui/segment";
import { ChevronRight } from "lucide-react";
import { Tip } from "../../ui/tooltip";
import { AccordionBody, AccordionItem, AccordionTrigger, MultiAccordion } from "../../ui/accordion";
import { Menu, MenuItem } from "../../ui/menu";
import {
  fillBuckets,
  BUCKETS,
  bucketFits,
  trendScale,
  flameDepth,
  type TimeWindow,
  panBy,
  panTo,
  wheelPixels,
  wheelScale,
  zoomAt,
  groupByKind,
  humanName,
  isRenamed,
  P50_LABEL,
  P95_LABEL,
  type FlameNode,
  flameTree,
  hasSpans,
  splitStages,
  trendLabel,
} from "./model";

/**
 * 耗时 — where a scope's wall clock went.
 *
 * Three surfaces read this: one component with a different scope, because a
 * requirement, a project and the host ask the same question about different work.
 * Two libraries — `recharts`, already bundled for 成本, and `d3-flame-graph` —
 * both rendering SVG, because a canvas chart is one node with an image in it.
 */

/** One menu surface, because the stage rows and the waterfall both raise one. */
const MENU =
  "z-50 min-w-44 rounded-lg border border-rule bg-paper p-1 text-[0.8125rem] text-ink shadow-[0_10px_30px_var(--shade)]";

/**
 * How a row looks, given two independent states.
 *
 * Three appearances, not two: `hover:bg-rail` after `bg-accent-soft` is a later
 * rule on the same property, so a selected row lost its selection the moment the
 * pointer crossed it. Selected and hovered are orthogonal, so the selected row
 * gets its own hover shade and the two never collide.
 */
const rowTone = (selected: boolean) => (selected ? "bg-accent-soft hover:bg-accent-soft/60" : "hover:bg-rail");

/** A name is a literal in the flamegraph's search, and `.` and `/` are not. */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The four columns, in one place because three rows have to agree on them.
 *
 * `auto` on the three numeric tracks rather than fixed rem widths, which gives
 * each number exactly what it needs and hands the rest to `minmax(0,1fr)`. `次数`
 * stays a column rather than moving to a tooltip: it is the cheapest of the three
 * to render and the one that proves a brushed window took effect.
 */
const COLS = "grid-cols-[minmax(0,1fr)_auto_auto_auto]";

/**
 * One block: a heading, a rule under it, and the thing itself.
 *
 * Four sections were writing the same `<h3>` and drifting. Different weights on
 * things of equal rank is what "not visually consistent" was: the eye reads the
 * difference as meaning something. The height is here too, because blocks sized
 * by their contents lined up across neither column.
 */
function Block({ title, aside, children }: { title?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-y-2">
      {/* Optional, because a block whose content says what it is does not need a
          sentence introducing it. */}
      {title !== undefined && (
        // The heading's rule doubles as the block's control shelf. A setting
        // that governs a chart belongs above it, where it is read before the
        // picture rather than discovered under it — and the rule already draws
        // the line those two things sit on, so nothing new is added to carry it.
        <div className="flex min-w-0 items-baseline justify-between gap-x-3 border-b border-rule pb-1">
          <h3 className="min-w-0 truncate text-[0.8125rem] font-medium text-ink">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * What sits between a chart's own box and the plot inside it.
 *
 * The flamegraph has none: its host element *is* the drawing. `recharts` reserves
 * the y axis on the left and the chart margin on the right, so reading the pointer
 * against the box anchors every zoom to the left of where the reader is pointing.
 */
interface PlotInset {
  left: number;
  right: number;
}

const NO_INSET: PlotInset = { left: 0, right: 0 };

/**
 * What one wheel event does to a window, for both charts.
 *
 * Vertical zooms at the pointer, horizontal pans — the split speedscope and
 * Chrome's Modern mode both use, and the one a trackpad's two-finger swipe
 * expects. Returns `null` when the event carries nothing usable, so a caller can
 * leave the window alone rather than anchor a zoom on a guess.
 */
function wheelWindow(
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

/**
 * The trend's own gutters, in one place so the wheel and the chart cannot drift.
 *
 * Both numbers are handed to `recharts` below *and* subtracted when a wheel
 * event is turned into a fraction of the data. Written twice they would agree
 * until somebody widened the axis to fit a longer duration and left the zoom
 * anchoring 8px off, which is the kind of wrongness nobody files a bug about.
 */
const Y_AXIS_PX = 40;
const CHART_MARGIN = { top: 4, right: 4, bottom: 0, left: 0 } as const;
const TREND_INSET = { left: Y_AXIS_PX + CHART_MARGIN.left, right: CHART_MARGIN.right };

/**
 * `scalePoint`, imported so that it exists.
 *
 * `recharts` resolves a scale by *string* — `"scale" + type` looked up on its
 * `d3-scale` namespace record — and no bundler can follow that, so a scale reaches
 * the bundle only if something imports it statically. The assertion stops the
 * import looking like a stray line: it fails by name, not at a reader's mount.
 */
if (typeof scalePoint !== "function") throw new Error("d3-scale's scalePoint was tree-shaken out of the bundle");

/** The endpoint's own default window, so the first bucket is derived from the same number. */
const DAY_MS = 24 * 3_600_000;

/** How wide a bucket reads, in the units the picker offers. */
const bucketLabel = (ms: number) => (ms < 3_600_000 ? `${ms / 60_000} 分钟` : `${ms / 3_600_000} 小时`);

/**
 * Which bucket width the trend is using, and a way to choose another.
 *
 * It follows the window by default and says so, because a control showing a value
 * nobody chose is indistinguishable from one showing a value they did. A width
 * that cannot be drawn across the window is **offered and refused, with the
 * count**, rather than hidden: the answer to "how fine can I go" is a number.
 */
function BucketPicker({
  value,
  pinned,
  windowMs,
  onPick,
}: {
  value: number;
  pinned: boolean;
  /** How wide the chart's window is, which is what decides whether a width fits. */
  windowMs: number;
  onPick: (ms: number | null) => void;
}) {
  return (
    <Menu label={`每格 ${bucketLabel(value)}${pinned ? "" : "（跟随）"}`}>
      <MenuItem hint="窗口一变就跟着变，够画又不挤" onSelect={() => onPick(null)}>
        跟随窗口
      </MenuItem>
      {BUCKETS.map((ms) => {
        const fits = bucketFits(windowMs, ms);
        return (
          <MenuItem
            key={ms}
            disabled={!fits}
            hint={fits ? undefined : `这段时间要 ${Math.round(windowMs / ms).toLocaleString()} 格，画不下`}
            onSelect={() => onPick(ms)}
          >
            {bucketLabel(ms)}
          </MenuItem>
        );
      })}
    </Menu>
  );
}

/** The flamegraph's axis is a fraction of its own width, so its limit is all of it. */
const WHOLE: TimeWindow = { from: 0, to: 1 };

/**
 * Where you are, once you are no longer looking at all of it.
 *
 * A strip of the whole extent with the current view on it, draggable to pan.
 * Drawn against the *extent* and not the rendered rows, which is why a `recharts`
 * `Brush` cannot serve: a zoom here re-reads the endpoint, so those rows *are* the
 * window. Shown only once there is something to be lost.
 */
function Minimap({
  view,
  limit,
  label,
  onPan,
}: {
  view: TimeWindow;
  limit: TimeWindow;
  label: string;
  onPan: (next: TimeWindow) => void;
}) {
  const whole = limit.to - limit.from;
  const span = view.to - view.from;
  if (whole <= 0 || span >= whole) return null;
  /** Centre the window where the pointer is, in the limit's own units. */
  const panFrom = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const at = (event.clientX - box.left) / box.width;
    if (Number.isFinite(at)) onPan(panTo(view, limit.from + at * whole, limit));
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(((view.from - limit.from) / whole) * 100)}
      className="h-2 cursor-ew-resize rounded-sm bg-sunk"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        panFrom(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) panFrom(event);
      }}
    >
      <div
        className="h-full rounded-sm bg-ink-3"
        style={{ marginLeft: `${((view.from - limit.from) / whole) * 100}%`, width: `${(span / whole) * 100}%` }}
      />
    </div>
  );
}

/** A number column that stays comparable down the page. */
const NUM = "text-right font-mono text-[0.6875rem] tabular-nums";

/**
 * One stage: how long, how often, and how bad the tail is.
 *
 * p95 beside p50 rather than an average: the average of a stage that is usually
 * 200ms and occasionally 90 seconds describes neither. Ordered by the server's
 * total, so the eye lands on the expensive stage first and the two percentiles
 * say whether it is expensive because it is slow or because it runs constantly.
 */
function Stages({
  stages,
  picked,
  onPick,
  onExclude,
}: {
  stages: Report["stages"];
  picked: readonly string[];
  onPick: (names: readonly string[]) => void;
  onExclude: (name: string) => void;
}) {
  const [showRest, setShowRest] = useState(false);
  return (
    <StageTable
      stages={stages}
      picked={picked}
      showRest={showRest}
      onShowRest={setShowRest}
      onPick={onPick}
      onExclude={onExclude}
    />
  );
}

function StageTable({
  stages,
  picked,
  showRest,
  onShowRest,
  onPick,
  onExclude,
}: {
  stages: Report["stages"];
  picked: readonly string[];
  showRest: boolean;
  onShowRest: (open: boolean) => void;
  onPick: (names: readonly string[]) => void;
  onExclude: (name: string) => void;
}) {
  // Shut by default: the reader opens the group that looks expensive — and then
  // the next one, which is why this is a set rather than a single value. The
  // question 巡检规则 raises is "against what", and answering it by closing
  // 巡检规则 is the one thing the control must not do.
  const [openKinds, setOpenKinds] = useState<string[]>([]);
  // The stages below the distribution's own largest gap are the absence of an
  // answer rather than an answer, and `ui.md` gives absence a sentence rather
  // than equal billing.
  const { slow, fast, ceiling } = splitStages(stages);
  return (
    <div>
      <div className={cn("grid gap-x-3 border-b border-rule pb-1 text-[0.6875rem] text-ink-3", COLS)}>
        {/* A head is not only a definition; it is what makes a header row look
            like one — three labelled cells beside one blank read as a header that
            failed to render, not as a self-evident column. */}
        <div>在做什么</div>
        {/* Nouns, and the shortest ones that still separate the two durations:
            what it usually costs against what it costs on a bad day. The exact
            statistic stays one hover away for anybody who wants it. */}
        <Tip label={P50_LABEL}>
          <div className="text-right underline decoration-dotted underline-offset-2">一般</div>
        </Tip>
        <Tip label={P95_LABEL}>
          <div className="text-right underline decoration-dotted underline-offset-2">最慢</div>
        </Tip>
        <div className="text-right">次数</div>
      </div>
      {/* Grouped by kind and shut by default, inside a box that does not grow:
          twenty-four rules summing to 1.1s is one line. Grouping comes from the
          span-name prefix rather than a list, because a list drops every new span
          family into nothing. Radix owns the expand, the keyboard and the ARIA
          (CLAUDE.md 硬约束 4). */}
      <div className="overflow-y-auto overscroll-contain" style={{ maxHeight: PANE_MAX_PX }}>
        <MultiAccordion value={openKinds} onValueChange={setOpenKinds}>
          {groupByKind([...slow, ...(showRest ? fast : [])]).map((group) => (
            <AccordionItem key={group.key} value={group.key}>
              <AccordionTrigger
                className={cn(
                  "grid items-baseline gap-x-3 py-1.5",
                  COLS,
                  // The same treatment its children get. It used to paint a band
                  // across the duration cell alone, which read as a rendering
                  // accident beside a child highlighted across its full width.
                  rowTone(group.rows.length > 0 && group.rows.every((row) => picked.includes(row.name))),
                )}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <ChevronRight
                    size={11}
                    strokeWidth={2}
                    className="shrink-0 self-center text-ink-3 transition-transform duration-150 group-data-[state=open]:rotate-90"
                  />
                  <span className="truncate text-[0.8125rem] text-ink">{group.label}</span>
                  {group.errors > 0 && (
                    <span className="shrink-0 font-mono text-[0.625rem] text-bad">{group.errors} 失败</span>
                  )}
                </span>
                {/* A shut group still answers "did this cost anything", which is
                    usually the whole question — and a total worth showing is a
                    total worth clicking, so it selects the whole kind across the
                    page the same way a leaf selects one stage. Its own control
                    rather than the header's, because the header already means
                    "open me" and one element cannot mean both. */}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPick(group.rows.map((row) => row.name));
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    onPick(group.rows.map((row) => row.name));
                  }}
                  className={cn(NUM, "cursor-pointer text-ink underline decoration-dotted underline-offset-2")}
                >
                  {duration(group.totalMs)}
                </span>
                <span className={cn(NUM, "text-ink-3")}>{group.count}</span>
              </AccordionTrigger>
              <AccordionBody>
                {/* No bar: the one there used to be was scaled to total time while
          the numbers beside it were percentiles, so the longest bar and the largest
          number were different rows. The fold above is what it was reaching for. */}
                {group.rows.map((stage) => (
                  <ContextMenu.Root key={stage.name}>
                    <ContextMenu.Trigger asChild>
                      {/* The row is the control. Clicking selects this stage across the
                whole page — the table and the trace are one selection, not two
                widgets near each other — and clicking the selected one clears it.
                Highlighted rather than filtered: dropping the other rows throws
                away the comparison that made this one worth picking. */}
                      <button
                        type="button"
                        onClick={() => onPick([stage.name])}
                        className={cn(
                          "grid w-full cursor-pointer items-baseline gap-x-3",
                          COLS,
                          "border-b border-rule-soft py-1.5 text-left transition-colors",
                          // Indented from the group's own left edge, which is
                          // what makes the grouping visible at all: without it a
                          // child sits exactly where its parent does and the tree
                          // reads as a flat list with occasional headers.
                          "pl-5",
                          rowTone(picked.includes(stage.name)),
                        )}
                      >
                        {/* The name column scrolls sideways inside itself, because
                            widening it would take the width from the numbers.
                            `overscroll-x-contain` and not just `overflow-x-auto`:
                            this sits inside a vertically scrolling pane, so without
                            it a horizontal drag at the end of the name chains into
                            scrolling the page. `whitespace-nowrap`, not `truncate`
                            — `truncate` is `overflow: hidden`, which would win. */}
                        <div className="flex min-w-0 items-baseline gap-2 overflow-x-auto overscroll-x-contain">
                          {/* The words, with the identifier one hover away. Somebody debugging
                needs `sandbox.create`; somebody asking where four hours went
                does not, and the waterfall below still shows it plainly. */}
                          {isRenamed(stage.name) ? (
                            <Tip label={stage.name}>
                              <span className="whitespace-nowrap text-[0.8125rem] text-ink underline decoration-dotted underline-offset-2">
                                {humanName(stage.name)}
                              </span>
                            </Tip>
                          ) : (
                            <span className="whitespace-nowrap font-mono text-[0.75rem] text-ink">{stage.name}</span>
                          )}
                          {stage.errors > 0 && (
                            <span className="shrink-0 font-mono text-[0.625rem] text-bad">{stage.errors} 失败</span>
                          )}
                        </div>
                        <div className={cn(NUM, "text-ink")}>{duration(stage.p50)}</div>
                        <div className={cn(NUM, "text-ink")}>{duration(stage.p95)}</div>
                        <div className={cn(NUM, "text-ink-3")}>{stage.count}</div>
                      </button>
                    </ContextMenu.Trigger>
                    <ContextMenu.Portal>
                      <ContextMenu.Content className={MENU}>
                        <MenuAction onSelect={() => onPick([stage.name])}>只看这一段</MenuAction>
                        <MenuAction onSelect={() => onExclude(stage.name)}>不看这一段</MenuAction>
                      </ContextMenu.Content>
                    </ContextMenu.Portal>
                  </ContextMenu.Root>
                ))}
              </AccordionBody>
            </AccordionItem>
          ))}
        </MultiAccordion>
      </div>
      {fast.length > 0 && (
        // The sentence was already the fold; making it the control is what turns
        // it from a truncation notice into a way in. It still quotes the ceiling
        // so the reader can see why the rest were not worth a row each, and
        // folding stays the fix — this is the door for the reader who then wants
        // to go deeper, which is the order those two belong in.
        <button
          type="button"
          onClick={() => onShowRest(!showRest)}
          className="cursor-pointer pt-1.5 text-left text-[0.75rem] text-ink-3 transition-colors hover:text-ink"
        >
          {/* Under a millisecond the quoted ceiling rounds to "0ms", and "都在
              0ms 以内" reads as a broken number rather than as a fast stage. */}
          {showRest
            ? `收起另外 ${fast.length} 个`
            : `展开另外 ${fast.length} 个（${ceiling < 1 ? "都不到 1ms" : `都在 ${duration(ceiling)} 以内`}）`}
        </button>
      )}
    </div>
  );
}

/**
 * The ceiling every list on this page is held to — roughly twenty rows.
 *
 * One tick of the watchdog is two dozen spans on its own, and a container sized by
 * its row count walks off the bottom of the viewport and takes the rest of the
 * page with it. The content keeps its true height inside this box, and it scrolls.
 */
const PANE_MAX_PX = 380;

/** One row of the right-click menu, on the same tokens the rest of the panel uses. */
function MenuAction({ onSelect, children }: { onSelect: () => void; children: React.ReactNode }) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="cursor-pointer rounded-md px-2 py-1 outline-none data-[highlighted]:bg-rail"
    >
      {children}
    </ContextMenu.Item>
  );
}

/**
 * One flame row, and the type that sits in it. 20 holds the 0.6875rem meta size
 * from `ui.md`'s scale with room to sit on its baseline.
 */
const CELL_PX = 20;

/**
 * The hues a frame can take, and the ones it may not.
 *
 * `ui.md` gives four hues jobs — 27, 74, 156 and 285 — and a frame landing on any
 * of them would be making a claim about the run. What is left is the cool half of
 * the wheel plus the far violets, spaced far enough apart to tell apart. Not
 * decoration: hue is the only thing saying "same function, two levels up".
 */
const FLAME_HUES = [178, 190, 202, 214, 226, 238, 250, 310, 322, 334, 346];

/** How far a frame is pulled toward the page's own ground. Four depths of tint. */
const FLAME_TINTS = [20, 28, 36, 44];

/**
 * How much of the chart a frame spans, as a percentage.
 *
 * Read off the frame's own laid-out extent rather than divided out of the root's
 * value: after a zoom the chart is showing a subtree and `x0`/`x1` are relative to
 * what is on screen, which is the number the reader wants. A percentage of the
 * whole tree while looking at one branch answers a different question.
 */
const share = ({ x0, x1 }: FlameFrame): string => `${((x1 - x0) * 100).toFixed(1)}%`;

/**
 * The colour of one frame, on our tokens.
 *
 * Hue comes from the frame's own name; everything else comes from the page. One
 * `color-mix` toward `--color-paper` does three jobs: theme-aware with no second
 * palette, chroma dropped at both ends because `paper` is a near-neutral, and a
 * legible label, since `ink` and `paper` are each other's contrast in both themes.
 */
const flameColor = ({ data, highlight }: FlameFrame): string => {
  if (highlight) return "var(--color-accent)";
  // djb2, not the sum of the character codes: a sum gives `turn.a` and `turn.b`
  // neighbouring hues, and the frames a reader most needs to tell apart are
  // siblings whose names differ in one token. 44 combinations for an unbounded set
  // of names, so a deep tree can still collide — survivable, because the colour is
  // an aid to following a frame between levels rather than an identifier.
  let hash = 5381;
  for (let i = 0; i < data.name.length; i += 1) hash = ((hash * 33) ^ data.name.charCodeAt(i)) >>> 0;
  const hue = FLAME_HUES[hash % FLAME_HUES.length];
  // A second, independent mix rather than another slice of the same hash. Bits
  // taken from one hash move together with the bits the hue came from, which put
  // `turn.provider` and `turn.prepare` on the same colour when this was a shift.
  const tint = FLAME_TINTS[(Math.imul(hash, 2654435761) >>> 0) % FLAME_TINTS.length];
  return `color-mix(in oklch, oklch(0.62 0.11 ${hue}), var(--color-paper) ${tint}%)`;
};

/**
 * A wheel listener that is allowed to say no.
 *
 * React registers `onWheel` as a **passive** listener, where `preventDefault()`
 * only logs a warning — and what needs refusing is the trackpad's back/forward
 * gesture, which loses the page mid-pan. `overscroll-behavior` governs scroll
 * chaining, and these elements do not scroll. So `{ passive: false }`, by hand.
 */
function useWheel(target: React.RefObject<HTMLElement | null>, onWheel: (event: WheelEvent) => void) {
  const latest = useRef(onWheel);
  latest.current = onWheel;
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const handler = (event: WheelEvent) => latest.current(event);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [target]);
}

/**
 * `d3-flame-graph`'s whole lifecycle, apart from the markup around it.
 *
 * The library is imperative and older than hooks, so three rules hold. It creates
 * the chart once and calls `destroy()` in the cleanup — clearing `innerHTML`
 * leaves d3 transitions alive against a detached node. It takes new data through
 * `update()`, so zoom and search survive. And it re-creates on a *shape* change.
 */
function useFlameChart({
  tree,
  self,
  picked,
  zoom,
}: {
  tree: FlameNode;
  self: boolean;
  picked: readonly string[];
  zoom: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  /** The unscaled box. What the chart's width is derived from. */
  const port = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const chart = useRef<FlameGraph | null>(null);
  /**
   * The newest tree, for the effect that must not depend on it: a dependency would
   * put the rebuild back, while a ref written during render gives the builder the
   * current value without making it a reason to rebuild.
   */
  const latest = useRef(tree);
  latest.current = tree;
  const [width, setWidth] = useState(0);
  // The frame the reader clicked into, so the way back out can name it. Held
  // here rather than in the block above, because the control that uses it sits
  // on the chart and only this component knows when a click zoomed.
  const [zoomed, setZoomed] = useState<string | null>(null);

  // The library takes a width in pixels and does not observe its container.
  // `ResizeObserver` rather than a window listener: this pane is inside a
  // resizable split. Measured once directly as well, because `ResizeObserver`
  // fires asynchronously and waiting only for it leaves the chart unbuilt through
  // the first paint. The **viewport**, not the chart inside it: `host` sits in a
  // wrapper sized `100/zoom` percent, so measuring the unscaled parent is what
  // keeps the quantity independent of `zoom` and stops the loop closing.
  useEffect(() => {
    const el = port.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width || el.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Whether there is a box to draw in yet — not how wide it is.
   *
   * A pixel width belongs in the effect that calls `.width().update()`; putting it
   * in the *create* effect means every layout change destroys and rebuilds the
   * chart, and layout changes for reasons unrelated to this view.
   */
  const ready = width > 0;
  /** The measurement at build time, read without becoming a reason to rebuild. */
  const measured = useRef(width);
  measured.current = width;

  useEffect(() => {
    const el = host.current;
    if (!el || !ready) return;
    const graph = flamegraph()
      .width(measured.current)
      .cellHeight(CELL_PX)
      // Frames under a pixel are not drawn. This is what keeps a deep tree from
      // costing a node per invisible sliver, and it is the library's own answer
      // rather than a cap we impose on depth.
      .minFrameSize(1)
      .selfValue(self)
      .sort(true)
      .transitionDuration(0)
      .setColorMapper(flameColor)
      // `frame.value` and not `frame.data.value`: the first is what the frame was
      // laid out by and follows the 自身 / 含下游 toggle, the second is always self
      // time. The words in the frame, the identifier after them — the detail line
      // is wide enough to carry both rather than making the reader choose.
      .setLabelHandler((frame) =>
        [
          humanName(frame.data.name),
          ...(isRenamed(frame.data.name) ? [frame.data.name] : []),
          duration(frame.value),
          share(frame),
        ].join(" · "),
      )
      .setDetailsElement(details.current)
      // The library's own status line, silenced: it wrote into the same element
      // the hover detail uses. The accent on the matching frames is the feedback.
      .setSearchHandler(() => {})
      // Clicking a frame already zoomed into it before this runs; the library
      // does that itself. All this adds is somebody remembering, so the reader
      // has a way back that says where they are.
      .onClick((frame) => setZoomed(frame.parent === null ? null : frame.data.name));
    select(el).datum(latest.current).call(graph);
    chart.current = graph;
    return () => {
      graph.destroy();
      chart.current = null;
    };
    // Not `tree`: new data goes through `update()` below, and a `tree` dependency
    // destroyed and rebuilt the whole chart on every wheel notch of the trend.
    // `ready`, not `width`, for the same reason — width changes travel through the
    // `update()` effect, and only the first non-zero measurement is a reason to
    // build a chart at all. `self` stays: it is read when frames are laid out.
  }, [ready, self]);

  // New data into the existing chart. `update` reuses the nodes, so the reader's
  // zoom and search survive a refresh and nothing re-enters — which is also what
  // stops the library's un-configurable 250ms enter transition from firing on
  // every read.
  useEffect(() => {
    chart.current?.update(tree);
  }, [tree]);

  // A separate effect so a selection highlights frames instead of rebuilding the
  // chart under the reader's cursor. `search` takes one string and matches it
  // against frame names, so several names go in as a regex alternation. Names in,
  // names out — a kind label is not something a frame has ever carried.
  useEffect(() => {
    chart.current?.search(picked.length > 0 ? picked.map(escapeRegExp).join("|") : "");
  }, [picked]);

  // Re-lay-out at the zoomed width rather than rebuilding: `update` reuses the
  // existing nodes, so nothing re-enters and the library's un-configurable
  // 250ms enter transition never fires. Rebuilding on every wheel notch would
  // animate continuously.
  useEffect(() => {
    if (width > 0) chart.current?.width(width / zoom).update();
  }, [width, zoom]);

  // The whole of this chart's appearance, because none of the library's own
  // arrives: `d3-flame-graph` self-imports `d3-flamegraph.css`, which the bundler
  // emits as `web/dist/main.css` while `web/index.html` loads only `app.css`. So
  // every rule below is load-bearing rather than a tweak on a working default. The
  // label is an HTML `div` inside a `foreignObject`, not SVG text, so it is reached
  // by class and not by element.
  return { host, port, details, chart, width, zoomed, setZoomed };
}

function Flame({ tree, self, picked }: { tree: FlameNode; self: boolean; picked: readonly string[] }) {
  const [view, setView] = useState<TimeWindow>({ from: 0, to: 1 });
  const zoom = view.to - view.from;
  const { host, port, details, chart, zoomed, setZoomed } = useFlameChart({ tree, self, picked, zoom });
  useWheel(port, (event) => {
    const el = port.current;
    if (!el) return;
    // 0.002 of the whole width is the floor: past that a frame is thinner than its
    // own border.
    const next = wheelWindow(event, el, view, WHOLE, 0.002);
    if (!next) return;
    // Refused whether or not the window moved. A pan that is already at the end
    // of the range still has to say no, or the browser reads the rest of the
    // gesture as a back-navigation and the page goes with it.
    event.preventDefault();
    setView(next);
  });

  return (
    <div className="mt-2">
      {/* One line, fixed height, holding whichever of two things is true: where the
          reader has zoomed to, or what they are pointing at. The library owns the
          second and writes into this node, so nothing else may be rendered inside
          it and the height is set here rather than earned from content. */}
      <div className="flex h-5 items-center gap-2">
        {(zoomed !== null || zoom < 1) && (
          <button
            type="button"
            onClick={() => {
              chart.current?.resetZoom();
              setZoomed(null);
              setView({ from: 0, to: 1 });
            }}
            className={cn(
              "shrink-0 cursor-pointer rounded-md bg-sunk px-1.5 py-0.5 font-mono text-[0.625rem] text-ink-2",
              "transition-colors hover:text-ink",
            )}
          >
            ← 回到全部
          </button>
        )}
        {zoomed !== null && <span className="shrink-0 text-[0.6875rem] text-ink-3">看的是 {humanName(zoomed)}</span>}
        {zoomed === null && zoom < 1 && (
          <span className="shrink-0 text-[0.6875rem] text-ink-3">放大到 {(1 / zoom).toFixed(0)}×</span>
        )}
        <div ref={details} className="min-w-0 truncate font-mono text-[0.6875rem] text-ink-2" />
      </div>
      <div className="mb-1">
        <Minimap view={view} limit={WHOLE} label="看的是哪一段" onPan={setView} />
      </div>

      {/* The viewport. The chart inside it is rendered `1/zoom` times wider and
          slid left, which is what "show a narrower slice across the full pane"
          means for an axis that is folded time rather than a clock. */}
      <div ref={port} className="overflow-hidden overscroll-x-contain">
        <div style={{ transform: `translateX(${-view.from * 100}%)`, width: `${100 / zoom}%` }}>
          <div
            ref={host}
            className={cn(
              // Same rule as the trend: a chart is neither a control nor a
              // paragraph, so it takes no focus ring and no text selection.
              "select-none",
              "[&_.d3-flame-graph-label]:truncate [&_.d3-flame-graph-label]:px-1",
              "[&_.d3-flame-graph-label]:font-mono [&_.d3-flame-graph-label]:text-[0.6875rem]",
              // 20px, which is `CELL_PX`. Written out rather than interpolated:
              // Tailwind reads class names out of the source at build time, so a
              // template literal produces a class that exists in the DOM and in no
              // stylesheet. `CELL_PX` moving means this line moves with it.
              "[&_.d3-flame-graph-label]:leading-[20px] [&_.d3-flame-graph-label]:text-ink",
              // A hairline between frames, in the surface colour, so stacked frames
              // read as separate without a border around each.
              "[&_rect]:stroke-paper [&_rect]:[stroke-width:0.5]",
              // The hover affordance: every frame is a click that zooms. `ink` on the
              // outline rather than a fill change, so the frame's own colour still
              // says which function it is.
              "[&_.frame]:cursor-pointer",
              "[&_.frame:hover_rect]:stroke-ink [&_.frame:hover_rect]:[stroke-width:1.5]",
              // The library fades a zoomed frame's ancestors rather than removing
              // them, and its own `.fade` rule is in the stylesheet nothing loads.
              "[&_.fade]:opacity-40",
            )}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The flamegraph block: what the scope's time is actually spent in.
 *
 * Self time is the default: total time is what the tree already says by nesting.
 * A flamegraph never overflows sideways — each level partitions its parent's
 * width — so depth costs height, and the block scrolls inside its pane. The server
 * bounds the tree at 64 levels, since that walk would not terminate on a cycle.
 */
function FlameBlock({ folded, picked }: { folded: Report["flame"]; picked: readonly string[] }) {
  const [self, setSelf] = useState(true);
  const tree = useMemo(() => flameTree(folded), [folded]);
  const depth = flameDepth(tree);

  if (folded.length === 0) return null;
  return (
    // `Block`, like every other section here; its toggle goes in the same shelf
    // the bucket picker uses.
    <Block
      // Named for the question it answers, not for the chart it is: this is every
      // run in the scope stacked together, the trend beside it is one number per
      // bucket over time, and two charts of the same spans need that said.
      title="耗时分布"
      aside={
        <Segments value={self ? "self" : "total"} onValueChange={(next) => setSelf(next === "self")}>
          {/* Not two skins on one chart: 自身 makes a frame as wide as the time it
              spent itself, 含下游 as wide as everything it called. A parent that
              only waits is full width under one and a sliver under the other. */}
          <Segment value="self">自身</Segment>
          <Segment value="total">含下游</Segment>
        </Segments>
      }
    >
      <div
        className="overflow-y-auto overscroll-contain"
        style={{ minHeight: Math.min(depth * CELL_PX + 8, PANE_MAX_PX), maxHeight: PANE_MAX_PX }}
      >
        <Flame tree={tree} self={self} picked={picked} />
      </div>
    </Block>
  );
}

/**
 * p50 and p95 over the window, one point per bucket.
 *
 * Two lines and not one: a p50 that holds flat while the p95 climbs is a fleet
 * that is fine most of the time and occasionally is not, which one averaged line
 * hides. A sample is one trace, so this asks "how long did a unit of work take"
 * rather than a question that moves whenever the shape of the tracing changes.
 */
function Trend({
  trend,
  windowMs,
  window,
  limit,
  bucketMs,
  onWindow,
}: {
  trend: Report["trend"];
  windowMs: number;
  /** How wide one point is, so the gaps can be filled at the same spacing. */
  bucketMs: number;
  /** What the page is currently showing, so a zoom starts from it. */
  window: TimeWindow;
  /** How far the data goes; a zoom cannot leave it. */
  limit: TimeWindow;
  /** Drag and wheel write the same thing, and every block reads it. */
  onWindow: (next: TimeWindow | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useWheel(box, (event) => {
    const el = box.current;
    if (!el) return;
    // A minute is the floor the endpoint already enforces, so zooming below it
    // would ask for buckets the server will not produce.
    const next = wheelWindow(event, el, window, limit, 60_000, TREND_INSET);
    if (!next) return;
    // Unconditionally, even when the window did not move: a pan already at the end
    // of its range is exactly when the gesture keeps going, and the browser reads
    // the rest of it as a back-navigation.
    event.preventDefault();
    onWindow(next);
  });
  // Dense, so every bucket has a slot on the axis whether or not anything landed
  // in it. The empty ones carry `null`, which `connectNulls` then joins across —
  // legibly, because the axis is a number line and the join is drawn the width of
  // the silence.
  const data = fillBuckets(trend, window, bucketMs);
  // Asked of what is *in the window*, not of what the server returned: panning to
  // a quiet stretch otherwise draws axes and an empty plot over a fifth of the
  // page. Two points, because one point is not a line.
  // Adjacent pairs, not points: an area is drawn *between* neighbours and
  // `connectNulls` is false by design, so ten runs scattered one-per-bucket are ten
  // points and no line. Counting points passed them and drew an empty box.
  const withData = data.filter((point) => point.p50 !== null).length;
  if (withData < 2) {
    return (
      // Inside the chart's own box, at the chart's own height: a slot the size of
      // the thing that is missing says which thing is missing. `sunk` is already
      // this page's surface for what a machine produced.
      <div className="grid h-[7.5rem] place-items-center rounded-md bg-sunk text-center text-[0.75rem] text-ink-3">
        {/* Which of the two absences it is. "Nothing was recorded here" and
            "nothing has been recorded yet" send the reader to different places,
            and the window is what tells them apart. */}
        {trend.length === 0 ? "这段时间没有活动。" : "还不够两个时段的数据。"}
      </div>
    );
  }
  return (
    <div
      // Not a control and not a paragraph: `ResponsiveContainer` renders a
      // focusable wrapper, so clicking the chart drew a focus ring and selected the
      // SVG as text. Scoped here — a real control still needs its ring.
      ref={box}
      tabIndex={-1}
      // `touch-none` is the same refusal for a touchscreen, where the gesture
      // never reaches a wheel listener at all.
      className="h-[7.5rem] touch-none select-none overscroll-x-contain outline-none [&_*]:outline-none"
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={CHART_MARGIN}>
          {/* A number line, not a list of categories. A category axis gives every
              bucket the same slot whether or not there is anything in it, so the
              shape of the line becomes the shape of the *bucketing* rather than of
              time — and `wheelWindow` computes a fraction of the plot, which only a
              linear axis turns into the instant the pointer is over. It also
              resolves to `scaleLinear`, which the y axis already keeps alive. */}
          <XAxis
            dataKey="at"
            type="number"
            // Pinned to the window rather than to the data. The extremes of a
            // sparse series are not the edges of the window, so an axis fitted to
            // the points would silently re-scale itself as buckets came and went.
            domain={[window.from, window.to]}
            tickFormatter={(at: number) => trendLabel(at, windowMs, bucketMs)}
            {...AXIS}
            tickLine={false}
            axisLine={false}
            // No `interval` here: that prop is a category-axis control and on a
            // number line it fights the library's own round tick values.
            minTickGap={40}
          />
          <YAxis
            {...AXIS}
            tickLine={false}
            axisLine={false}
            width={Y_AXIS_PX}
            tickFormatter={(v: number) => duration(v)}
          />
          {/* The head line is the axis key, which is now an instant rather than a
              printed label — so it is spelled the same way the ticks are. */}
          <ChartTooltip format={duration} label={(at) => trendLabel(Number(at), windowMs, bucketMs)} />
          {/* `connectNulls`, because the x axis is a number line.
              The objection to joining across a gap — that a quiet ten minutes and
              ten with no data would draw identically — is an objection to a
              *category* axis, where every bucket gets the same slot whatever the
              clock says. Here the axis is `type="number"` over the window, so the
              horizontal distance between two points *is* the length of the quiet
              stretch, drawn to scale. Without it a sporadic fleet drew nothing at
              all: measured at ten runs across a day, zero adjacent pairs at every
              width up to an hour, because each run had its own bucket and holes
              either side. `dot` stays, so a measurement that was taken is still
              marked and the line between two of them is not mistaken for data. */}
          <Area
            type="monotone"
            dataKey="p50"
            name={P50_LABEL}
            stroke="var(--color-ink-3)"
            fill="var(--color-sunk)"
            dot={{ r: 1.5 }}
            connectNulls
          />
          <Area
            type="monotone"
            dataKey="p95"
            name={P95_LABEL}
            stroke="var(--color-warn)"
            fill="transparent"
            dot={{ r: 1.5 }}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * The read, and the trace opened on top of it.
 *
 * Two requests rather than one: opening a trace re-asks with `trace=`, and the
 * aggregate is held from the previous answer so the stage list does not blink out
 * and back. A failed second read leaves the first standing — `readTelemetry` has
 * already put the reason in a toast.
 */
function useTelemetry(
  scope: TelemetryScope,
  windowMs: number | undefined,
  chosen: TimeWindow | null,
  bucketMs: number,
) {
  /**
   * How far the data goes, which is a different fact from what is on screen.
   *
   * `report.window` is the window that was *asked for*, so using it as the zoom
   * limit makes the limit equal the current view the moment anybody zooms. Taken
   * instead from the answer to the read nobody narrowed: the endpoint's own account
   * of the full stretch, rather than clock arithmetic that drifts per render.
   */
  const [extent, setExtent] = useState<TimeWindow | null>(null);
  // The scope is taken apart into the two primitives it is made of. Every caller
  // passes an object literal, so a dependency on the object is a new identity on
  // each of their renders — and suppressing the check is the same bug with the
  // warning turned off.
  const kind = scope.kind;
  const id = scope.kind === "system" ? 0 : scope.id;
  // The window taken apart the same way and for the same reason: `chosen` is a
  // fresh object on every wheel notch, and depending on the object would re-read
  // on each one even when the two numbers had not moved.
  const from = chosen?.from ?? null;
  const to = chosen?.to ?? null;

  /**
   * The six primitives above *are* the identity of the answer, so they are the key.
   *
   * `keepPreviousData` is the documented way to never null `report`: while the next
   * window is being fetched the previous answer stays drawn. The throw is
   * deliberate — `readTelemetry` resolves to `null` on a refusal and has already
   * put the reason in a toast, and an error leaves the last good answer standing.
   */
  const { data, isFetching, isPlaceholderData } = useQuery({
    queryKey: ["telemetry", kind, id, windowMs ?? null, from, to, bucketMs],
    queryFn: async () => {
      const target: TelemetryScope = kind === "system" ? { kind: "system" } : { kind, id };
      const answer = await readTelemetry(
        target,
        windowMs,
        from !== null && to !== null ? { from, to } : null,
        bucketMs,
      );
      if (!answer) throw new Error("telemetry read failed");
      return answer;
    },
    placeholderData: keepPreviousData,
  });
  const report: Report | null = data ?? null;

  // Only the unnarrowed read knows the whole stretch. `isPlaceholderData` is the
  // other half: while an unnarrowed read is in flight the previous — possibly
  // narrowed — answer is on screen, and taking the extent from it would clamp a
  // zoom back out to the window being zoomed out of.
  useEffect(() => {
    if (from === null && report && !isPlaceholderData) setExtent(report.window);
  }, [from, report, isPlaceholderData]);

  return { report, loading: isFetching, extent };
}

/**
 * The trend, its bucket control and the two ways back out of a zoom.
 *
 * One component because those four things are one control surface: the picker
 * governs the chart, the strip says where in the whole stretch the chart is, and
 * the button undoes both.
 */
function TrendBlock({
  report,
  bucketMs,
  pinnedBucket,
  onPickBucket,
  window,
  limit,
  chosen,
  onWindow,
}: {
  report: Report;
  bucketMs: number;
  pinnedBucket: number | null;
  onPickBucket: (ms: number | null) => void;
  window: TimeWindow;
  limit: TimeWindow;
  /** Whether the reader narrowed it, which is the only thing 回到整段时间 needs. */
  chosen: TimeWindow | null;
  onWindow: (next: TimeWindow | null) => void;
}) {
  return (
    <Block
      title="每次运行的耗时"
      aside={
        <BucketPicker
          value={bucketMs}
          pinned={pinnedBucket !== null}
          windowMs={window.to - window.from}
          onPick={onPickBucket}
        />
      }
    >
      <Trend
        trend={report.trend}
        windowMs={report.windowMs}
        bucketMs={bucketMs}
        window={window}
        limit={limit}
        onWindow={onWindow}
      />
      {/* The same strip the flamegraph has, against the whole stretch the data
          covers — which is what a `Brush` could not be. */}
      <Minimap view={window} limit={limit} label="看的是哪一段" onPan={onWindow} />
      {chosen !== null && (
        <button
          type="button"
          onClick={() => onWindow(null)}
          className="cursor-pointer self-start text-[0.75rem] text-ink-3 transition-colors hover:text-ink"
        >
          ← 回到整段时间
        </button>
      )}
    </Block>
  );
}

/**
 * What the reader has singled out, and what they have hidden.
 *
 * Two pieces of state and the three rules that operate on them, together because
 * they are one idea — "which stages am I looking at" — and apart from `Telemetry`,
 * whose own job is the layout and the read.
 */
function useSelection() {
  /**
   * What the reader has selected, as the set of span names it covers.
   *
   * A set of names rather than a search string: the flamegraph's frames carry raw
   * span names, so resolving the selection to names *here*, once, is what asks both
   * surfaces the same question in the same vocabulary. It highlights and does not
   * filter — the rows around a selection are what made it worth selecting.
   */
  const [picked, setPicked] = useState<readonly string[]>([]);
  /** Names the reader has said they do not want to see. Right-click, 不看这一段. */
  const [excluded, setExcluded] = useState<readonly string[]>([]);
  return {
    picked,
    excluded,
    /** Selecting what is already selected clears it; that is the only way back. */
    pick: (names: readonly string[]) =>
      setPicked((current) => (current.length === names.length && names.every((n) => current.includes(n)) ? [] : names)),
    exclude: (name: string) => setExcluded((names) => (names.includes(name) ? names : [...names, name])),
    restore: (name: string) => setExcluded((names) => names.filter((other) => other !== name)),
    restoreAll: () => setExcluded([]),
  };
}

export function Telemetry({
  scope,
  windowMs,
  trend: showTrend = false,
  empty = "还没有跑过任何活。",
}: {
  scope: TelemetryScope;
  windowMs?: number;
  /** The project view wants the shape over time; a single requirement has too few points for one. */
  trend?: boolean;
  empty?: string;
}) {
  const { picked, excluded, pick, exclude, restore, restoreAll } = useSelection();
  /**
   * The stretch of time the page is showing, when the reader has chosen one.
   *
   * `null` means "the caller's default window", which is what a fresh page shows.
   * Both the brush and the wheel write a real range into it, and every block reads
   * it through the one query.
   */
  const [chosen, setChosen] = useState<TimeWindow | null>(null);
  /**
   * A bucket width the reader pinned, or `null` to follow the window.
   *
   * Following is the default because a fixed hour leaves one bucket once the
   * reader zooms past an hour, and a line needs two points. Pinning exists because
   * the derived value is a guess, and a guess should be overridable.
   */
  const [pinnedBucket, setPinnedBucket] = useState<number | null>(null);
  // The bucket is derived from what is being *asked for*, not from what came back
  // — otherwise the read needs the answer to the read. When nothing is chosen that
  // is the caller's own window, the same number the endpoint derives its own from.
  // `bucketFor` was wired and its inverse was not, so pinning a width changed the
  // bucket and left the window — and a width wider than the window collapsed the
  // whole thing into one point, which is not a line.
  const { bucketMs, askedWindowMs } = trendScale(pinnedBucket, chosen, windowMs, DAY_MS);
  const { report, loading, extent } = useTelemetry(scope, askedWindowMs, chosen, bucketMs);
  /**
   * The stretch on screen: what the reader chose, else what the server sent.
   *
   * The clock arithmetic is the last resort, and that order is the point:
   * preferring it would put the charts on this browser's `now` while the limit came
   * from the endpoint — two windows that agree only when the two clocks do.
   */
  const shownWindow = chosen ?? report?.window ?? { from: Date.now() - (askedWindowMs ?? DAY_MS), to: Date.now() };
  /**
   * How far a zoom or a pan may reach.
   *
   * `dataWindow` first: the first and last instant this scope actually has a span
   * for, so a pan cannot walk into stretches the store is empty in. The unnarrowed
   * read's window is the fallback, and `report.window` is never used directly —
   * that is the window the last request *asked for*, so it follows the view.
   */
  const limit = report?.dataWindow ?? extent ?? report?.window ?? shownWindow;

  if (!report) {
    return <div className="py-4 text-[0.75rem] text-ink-3">{loading ? "读取中…" : empty}</div>;
  }
  if (!hasSpans(report.stages, report.traces)) {
    return <div className="py-4 text-[0.75rem] text-ink-3">{empty}</div>;
  }

  const shown = report.stages.filter((stage) => !excluded.includes(stage.name));

  return (
    // Two charts and two tables. Time on the left, tables on the right, and the
    // window scopes all four: it feeds the one query every block reads, so
    // narrowing it changes what the tables count and not only what the chart draws.
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-y-6">
        {/* No `trend.length >= 2` here: `Trend` draws its own empty slot, and
            gating the block on the point count took the picker and the way back
            out with it. A chart with nothing in it is a state; a chart with its
            controls removed is a trap. */}
        {showTrend && (
          <TrendBlock
            report={report}
            bucketMs={bucketMs}
            pinnedBucket={pinnedBucket}
            onPickBucket={setPinnedBucket}
            window={shownWindow}
            limit={limit}
            chosen={chosen}
            onWindow={setChosen}
          />
        )}

        <FlameBlock folded={report.flame} picked={picked} />
      </div>

      <div className="flex min-w-0 flex-col gap-y-6">
        {/* Titled like its neighbours: three titled blocks and one bare table read
            as a layout that lost a heading, whatever the columns say for
            themselves. */}
        <Block title="各环节耗时">
          <Stages stages={shown} picked={picked} onPick={pick} onExclude={exclude} />
          {excluded.length > 0 && <Excluded names={excluded} onClear={restoreAll} onRestore={restore} />}
        </Block>
        <Slices slices={report.slices} />
      </div>
    </div>
  );
}

/**
 * A requirement's time, split by the slice that spent it.
 *
 * The one thing the stage table cannot say, because stages answer *what* the time
 * went on rather than *which piece of the work*. Bars here and nowhere else on
 * this page, for the one reason a bar is ever worth drawing: the slices partition
 * the requirement's spans, so a width really is a share of one total.
 */
function Slices({ slices }: { slices: Report["slices"] }) {
  if (slices.length < 2) return null;
  const total = slices.reduce((sum, row) => sum + row.totalMs, 0) || 1;
  return (
    <section className="flex flex-col gap-y-2">
      <h3 className="border-b border-rule pb-1 text-[0.8125rem] font-medium text-ink">各切片耗时</h3>
      <div className="flex flex-col gap-y-1.5">
        {slices.map((row) => (
          <div key={row.sliceId ?? "none"} className="grid grid-cols-[6rem_minmax(0,1fr)_4rem] items-center gap-x-3">
            {/* NULL is a row, not a filter: planning turns, the draft card and the
                roster belong to no slice, and leaving them out would make these add
                up to less than the requirement with nothing explaining the gap. */}
            <span className="truncate text-[0.75rem] text-ink-2">
              {row.sliceId === null ? "没归到切片" : `切片 ${row.sliceId}`}
            </span>
            <div className="h-1.5 rounded-full bg-sunk">
              <div
                className={cn("h-full rounded-full", row.errors > 0 ? "bg-bad" : "bg-ink-3")}
                style={{ width: `${(row.totalMs / total) * 100}%` }}
              />
            </div>
            <span className={cn(NUM, "text-ink")}>{duration(row.totalMs)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
/**
 * What the reader has hidden, and the way back.
 *
 * An exclusion nobody can see is a page quietly lying about its own totals, so
 * it is stated wherever it is in force, with each name its own way out.
 */
function Excluded({
  names,
  onClear,
  onRestore,
}: {
  names: readonly string[];
  onClear: () => void;
  onRestore: (name: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[0.75rem] text-ink-3">
      <span>不看：</span>
      {names.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => onRestore(name)}
          className="cursor-pointer rounded-md bg-sunk px-1.5 py-0.5 transition-colors hover:text-ink"
        >
          {humanName(name)} ×
        </button>
      ))}
      <button type="button" onClick={onClear} className="cursor-pointer underline transition-colors hover:text-ink">
        全部恢复
      </button>
    </div>
  );
}

/** The host's own scope, hoisted so the effect below is not re-run by a new object each render. */
const HOST: TelemetryScope = { kind: "system" };

/**
 * 系统耗时, as a page of its own.
 *
 * In 设置 because it is the thing you go looking for once, on the day the panel
 * feels slow — `ui.md` puts exactly that there. The window is the endpoint's own
 * default day: a week is the project view's question ("is this project getting
 * slower"), the host's is "is it slow now".
 */
export function SystemTiming() {
  return (
    <>
      <Head title="系统耗时" note="这台机器上所有活动的耗时，最近一天" />
      <Telemetry scope={HOST} trend empty="还没有记下任何系统活动。" />
    </>
  );
}
