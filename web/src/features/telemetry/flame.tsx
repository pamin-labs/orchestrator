/**
 * The flamegraph, and the imperative library under it.
 *
 * Split out of `view.tsx`. `d3-flame-graph` is older than hooks and needs its own
 * create/update/destroy lifecycle, a palette, and every CSS rule it draws with —
 * none of which the trend chart or the stage table share. What they did share is
 * `useWheel`, which moved to `shared/` rather than being imported back out of a
 * sibling feature file.

 */
import { useEffect, useRef, useState } from "react";
import flamegraph, { type FlameFrame, type FlameGraph } from "d3-flame-graph";
import { select } from "d3-selection";
import { cn } from "../../ui/cn";
import { Minimap } from "./minimap";
import { useWheel } from "../../shared/use-wheel";
import { duration } from "../../shared/format";
import { type FlameNode, humanName, isRenamed, type TimeWindow, WHOLE, wheelWindow } from "./model";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * One flame row, and the type that sits in it. 20 holds the 0.6875rem meta size
 * from `ui.md`'s scale with room to sit on its baseline.
 */
export const CELL_PX = 20;

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

export function Flame({ tree, self, picked }: { tree: FlameNode; self: boolean; picked: readonly string[] }) {
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
              "shrink-0 cursor-pointer rounded-md bg-sunk px-1.5 py-0.5 font-mono text-pill text-ink-2",
              "transition-colors hover:text-ink",
            )}
          >
            <Trans>← Back to all</Trans>
          </button>
        )}
        {zoomed !== null && <span className="shrink-0 text-meta text-ink-3">看的是 {humanName(zoomed)}</span>}
        {zoomed === null && zoom < 1 && (
          <span className="shrink-0 text-meta text-ink-3">放大到 {(1 / zoom).toFixed(0)}×</span>
        )}
        <div ref={details} className="min-w-0 truncate font-mono text-meta text-ink-2" />
      </div>
      <div className="mb-1">
        <Minimap view={view} limit={WHOLE} label={t`Which window`} onPan={setView} />
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
              "[&_.d3-flame-graph-label]:font-mono [&_.d3-flame-graph-label]:text-meta",
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
