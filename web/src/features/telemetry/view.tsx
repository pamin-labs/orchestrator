import { useEffect, useMemo, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { select } from "d3-selection";
import flamegraph, { type FlameFrame, type FlameGraph } from "d3-flame-graph";
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
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
import { Accordion, AccordionBody, AccordionItem, AccordionTrigger } from "../requirement/accordion";
import { Menu, MenuItem } from "../../ui/menu";
import {
  fillBuckets,
  BUCKETS,
  bucketFits,
  bucketFor,
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
 * Three surfaces read this and they are the same component with a different
 * scope, because they are the same question asked about different work. A
 * requirement asks it about itself, a project asks it across its requirements,
 * and the host asks it about the work that belongs to no project.
 *
 * Two libraries, and the split between them is the split between the questions.
 * The waterfall and the trend are `recharts`, already bundled for 成本, so they
 * cost nothing new: a Gantt is a stacked bar with a transparent first segment.
 * The flamegraph is `d3-flame-graph`, 22KB, which is the one thing here that is
 * genuinely somebody else's algorithm — partitioning a hierarchy into frames and
 * zooming into one. `@grafana/flamegraph` was measured at 6.16MB and a second
 * React instance for the same picture, and is not here.
 *
 * Both render SVG, deliberately. A canvas flamegraph is a single node with an
 * image in it, and every render state below — empty, one trace, deep nesting, a
 * failed span — would have to be checked by eye forever.
 *
 * The accent appears once in this feature and nowhere else: on a frame the
 * reader searched for by name. `ui.md` reserves it for "needs you", and a frame
 * somebody just asked for is the nearest a timing view comes to that. Failure is
 * `bad`, the same vocabulary a failed gate uses.
 *
 * The flamegraph is the one place on this page with more than one hue, and it
 * earns them: a frame's colour is the only thing saying "this is the same
 * function you saw two levels up", which is why `setColorMapper` replaces the
 * library's palette rather than removing colour from it. There is no orange —
 * the classic flamegraph ramp is exactly the category reflex `ui.md` refuses —
 * and no hue that `ui.md` has already given a job to.
 */

/** One menu surface, because the stage rows and the waterfall both raise one. */
const MENU =
  "z-50 min-w-44 rounded-lg border border-rule bg-paper p-1 text-[0.8125rem] text-ink shadow-[0_10px_30px_var(--shade)]";

/**
 * How a row looks, given two independent states.
 *
 * Three appearances, not two. `hover:bg-rail` after `bg-accent-soft` is a later
 * rule on the same property, so a selected row lost its selection the moment the
 * pointer crossed it — the hover was painting over the state rather than on top
 * of it. Selected and hovered are orthogonal, so the selected row gets its own
 * hover shade and the two never collide.
 */
const rowTone = (selected: boolean) => (selected ? "bg-accent-soft hover:bg-accent-soft/60" : "hover:bg-rail");

/** A name is a literal in the flamegraph's search, and `.` and `/` are not. */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The four columns, in one place because three rows have to agree on them.
 *
 * `auto` on the three numeric tracks rather than fixed rem widths. They were
 * 3.5rem/3.5rem/3rem, sized for the widest duration anybody imagined, and in the
 * right-hand column of a split that left the name column too narrow to hold a
 * name — every one of 巡检…, 代码…, 容器…, 接口…, prefl…, 合并… was an ellipsis,
 * so the column saying *what* was the one column that could not be read while
 * three numeric ones sat at full width. `auto` gives each number exactly what it
 * needs and hands the rest to `minmax(0,1fr)`.
 *
 * `次数` stays a column rather than moving to a tooltip: it is the cheapest
 * of the three to render and the one that proves a brushed window took effect.
 */
const COLS = "grid-cols-[minmax(0,1fr)_auto_auto_auto]";

/**
 * One block: a heading, a rule under it, and the thing itself.
 *
 * Four sections were writing the same `<h3>` four times and drifting — one at
 * `text-ink-3` and `0.75rem` where the others were `font-medium` at `0.8125rem`,
 * and the flamegraph's had no rule at all. Different weights on things of equal
 * rank is what "not visually consistent" was: the eye reads the difference as
 * meaning something.
 *
 * The height is here too. The blocks were sized by their contents — a 7.5rem
 * chart beside a 380px table beside a flamegraph as tall as its tree — so
 * nothing lined up across the two columns.
 */
function Block({ title, aside, children }: { title?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-y-2">
      {/* Optional, because a block whose content says what it is does not need a
          sentence introducing it. The stage table's heading read 每一段花了多久
          directly above columns of names and durations, which is the same fact
          twice — and deleting it was faster than finding better words for it. */}
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
 * The flamegraph has none: its host element *is* the drawing, so a pointer
 * two-thirds across the box is two-thirds across the data. `recharts` is not
 * like that — it reserves the y axis on the left and the chart margin on the
 * right, and the plot is what is left over. Reading the pointer against the box
 * on that one therefore anchored every zoom about 40px to the left of where the
 * reader was pointing, which is 11% of a half-width column: the trend drifted
 * under the cursor while the flamegraph stayed put, and that difference between
 * two charts on the same page is what got reported.
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
 * expects. It used to read every wheel as a zoom at a fixed 1.2 per event, which
 * on a trackpad is fifty events per gesture and three orders of magnitude in a
 * flick: "太灵敏" was an accurate description of multiplying by 1.2 fifty times.
 *
 * Returns `null` when the event carries nothing usable, so a caller can leave
 * the window alone rather than anchor a zoom on a guess.
 */
function wheelWindow(
  event: React.WheelEvent<HTMLDivElement>,
  window: TimeWindow,
  limit: TimeWindow,
  minSpan: number,
  inset: PlotInset = NO_INSET,
): TimeWindow | null {
  const box = event.currentTarget.getBoundingClientRect();
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
  // catches the wheel: a scroll over the `22.0s` gutter is a real gesture at a
  // negative fraction, and anchoring there would zoom about a point off-screen.
  // The edge is what the reader means when they point at the edge.
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

/** The endpoint's own default window, so the first bucket is derived from the same number. */
const DAY_MS = 24 * 3_600_000;

/** How wide a bucket reads, in the units the picker offers. */
const bucketLabel = (ms: number) => (ms < 3_600_000 ? `${ms / 60_000} 分钟` : `${ms / 3_600_000} 小时`);

/**
 * Which bucket width the trend is using, and a way to choose another.
 *
 * It follows the window by default and says so, because a control showing a
 * value nobody chose is indistinguishable from one showing a value they did.
 * 跟随窗口 puts it back.
 *
 * A menu rather than the segmented strip it was. Seven segments — 跟随 plus six
 * widths — do not fit the half-width column this sits in, so every label broke
 * mid-word into two lines (`1 分` over `钟`) and the strip took three rows under
 * the chart. A strip is the right shape for two or three choices that are worth
 * seeing at once; six units of time are a list, and a list belongs behind one
 * click with the current one named on the trigger.
 *
 * A width that cannot be drawn across the window is **offered and refused, with
 * the count**, rather than hidden. It is the question the reader is asking — how
 * fine can I go — and the answer is a number, not an absence.
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
 * speedscope's minimap at the smallest size that answers the question: a strip
 * of the whole extent with the current view drawn on it, draggable to pan. Both
 * charts on this page zoom, so both need one, and they had different answers —
 * the flamegraph had this and the trend had a `recharts` `Brush`.
 *
 * The `Brush` could not work here and the reason is structural rather than a
 * bug in it. A brush selects a sub-range *of the data it is rendered with*, and
 * a zoom on this page re-reads the endpoint, so the rendered data is always
 * exactly the current window — leaving the brush spanning 100% of itself
 * whatever the reader had zoomed to. 「底下的 bar 没任何用，没有随着滚动同步」
 * is a precise description of a control whose only possible state is "all of
 * it". A strip drawn against the *extent* rather than against the rendered rows
 * is the shape that can say where you are.
 *
 * Shown only once there is something to be lost, which is Grafana's restraint
 * and the same rule the reset button follows: no control on screen until there
 * is state to undo.
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
 * p95 beside p50 rather than an average, because the average of a stage that is
 * usually 200ms and occasionally 90 seconds is a number that describes neither
 * and hides the one worth acting on. The bar is p50-ordered by the server's
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
  // Shut by default: the reader opens the group that looks expensive.
  const [openKind, setOpenKind] = useState("");
  // The stages below the distribution's own largest gap are the absence of an
  // answer rather than an answer, and `ui.md` gives absence a sentence rather
  // than equal billing.
  const { slow, fast, ceiling } = splitStages(stages);
  return (
    <div>
      <div className={cn("grid gap-x-3 border-b border-rule pb-1 text-[0.6875rem] text-ink-3", COLS)}>
        {/* Not p50 and p95. Those are the names of the statistics; these are what
            the reader wanted to know, and nobody has to have read a percentile
            to use them. */}
        {/* This was left empty on the argument that a column of `开一个新环境`
            and `连 GitHub` does not need to be told it holds names. True about
            the *values*, wrong about the *row*: three labelled cells beside one
            blank one do not read as "this column is self-evident", they read as
            a header that failed to render — and the blank sat at the left edge
            where a header row starts, so it was the first thing the eye hit.
            A head is not only a definition; it is what makes a header row look
            like one. */}
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
      {/* Grouped by kind and shut by default, inside a box that does not grow.
          A flat column put 24 watchdog rules, six routes and four container
          operations in one list sorted only by time, with unrelated kinds
          interleaved and names truncated mid-word. Twenty-four rules summing to
          1.1s is one line; the reader opens the group that looks expensive.

          Grouping comes from the span-name prefix rather than a list, because
          six new span families landed in one afternoon and a list would have
          dropped each of them into nothing. Radix owns the expand, the keyboard
          and the ARIA (CLAUDE.md 硬约束 4). */}
      <div className="overflow-y-auto overscroll-contain" style={{ maxHeight: PANE_MAX_PX }}>
        <Accordion value={openKind} onValueChange={setOpenKind}>
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
                {/* No bar. There was one under every row, and it was the same mistake the
          flamegraph made in its own way: a mark drawn before anybody decided
          what it encoded. It was scaled to total time while the numbers beside
          it were percentiles, so the longest bar and the largest number were
          different rows and neither explained the other. The fold above is what
          the bar was reaching for — "which of these is the big one" — and it
          answers it by leaving nine rows out rather than by drawing eleven
          widths. Two or three rows of numbers compare fine on their own. */}
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
                        {/* The name column scrolls sideways inside itself.
                            Truncation was cutting identifiers mid-word — `GET
                            /api/v1/san…` names nothing — and widening the column
                            would take the width from the numbers, which are the
                            reason the row exists. A local scroll keeps the three
                            numeric columns fixed and the whole name reachable.

                            `overscroll-x-contain` and not just `overflow-x-auto`:
                            this sits inside a vertically scrolling pane, so
                            without it a horizontal drag that reaches the end of
                            the name chains into scrolling the page. Both axes
                            have to say "stop here" or neither does.

                            `whitespace-nowrap`, not `truncate` — `truncate` is
                            `overflow: hidden`, which would win over the scroll. */}
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
        </Accordion>
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
 * The ceiling every list on this page is held to.
 *
 * Roughly twenty rows. Nothing here grows with the data: one tick of the
 * watchdog is two dozen spans on its own, and a container sized by its row count
 * walks off the bottom of the viewport and takes the rest of the page with it.
 * The content keeps its true height *inside* this box and the box scrolls.
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
 * One flame row, and the type that sits in it.
 *
 * 20px against Grafana's 22. The reference is right that a flamegraph wants
 * compact rows — the whole value of the view is seeing depth at a glance, and
 * every pixel of row height is a level that fell off the bottom — and this page
 * is denser than Grafana everywhere else, so matching its number exactly would
 * make the one chart on the page the loosest thing on it. 20 holds the 0.6875rem
 * meta size from `ui.md`'s scale with room to sit on its baseline.
 */
const CELL_PX = 20;

/**
 * The hues a frame can take, and the ones it may not.
 *
 * `ui.md` gives four hues jobs: 27 is a failed gate, 74 is a warning, 156 is a
 * passed gate, 285 is "needs you". A frame that landed on any of them would be
 * making a claim about the run, and the reader would be right to read it that
 * way. What is left is the cool half of the wheel plus the far violets, and
 * eight of them spaced far enough apart that two frames side by side are
 * different colours rather than two samples of one.
 *
 * This is the one place in the panel with more than one hue, and it is not
 * decoration: a flamegraph's frames have no other way to say "this is the same
 * function you saw two levels up". Grafana varies hue by frame identity for
 * exactly that reason. The grey ramp this replaces encoded nothing at all — a
 * chart where every mark is the same colour is a chart carrying one variable,
 * and this one has two.
 */
const FLAME_HUES = [178, 190, 202, 214, 226, 238, 250, 310, 322, 334, 346];

/** How far a frame is pulled toward the page's own ground. Four depths of tint. */
const FLAME_TINTS = [20, 28, 36, 44];

/**
 * How much of the chart a frame spans, as a percentage.
 *
 * Read off the frame's own laid-out extent rather than divided out of the root's
 * value, because after a zoom the chart is showing a subtree and `x0`/`x1` are
 * relative to what is on screen — which is the number the reader wants. A
 * percentage of the whole tree while looking at one branch would be a different
 * question's answer.
 */
const share = ({ x0, x1 }: FlameFrame): string => `${((x1 - x0) * 100).toFixed(1)}%`;

/**
 * The colour of one frame, on our tokens.
 *
 * `d3-flame-graph`'s default is the hot-orange palette every flamegraph has, and
 * `docs/design/ui.md` is explicit that the category reflex is the thing to
 * refuse: this page is warm paper read in daylight beside an editor, and an
 * orange chart in it would be the one element that belongs to another product.
 *
 * So hue comes from the frame's own name and everything else comes from the
 * page. A fixed mid-lightness colour is mixed toward `--color-paper`, and that
 * one `color-mix` does three jobs at once:
 *
 * It makes the chart theme-aware with no second palette. `--color-paper` is
 * 0.985 in light and 0.185 in dark, so a frame lands at roughly 0.73 on paper
 * and 0.49 in the dark — always moving toward the ground the page is already
 * drawing on. `ui.md` says the dark variant is the same design in dark ink, and
 * this is what that means for a chart. Fixed OKLCH literals were the previous
 * version's bug in the other direction: a frame that stayed mid while the page
 * flipped, with a label on it that went from readable to invisible.
 *
 * It drops chroma at both ends for free. `paper` is a near-neutral (chroma
 * 0.005), so mixing toward it pulls chroma down exactly as lightness approaches
 * either extreme — which is the rule, and it holds here because the mix does it
 * rather than because a formula remembered to.
 *
 * And it keeps the label legible without either side knowing about the other:
 * the frame moves toward `paper`, the label is `ink`, and those two are defined
 * as each other's contrast in both themes.
 *
 * A searched frame takes the accent, and that is the one place the accent
 * appears in this feature: `ui.md` reserves it for "needs you", and a frame the
 * reader has just asked for by name is as close to that as a timing view gets.
 */
const flameColor = ({ data, highlight }: FlameFrame): string => {
  if (highlight) return "var(--color-accent)";
  // djb2, not the sum of the character codes. A sum gives `turn.a` and `turn.b`
  // hashes one apart and therefore neighbouring hues, and the frames a reader
  // most needs to tell apart are siblings whose names differ in one token.
  //
  // 44 combinations for an unbounded set of names, so two frames somewhere in a
  // deep tree can still land on one colour. That is the same bargain every
  // flamegraph palette makes, Grafana's included, and it is survivable because
  // the colour is an aid to following a frame between levels rather than an
  // identifier. What is checked is the case that would be visible: the sibling
  // pairs this fleet actually produces all come out distinct.
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
 * `d3-flame-graph`, wrapped in the lifecycle React needs it to have.
 *
 * The library is imperative and older than hooks: `flamegraph()` builds a chart
 * that attaches itself to a container by selection. Everything that can go wrong
 * with that is a lifecycle mistake, so the shell does three things and they are
 * the reason it exists.
 *
 * It creates the chart once, keyed on nothing, and calls `destroy()` in the
 * effect's cleanup. A cleanup that only clears `innerHTML` leaves the chart's d3
 * transitions and its resize handling alive against a detached node, which is
 * the leak this library is known for.
 *
 * It re-renders on new data through `update()` rather than by rebuilding, so the
 * reader's zoom and search survive a refresh.
 *
 * And it re-creates rather than updates when the *shape* options change, because
 * `selfValue` is read when frames are laid out and toggling it on a live chart
 * leaves the old widths in place.
 */
/**
 * The chart's whole lifecycle, apart from the markup around it.
 *
 * Extracted because this is the part that is easy to get wrong and it had been,
 * twice: once by clearing the container instead of calling `destroy`, and once
 * by measuring the element the zoom had already scaled. Four effects that only
 * ever talk to a library instance, sitting in the same function as a minimap and
 * a breadcrumb, is a component where neither half can be read on its own.
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
   * The newest tree, for the effect that must not depend on it.
   *
   * The chart is built once per width and per `self`, and that effect still has
   * to seed the selection with whatever data exists at the moment it runs. A
   * dependency would put the rebuild back; a ref written during render gives the
   * builder the current value without making it a reason to rebuild.
   */
  const latest = useRef(tree);
  latest.current = tree;
  const [width, setWidth] = useState(0);
  // The frame the reader clicked into, so the way back out can name it. Held
  // here rather than in the block above, because the control that uses it sits
  // on the chart and only this component knows when a click zoomed.
  const [zoomed, setZoomed] = useState<string | null>(null);

  // The library takes a width in pixels and does not observe its container, so
  // the container is observed here. `ResizeObserver` rather than a window
  // listener: this pane is inside a resizable split, and the window never
  // changes size when the reader drags it.
  //
  // Measured once directly as well as observed, because `ResizeObserver` fires
  // asynchronously — waiting only for it leaves the chart unbuilt through the
  // first paint, which is a visible blank on every open.
  // The viewport, not the chart inside it. `host` sits within a wrapper sized
  // `100/zoom` percent, so measuring `host` measures viewport ÷ zoom — which was
  // then divided by zoom a second time, giving viewport ÷ zoom². And because the
  // observer watched the scaled element, setting the width resized what was
  // being measured: a feedback loop that left the frames occupying a fraction of
  // a wrapper several times too wide, with the minimap disagreeing with the
  // screen. Measuring the unscaled parent makes the quantity independent of
  // `zoom`, so the loop cannot close.
  useEffect(() => {
    const el = port.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width || el.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el || width === 0) return;
    const graph = flamegraph()
      .width(width)
      .cellHeight(CELL_PX)
      // Frames under a pixel are not drawn. This is what keeps a deep tree from
      // costing a node per invisible sliver, and it is the library's own answer
      // rather than a cap we impose on depth.
      .minFrameSize(1)
      .selfValue(self)
      .sort(true)
      .transitionDuration(0)
      .setColorMapper(flameColor)
      // `frame.value` and not `frame.data.value`: the first is what the frame
      // was laid out by and follows the 自身 / 含下游 toggle, the second is
      // always self time. Reading the wrong one gives a hover that contradicts
      // the width the reader is hovering over.
      // The words in the frame, the identifier after them. This is an aggregate
      // view, so it speaks the reader's language first — but a flamegraph is also
      // where somebody debugging looks, and the detail line is wide enough to
      // carry both rather than making them choose.
      .setLabelHandler((frame) =>
        [
          humanName(frame.data.name),
          ...(isRenamed(frame.data.name) ? [frame.data.name] : []),
          duration(frame.value),
          share(frame),
        ].join(" · "),
      )
      .setDetailsElement(details.current)
      // The library's own status line, silenced. It wrote `search: 0 of
      // 11271164.521939998 total samples ( 0.000%)` into the same element the
      // hover detail uses: English, fifteen decimal places, and "samples" for
      // something this page calls 耗时. The accent on the matching frames is the
      // feedback; a sentence restating it in another language is not.
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
    // Not `tree`. New data goes through `update()` in the effect below, which is
    // what the comment above this hook has always claimed and what the deps list
    // did not do: every wheel notch on the trend re-reads the endpoint, so a new
    // `flame` array arrived on each one, and a `tree` dependency destroyed and
    // rebuilt the whole chart under the reader — 「一移动每次运行的耗时图表的
    // 位置，下面 flamegraph 就会闪一下」. `self` and `width` stay, because both
    // are read when frames are laid out and neither can be changed on a live
    // chart.
  }, [width, self]);

  // New data into the existing chart. `update` reuses the nodes, so the reader's
  // zoom and search survive a refresh and nothing re-enters — which is also what
  // stops the library's un-configurable 250ms enter transition from firing on
  // every read.
  useEffect(() => {
    chart.current?.update(tree);
  }, [tree]);

  // A separate effect so a selection highlights frames instead of rebuilding the
  // chart under the reader's cursor.
  //
  // `search` takes one string and matches it against frame names, so a selection
  // covering several names is handed a regular expression alternation of them.
  // It used to be handed the reader's *search term*, and after that term grew to
  // match kind labels as well, selecting 巡检规则 sent the library a Chinese
  // label its frames have never carried: `search: 0 of 11271164.5 total samples`.
  // Names in, names out.
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
  // arrives. `d3-flame-graph` self-imports `d3-flamegraph.css`, which the
  // bundler emits as `web/dist/main.css` — and `web/index.html` loads only
  // `app.css`, so those rules never apply. That is the outcome we want (they are
  // `#eee` strokes, `Verdana`, a black tooltip and the hot-orange palette, none
  // of which belong on warm paper) but it means every rule below is load-bearing
  // rather than a tweak on top of a working default.
  //
  // The label is an HTML `div` inside a `foreignObject`, not SVG text, so it is
  // reached by class and not by element. Untouched it inherits the page's `ink`
  // on top of an `ink`-coloured frame, which is the colour on itself.
  return { host, port, details, chart, width, zoomed, setZoomed };
}

function Flame({ tree, self, picked }: { tree: FlameNode; self: boolean; picked: readonly string[] }) {
  const [view, setView] = useState<TimeWindow>({ from: 0, to: 1 });
  const zoom = view.to - view.from;
  const { host, port, details, chart, zoomed, setZoomed } = useFlameChart({ tree, self, picked, zoom });

  return (
    <div className="mt-2">
      {/* One line, fixed height, holding whichever of two things is true: where
          the reader has zoomed to, or what they are pointing at. The library
          owns the second — it writes into this node on hover and clears it on
          mouseout — so nothing else may be rendered inside it, and the height is
          set here rather than earned from content that is absent half the time. */}
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
      <div
        ref={port}
        className="overflow-hidden"
        onWheel={(event) => {
          // 0.002 of the whole width is the floor — five hundred times in, past
          // which a frame is thinner than its own border.
          const next = wheelWindow(event, view, WHOLE, 0.002);
          if (!next) return;
          event.preventDefault();
          setView(next);
        }}
      >
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
              // Tailwind reads these class names out of the source at build time, so
              // a template literal produces a class that exists in the DOM and in no
              // stylesheet. `CELL_PX` moving means this line moves with it.
              "[&_.d3-flame-graph-label]:leading-[20px] [&_.d3-flame-graph-label]:text-ink",
              // A hairline between frames, in the surface colour, so stacked frames
              // read as separate without a border around each.
              "[&_rect]:stroke-paper [&_rect]:[stroke-width:0.5]",
              // The hover affordance. A flamegraph whose frames do not respond to the
              // pointer reads as a picture, and this one is a control: every frame is
              // a click that zooms. `ink` on the outline rather than a fill change,
              // so the frame's own colour still says which function it is.
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
 * Self time is the default. Total time is what the tree already says by nesting,
 * and the question a flamegraph is opened to answer — "which frame is the one
 * burning the wall clock" — is the self-time reading.
 *
 * **Thirty levels of nesting**: a flamegraph never overflows sideways. Each
 * level partitions its parent's width, so the chart is always exactly its
 * container wide however deep the tree is; what grows is height, at
 * `CELL_PX` per level, and the block scrolls inside its pane. Frames too narrow
 * to see are dropped by `minFrameSize`, so depth costs rows rather than nodes.
 * The server bounds the tree at 64 levels regardless, since that walk is the one
 * that would not terminate on a cycle.
 */
function FlameBlock({ folded, picked }: { folded: Report["flame"]; picked: readonly string[] }) {
  const [self, setSelf] = useState(true);
  const tree = useMemo(() => flameTree(folded), [folded]);
  const depth = flameDepth(tree);

  if (folded.length === 0) return null;
  return (
    // `Block`, like every other section here. This one drew its own heading with
    // no rule under it while the three around it had one, which is the drift
    // that comment three hundred lines up was written about and then reproduced.
    // Its toggle goes in the same shelf the bucket picker uses.
    <Block
      // Named for the question it answers, not for the chart it is. The trend
      // beside it answers a different one — this is every run in the scope
      // stacked together, that is one number per bucket over time — and two
      // charts of the same spans need the difference said, not inferred.
      title="耗时分布"
      aside={
        <Segments value={self ? "self" : "total"} onValueChange={(next) => setSelf(next === "self")}>
          {/* Not two skins on one chart: 自身 makes a frame as wide as the time
              it spent itself, 含下游 as wide as everything it called. A parent
              that only waits is full width under one and a sliver under the
              other, and that difference is the reason to have the toggle. */}
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
 * Two lines and not one: a p50 that holds flat while the p95 climbs is the shape
 * of a fleet that is fine most of the time and occasionally is not, and it is
 * the only shape here worth interrupting somebody for. One averaged line hides
 * exactly that.
 *
 * A sample is one trace, so this asks "how long did a unit of work take" rather
 * than "how long was the average span", which would move whenever the shape of
 * the tracing changed and nothing about the system did.
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
  // Inside the chart's own box, at the chart's own height, and not as a line
  // above everything. It sat at the top of the section reading like the whole
  // view's empty state, stacked on a stage table that had data in it — one
  // chart having nothing yet said as "nothing here yet". A slot the size of the
  // thing that is missing says which thing is missing, and `sunk` is already
  // this page's surface for what a machine produced.
  // Dense, so an empty bucket in the middle draws as a break rather than being
  // smoothed over. A quiet ten minutes and ten minutes with no data are not the
  // same fact, and a line joined across the gap says they are.
  const data = fillBuckets(trend, window, bucketMs);
  // Asked of what is *in the window*, not of what the server returned. The test
  // used to be `trend.length < 2` — a count of rows the endpoint found anywhere
  // in its own window — so panning to a quiet stretch left a chart that drew its
  // axes, its gridless empty plot and nothing else, over a fifth of the page.
  // Two points, because one point is not a line.
  const drawable = data.filter((point) => point.p50 !== null).length;
  if (drawable < 2) {
    return (
      // Inside the chart's own box, at the chart's own height, and not as a line
      // above everything. It sat at the top of the section reading like the whole
      // view's empty state, stacked on a stage table that had data in it — one
      // chart having nothing yet said as "nothing here yet". A slot the size of
      // the thing that is missing says which thing is missing, and `sunk` is
      // already this page's surface for what a machine produced.
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
      // Not a control and not a paragraph. Clicking a chart drew the browser's
      // focus ring and selected the SVG as text, because `ResponsiveContainer`
      // renders a focusable wrapper. Scoped here rather than turning focus rings
      // off anywhere else — a real control still needs one.
      tabIndex={-1}
      className="h-[7.5rem] touch-none select-none outline-none [&_*]:outline-none"
      onWheel={(event) => {
        // A minute is the floor the endpoint already enforces, so zooming below
        // it would ask for buckets the server will not produce.
        const next = wheelWindow(event, window, limit, 60_000, TREND_INSET);
        if (!next) return;
        // `preventDefault` only over the chart, so the page still scrolls
        // everywhere else. `touch-none` is the same rule for a trackpad: without
        // it the browser claims the gesture before React sees it.
        event.preventDefault();
        onWindow(next);
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={CHART_MARGIN}>
          {/* A number line, not a list of categories — and the change fixes two
              things at once.

              It is the axis this chart always wanted. A category axis gives every
              bucket the same slot whether or not there is anything in it, so a
              quiet hour and a busy hour are the same width and the shape of the
              line is the shape of the *bucketing* rather than of time. On a real
              axis the wheel's mapping is exact too: `wheelWindow` computes a
              fraction of the plot, and only a linear axis makes that fraction the
              same instant the pointer is over.

              And it is what stops `scalePoint` from being needed at all.
              `recharts` resolves a scale by string — `"scale" + type` looked up
              on the `d3-scale` namespace — so a category axis depended on
              something else in the graph importing `scalePoint` statically, which
              until this file dropped its `Brush` was `recharts`' own Brush module.
              A numeric axis resolves to `scaleLinear`, which the y axis beside it
              already keeps alive. Handing the instance over instead was tried and
              is worse: it bypasses the library's own category setup, and the axis
              came back with no ticks and a curve starting a fifth of the way in. */}
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
            // No `interval` here. That prop is a category-axis control — "which
            // of these N slots get a label" — and on a number line it fights the
            // library's own choice of round tick values. `minTickGap` is the one
            // that still means something: keep them from colliding.
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
          <Area type="monotone" dataKey="p50" name={P50_LABEL} stroke="var(--color-ink-3)" fill="var(--color-sunk)" />
          <Area type="monotone" dataKey="p95" name={P95_LABEL} stroke="var(--color-warn)" fill="transparent" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * The read, and the trace opened on top of it.
 *
 * Two requests rather than one: opening a trace re-asks with `trace=`, and the
 * aggregate is held from the previous answer so the stage list does not blink
 * out and back while the reader moves between traces. A failed second read
 * leaves the first standing — `readTelemetry` has already put the reason in a
 * toast, and blanking a correct stage list because a trace aged out would be the
 * page punishing the reader for clicking.
 */
function useTelemetry(
  scope: TelemetryScope,
  windowMs: number | undefined,
  chosen: TimeWindow | null,
  bucketMs: number,
) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * How far the data goes, which is a different fact from what is on screen.
   *
   * `report.window` is the window that was *asked for* — `telemetry.ts:186`
   * echoes the query's own `from`/`to` straight back — so using it as the zoom
   * limit made the limit equal the current view the moment anybody zoomed. From
   * there `zoomAt` clamped every widening to the span it already had and
   * `panBy` clamped every slide to zero: scrolling back out did nothing, and a
   * horizontal swipe did nothing, which is exactly how it was reported. The two
   * symptoms were one bug wearing two coats.
   *
   * Taken from the answer to the read nobody narrowed, so it is the endpoint's
   * own account of the full stretch rather than a clock arithmetic guess that
   * would drift a millisecond per render.
   */
  const [extent, setExtent] = useState<TimeWindow | null>(null);
  // The scope is taken apart into the two primitives it is made of, and put back
  // together inside the effect. Every caller passes an object literal, so a
  // dependency on the object itself is a new identity on each of their renders
  // and this would re-read on all of them — and the alternative, suppressing the
  // dependency check, is the same bug with the warning turned off.
  const kind = scope.kind;
  const id = scope.kind === "system" ? 0 : scope.id;
  // The window taken apart the same way and for the same reason: `chosen` is a
  // fresh object on every wheel notch, and depending on the object would re-read
  // on each one even when the two numbers had not moved.
  const from = chosen?.from ?? null;
  const to = chosen?.to ?? null;

  useEffect(() => {
    let live = true;
    setLoading(true);
    const target: TelemetryScope = kind === "system" ? { kind: "system" } : { kind, id };
    void readTelemetry(target, windowMs, from !== null && to !== null ? { from, to } : null, bucketMs).then(
      (answer) => {
        // The reader moved on — a different scope, or a different trace — before
        // this landed. Writing it now would show them the previous question's
        // answer under the current question's heading.
        if (!live) return;
        setLoading(false);
        if (!answer) return;
        setReport(answer);
        // Only the unnarrowed read knows the whole stretch. A narrowed one
        // answers about the slice it was asked for.
        if (from === null) setExtent(answer.window);
      },
    );
    return () => {
      live = false;
    };
  }, [kind, id, windowMs, from, to, bucketMs]);

  return { report, loading, extent };
}

/**
 * 耗时, for one scope.
 *
 * Two views of the same spans, and they answer different questions rather than
 * being two skins on one. The **flamegraph** is the aggregate: every run in the
 * scope folded together, so it says where the time goes. The **waterfall** is
 * one trace: what happened, in what order, and what was waiting on what. A
 * project asks the first question and a single requirement usually asks the
 * second, but both are on every surface, because "this project is slow" and
 * "this run was slow" are asked from the same page ten seconds apart.
 *
 * The heading is the caller's: the same block is a tab panel in two places and a
 * section of a longer page in the third, and a heading inside a tab repeats the
 * tab's own label.
 */
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
  /**
   * What the reader has selected, as the set of span names it covers.
   *
   * A set of names rather than a search string, and that is the fix for the
   * flamegraph never lighting up. The selection used to be the text somebody
   * typed, and `spanMatches` was widened so that clicking 巡检规则 would mark
   * every `watchdog.*` row — but the flamegraph's frames carry raw span names,
   * so it was handed a kind label that matched none of them and reported
   * `search: 0 of 11271164.5 total samples`. Resolving the selection to names
   * *here*, once, means both surfaces are asked the same question in the same
   * vocabulary.
   *
   * It highlights, it does not filter: the rows around a selection are what
   * made it worth selecting.
   */
  const [picked, setPicked] = useState<readonly string[]>([]);
  /** Names the reader has said they do not want to see. Right-click, 不看这一段. */
  const [excluded, setExcluded] = useState<readonly string[]>([]);
  /** The window a drag on the trend asked for, in place of the caller's default. */
  /**
   * The stretch of time the page is showing, when the reader has chosen one.
   *
   * `null` means "the caller's default window", which is what a fresh page
   * shows. It was a duration in milliseconds and could only ever shorten from
   * `now`; both the brush and the wheel write a real range into it now, and
   * every block reads it through the one query.
   */
  const [chosen, setChosen] = useState<TimeWindow | null>(null);
  /**
   * A bucket width the reader pinned, or `null` to follow the window.
   *
   * Following is the default because the fixed hour was the bug: zoom past an
   * hour and there was one bucket, and a line needs two points. Pinning exists
   * because the derived value is a guess about what somebody wants to see, and
   * a guess should be overridable rather than argued with.
   */
  const [pinnedBucket, setPinnedBucket] = useState<number | null>(null);
  /**
   * The stretch on screen: what the reader chose, else what the server sent.
   *
   * The clock arithmetic is the last resort and not the first, which is the
   * order that matters. Preferring it would put the charts on "the last N
   * milliseconds ending at this browser's now" while the limit came from the
   * endpoint — two windows that agree only if the two clocks do, and disagree
   * completely on stored data whose newest row is older than N.
   */
  // The bucket is derived from what is being *asked for*, not from what came
  // back — otherwise the read needs the answer to the read. When nothing is
  // chosen that is the caller's own window, which is the same number the
  // endpoint derives its window from.
  const bucketMs = pinnedBucket ?? bucketFor(chosen ? chosen.to - chosen.from : (windowMs ?? DAY_MS));
  const { report, loading, extent } = useTelemetry(scope, windowMs, chosen, bucketMs);
  /**
   * The stretch on screen: what the reader chose, else what the server sent.
   *
   * The clock arithmetic is the last resort and not the first, and that order
   * is the point. Preferring it would put the charts on "the last N
   * milliseconds ending at this browser's now" while the limit came from the
   * endpoint — two windows that agree only when the two clocks do, and that
   * disagree completely on stored data whose newest row is older than N.
   */
  const shownWindow = chosen ?? report?.window ?? { from: Date.now() - (windowMs ?? DAY_MS), to: Date.now() };
  /**
   * How far a zoom or a pan may reach.
   *
   * The endpoint's answer to the unnarrowed read, and never `report.window` —
   * that is the window the last request *asked for*, so using it here made the
   * limit follow the view and every clamp in `zoomAt`/`panBy` became a no-op.
   */
  const limit = extent ?? report?.window ?? shownWindow;

  if (!report) {
    return <div className="py-4 text-[0.75rem] text-ink-3">{loading ? "读取中…" : empty}</div>;
  }
  if (!hasSpans(report.stages, report.traces)) {
    return <div className="py-4 text-[0.75rem] text-ink-3">{empty}</div>;
  }

  const shown = report.stages.filter((stage) => !excluded.includes(stage.name));
  const exclude = (name: string) => setExcluded((names) => (names.includes(name) ? names : [...names, name]));
  /** Selecting what is already selected clears it; that is the only way back. */
  const pick = (names: readonly string[]) =>
    setPicked((current) => (current.length === names.length && names.every((n) => current.includes(n)) ? [] : names));

  return (
    // Two charts and two tables. Everything that stood between them — the
    // heading, the answer sentence, the run picker, the search box and the
    // single-run waterfall — is deleted, and the deletion is the point: each of
    // them restated something the four blocks below already show. The sentence
    // was the clearest case, being a correct summary of a table sitting two
    // inches under it.
    //
    // Time on the left, tables on the right, and the brush on the trend scopes
    // all four: `dragged` feeds the one query every block reads, so narrowing
    // the window changes what the tables count rather than only what the chart
    // draws.
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-y-6">
        {/* No `trend.length >= 2` here any more. `Trend` already draws its own
            empty slot at its own height, and gating the whole block on the
            point count took the picker and the way back out with it — so a zoom
            that narrowed to one bucket deleted the two controls that could
            undo it. A chart with nothing in it is a state; a chart with its
            controls removed is a trap. */}
        {showTrend && (
          <Block
            title="每次运行的耗时"
            aside={
              <BucketPicker
                value={bucketMs}
                pinned={pinnedBucket !== null}
                windowMs={shownWindow.to - shownWindow.from}
                onPick={setPinnedBucket}
              />
            }
          >
            <Trend
              trend={report.trend}
              windowMs={report.windowMs}
              bucketMs={bucketMs}
              window={shownWindow}
              limit={limit}
              onWindow={setChosen}
            />
            {/* The same strip the flamegraph has, against the whole stretch the
                data covers. It is what the `Brush` could not be: a brush ranges
                over the rows it is rendered with, and a zoom here re-reads the
                endpoint, so those rows *are* the window and the brush could only
                ever span all of itself. */}
            <Minimap view={shownWindow} limit={limit} label="看的是哪一段" onPan={setChosen} />
            {chosen !== null && (
              <button
                type="button"
                onClick={() => setChosen(null)}
                className="cursor-pointer self-start text-[0.75rem] text-ink-3 transition-colors hover:text-ink"
              >
                ← 回到整段时间
              </button>
            )}
          </Block>
        )}

        <FlameBlock folded={report.flame} picked={picked} />
      </div>

      <div className="flex min-w-0 flex-col gap-y-6">
        {/* Titled like its neighbours. It was the one block on the page with no
            heading, on the argument that its columns introduce themselves —
            true of the columns and false of the page, where three titled blocks
            and one bare table read as a layout that lost a heading. */}
        <Block title="各环节耗时">
          <Stages stages={shown} picked={picked} onPick={pick} onExclude={exclude} />
          {excluded.length > 0 && (
            <Excluded
              names={excluded}
              onClear={() => setExcluded([])}
              onRestore={(n) => setExcluded((a) => a.filter((x) => x !== n))}
            />
          )}
        </Block>
        <Slices slices={report.slices} />
      </div>
    </div>
  );
}

/**
 * A requirement's time, split by the slice that spent it.
 *
 * The axis a boss reading a requirement already has in their head — slice 1
 * sailed through, slice 3 has burned an hour — and the one thing the stage table
 * cannot say, because stages answer *what* the time went on rather than *which
 * piece of the work*.
 *
 * Bars here and nowhere else on this page, for the one reason a bar is ever
 * worth drawing: these are shares of a whole. The slices partition the
 * requirement's spans, so a width really is a proportion of one total, which is
 * exactly what the stage table's bar could not claim and why that one was cut.
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
            {/* NULL is a row, not a filter: planning turns, the draft card and
                the roster belong to no slice, and leaving them out would make
                these add up to less than the requirement with nothing on screen
                explaining the gap. */}
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
 * It was a shut accordion at the bottom of the landing page, under the queue and
 * the requirement tracks — a section about the panel's own wall clock, on the
 * page that answers 谁在等我. Nothing about it belonged there: it is not waiting
 * on the boss, it is not a requirement, and it is the thing you go looking for
 * once, on the day the panel feels slow. `ui.md` puts exactly that in 设置 — the
 * one surface nobody is ever *in*, that you come to, fix something, and leave.
 *
 * The window is the endpoint's own default day. A week is the project view's
 * question ("is this project getting slower"); the host's is "is it slow now".
 */
export function SystemTiming() {
  return (
    <>
      <Head title="系统耗时" note="这台机器上所有活动的耗时，最近一天" />
      <Telemetry scope={HOST} trend empty="还没有记下任何系统活动。" />
    </>
  );
}
