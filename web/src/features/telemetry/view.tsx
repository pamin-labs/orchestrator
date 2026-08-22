import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as ContextMenu from "@radix-ui/react-context-menu";
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
import { CELL_PX, Flame } from "./flame";
import { Minimap } from "./minimap";
import { useWheel } from "../../shared/use-wheel";
import { Segment, Segments } from "../../ui/segment";
import { ChevronRight } from "lucide-react";
import { Tip } from "../../ui/tooltip";
import { AccordionBody, AccordionItem, AccordionTrigger, MultiAccordion } from "../../ui/accordion";
import { Menu, MenuItem } from "../../ui/menu";
import {
  BUCKETS,
  P50_LABEL,
  P95_LABEL,
  type TimeWindow,
  bucketFits,
  fillBuckets,
  flameDepth,
  flameTree,
  groupByKind,
  hasSpans,
  humanName,
  isRenamed,
  splitStages,
  trendLabel,
  trendScale,
  wheelWindow,
} from "./model";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";

/**
 * `Time` — where a scope's wall clock went.
 *
 * Three surfaces read this: one component with a different scope, because a
 * requirement, a project and the host ask the same question about different work.
 * Two libraries — `recharts`, already bundled for `Cost`, and `d3-flame-graph` —
 * both rendering SVG, because a canvas chart is one node with an image in it.
 */

/** One menu surface, because the stage rows and the waterfall both raise one. */
const MENU =
  "z-50 min-w-44 rounded-lg border border-rule bg-paper p-1 text-body text-ink shadow-[0_10px_30px_var(--shade)]";

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

/**
 * The four columns, in one place because three rows have to agree on them.
 *
 * `auto` on the three numeric tracks rather than fixed rem widths, which gives
 * each number exactly what it needs and hands the rest to `minmax(0,1fr)`. `Count`
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
          <h3 className="min-w-0 truncate text-body font-medium text-ink">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
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

/** Said around a bucket width, which is itself a message. */
const perBucket = (width: string): MessageDescriptor => msg`${{ width }} per bucket`;

const tooManyBuckets = (count: string): MessageDescriptor =>
  msg`This window needs ${{ count }} buckets, more than fits`;

const sliceLabel = (id: number): MessageDescriptor => msg`slice ${{ id }}`;

/** How wide a bucket reads, in the units the picker offers. */
const bucketLabel = (ms: number): MessageDescriptor =>
  ms < 3_600_000 ? msg`${{ minutes: ms / 60_000 }} min` : msg`${{ hours: ms / 3_600_000 }} hr`;

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
  const { t } = useLingui();
  return (
    <Menu label={`${t(perBucket(t(bucketLabel(value))))}${pinned ? "" : t`(following)`}`}>
      <MenuItem hint={t`Follow window—updates as window changes, fits without crowding`} onSelect={() => onPick(null)}>
        <Trans>Follow window</Trans>
      </MenuItem>
      {BUCKETS.map((ms) => {
        const fits = bucketFits(windowMs, ms);
        return (
          <MenuItem
            key={ms}
            disabled={!fits}
            hint={fits ? undefined : t(tooManyBuckets(Math.round(windowMs / ms).toLocaleString()))}
            onSelect={() => onPick(ms)}
          >
            {t(bucketLabel(ms))}
          </MenuItem>
        );
      })}
    </Menu>
  );
}

/** A number column that stays comparable down the page. */
const NUM = "text-right font-mono text-meta tabular-nums";

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
  const { t } = useLingui();
  // Shut by default: the reader opens the group that looks expensive — and then
  // the next one, which is why this is a set rather than a single value. The
  // question `Watchdog rule` raises is "against what", and answering it by closing
  // `Watchdog rule` is the one thing the control must not do.
  const [openKinds, setOpenKinds] = useState<string[]>([]);
  // The stages below the distribution's own largest gap are the absence of an
  // answer rather than an answer, and `ui.md` gives absence a sentence rather
  // than equal billing.
  const { slow, fast, ceiling } = splitStages(stages);
  // Named, because a placeholder takes the name of the expression that fills it.
  // Under a millisecond the quoted ceiling rounds to "0ms", which reads as a
  // broken number rather than as a fast stage, so it says so in words instead.
  const restCount = fast.length;
  // `ph` because the name the message wants is already taken by the number it
  // formats — a binding called `ceiling` cannot also be `duration(ceiling)`.
  const restCeiling = ceiling < 1 ? t`all under 1ms` : t`all under ${ph({ ceiling: duration(ceiling) })}`;
  return (
    <div>
      <div className={cn("grid gap-x-3 border-b border-rule pb-1 text-meta text-ink-3", COLS)}>
        {/* A head is not only a definition; it is what makes a header row look
            like one — three labelled cells beside one blank read as a header that
            failed to render, not as a self-evident column. */}
        <div>
          <Trans>What</Trans>
        </div>
        {/* Nouns, and the shortest ones that still separate the two durations:
            what it usually costs against what it costs on a bad day. The exact
            statistic stays one hover away for anybody who wants it. */}
        <Tip label={t(P50_LABEL)}>
          <div className="text-right underline decoration-dotted underline-offset-2">
            <Trans>P50</Trans>
          </div>
        </Tip>
        <Tip label={t(P95_LABEL)}>
          <div className="text-right underline decoration-dotted underline-offset-2">
            <Trans>P95</Trans>
          </div>
        </Tip>
        <div className="text-right">
          <Trans>Count</Trans>
        </div>
      </div>
      {/* Grouped by kind and shut by default, inside a box that does not grow:
          twenty-four rules summing to 1.1s is one line. Grouping comes from the
          span-name prefix rather than a list, because a list drops every new span
          family into nothing. Radix owns the expand, the keyboard and the ARIA
          (CLAUDE.md hard constraint 4). */}
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
                  <span className="truncate text-body text-ink">{group.label}</span>
                  {group.errors > 0 && (
                    <span className="shrink-0 font-mono text-pill text-bad">
                      <Trans>{{ failed: group.errors }} failed</Trans>
                    </span>
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
                              <span className="whitespace-nowrap text-body text-ink underline decoration-dotted underline-offset-2">
                                {humanName(stage.name)}
                              </span>
                            </Tip>
                          ) : (
                            <span className="whitespace-nowrap font-mono text-secondary text-ink">{stage.name}</span>
                          )}
                          {stage.errors > 0 && (
                            /* The count says a stage is broken; the reason is the
                               only half a reader can act on. Under a `Tip`
                               because it is the newest failure's own words and
                               can be long — the row stays a row. */
                            <Tip label={stage.reason ?? t`No reason recorded`}>
                              <span className="shrink-0 font-mono text-pill text-bad">
                                <Trans>{{ failed: stage.errors }} failed</Trans>
                              </span>
                            </Tip>
                          )}
                        </div>
                        <div className={cn(NUM, "text-ink")}>{duration(stage.p50)}</div>
                        <div className={cn(NUM, "text-ink")}>{duration(stage.p95)}</div>
                        <div className={cn(NUM, "text-ink-3")}>{stage.count}</div>
                      </button>
                    </ContextMenu.Trigger>
                    <ContextMenu.Portal>
                      <ContextMenu.Content className={MENU}>
                        <MenuAction onSelect={() => onPick([stage.name])}>
                          <Trans>Only this stage</Trans>
                        </MenuAction>
                        <MenuAction onSelect={() => onExclude(stage.name)}>
                          <Trans>Hide this stage</Trans>
                        </MenuAction>
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
          className="cursor-pointer pt-1.5 text-left text-secondary text-ink-3 transition-colors hover:text-ink"
        >
          {showRest ? t`Hide the other ${restCount}` : t`Show the other ${restCount} (${restCeiling})`}
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
 * The flamegraph block: what the scope's time is actually spent in.
 *
 * Self time is the default: total time is what the tree already says by nesting.
 * A flamegraph never overflows sideways — each level partitions its parent's
 * width — so depth costs height, and the block scrolls inside its pane. The server
 * bounds the tree at 64 levels, since that walk would not terminate on a cycle.
 */
function FlameBlock({ folded, picked }: { folded: Report["flame"]; picked: readonly string[] }) {
  const { t } = useLingui();
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
      title={t`Flame distribution`}
      aside={
        <Segments value={self ? "self" : "total"} onValueChange={(next) => setSelf(next === "self")}>
          {/* Not two skins on one chart: `Self` makes a frame as wide as the time it
              spent itself, `Including downstream` as wide as everything it called. A parent that
              only waits is full width under one and a sliver under the other. */}
          <Segment value="self">
            <Trans>Self</Trans>
          </Segment>
          <Segment value="total">
            <Trans>Including downstream</Trans>
          </Segment>
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
  const { t } = useLingui();
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
      <div className="grid h-[7.5rem] place-items-center rounded-md bg-sunk text-center text-secondary text-ink-3">
        {/* Which of the two absences it is. "Nothing was recorded here" and
            "nothing has been recorded yet" send the reader to different places,
            and the window is what tells them apart. */}
        {trend.length === 0 ? t`No activity in this window.` : t`Not enough data for two periods.`}
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
            tickFormatter={(at: number) => trendLabel(at, windowMs)}
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
          <ChartTooltip format={duration} label={(at) => trendLabel(Number(at), windowMs)} />
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
            name={t(P50_LABEL)}
            stroke="var(--color-ink-3)"
            fill="var(--color-sunk)"
            dot={{ r: 1.5 }}
            connectNulls
          />
          <Area
            type="monotone"
            dataKey="p95"
            name={t(P95_LABEL)}
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

/** Matches the server's own cache window; a shorter one would ask and be handed the same answer. */
const TELEMETRY_STALE_MS = 15_000;
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
    // The one query that overrides the global `staleTime: 0`, and the reason is in
    // the report rather than in taste: the spans it reads are written by a
    // heartbeat, so an answer cannot be fresher than that tick — while re-asking
    // costs five synchronous window-function queries the server runs on its only
    // thread. Alt-tabbing back was re-paying that for a number that had not moved.
    staleTime: TELEMETRY_STALE_MS,
    refetchOnWindowFocus: false,
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
  /** Whether the reader narrowed it, which is the only thing the reset-to-full-range control needs. */
  chosen: TimeWindow | null;
  onWindow: (next: TimeWindow | null) => void;
}) {
  const { t } = useLingui();
  return (
    <Block
      title={t`Per-run duration`}
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
      <Minimap view={window} limit={limit} label={t`Which window`} onPan={onWindow} />
      {chosen !== null && (
        <button
          type="button"
          onClick={() => onWindow(null)}
          className="cursor-pointer self-start text-secondary text-ink-3 transition-colors hover:text-ink"
        >
          <Trans>← Back to full timeline</Trans>
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
  /** Names the reader has said they do not want to see. Right-click, `Hide this stage`. */
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
  empty,
}: {
  scope: TelemetryScope;
  windowMs?: number;
  /** The project view wants the shape over time; a single requirement has too few points for one. */
  trend?: boolean;
  empty?: string;
}) {
  const { t } = useLingui();
  // Not a parameter default: that runs before the hook, so it would have needed
  // the global `t` and this pane would keep its old wording after a locale change.
  const nothingYet = empty ?? t`No activity yet.`;
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
    return <div className="py-4 text-secondary text-ink-3">{loading ? t`Loading…` : nothingYet}</div>;
  }
  if (!hasSpans(report.stages, report.traces)) {
    return <div className="py-4 text-secondary text-ink-3">{nothingYet}</div>;
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
        <Block title={t`Stage durations`}>
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
  const { t } = useLingui();
  if (slices.length < 2) return null;
  const total = slices.reduce((sum, row) => sum + row.totalMs, 0) || 1;
  return (
    <section className="flex flex-col gap-y-2">
      <h3 className="border-b border-rule pb-1 text-body font-medium text-ink">
        <Trans>Slice durations</Trans>
      </h3>
      <div className="flex flex-col gap-y-1.5">
        {slices.map((row) => (
          <div key={row.sliceId ?? "none"} className="grid grid-cols-[6rem_minmax(0,1fr)_4rem] items-center gap-x-3">
            {/* NULL is a row, not a filter: planning turns, the draft card and the
                roster belong to no slice, and leaving them out would make these add
                up to less than the requirement with nothing explaining the gap. */}
            <span className="truncate text-secondary text-ink-2">
              {row.sliceId === null ? t`No slice` : t(sliceLabel(row.sliceId))}
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
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-secondary text-ink-3">
      <span>
        <Trans>Hiding:</Trans>
      </span>
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
        <Trans>Restore all</Trans>
      </button>
    </div>
  );
}

/** The host's own scope, hoisted so the effect below is not re-run by a new object each render. */
const HOST: TelemetryScope = { kind: "system" };

/**
 * `System timing`, as a page of its own.
 *
 * In `Settings` because it is the thing you go looking for once, on the day the panel
 * feels slow — `ui.md` puts exactly that there. The window is the endpoint's own
 * default day: a week is the project view's question ("is this project getting
 * slower"), the host's is "is it slow now".
 */
export function SystemTiming() {
  const { t } = useLingui();
  return (
    <>
      <Head title={t`System timing`} note={t`Timing for all activity on this machine, last 24h`} />
      <Telemetry scope={HOST} trend empty={t`No system activity recorded.`} />
    </>
  );
}
