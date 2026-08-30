import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "../support/render.tsx";
import { inFlight, mockHttp, server } from "../support/http.ts";
import { HttpResponse, http } from "msw";
import { SystemTiming, Telemetry } from "../../web/src/features/telemetry/view.tsx";
import type { Telemetry as Report } from "../../web/src/shared/api.ts";
import { wheelWindow } from "../../web/src/features/telemetry/model.ts";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { WithQueries } from "./queries.tsx";

/**
 * A viewport, because happy-dom measures every element as 0x0.
 *
 * `ResponsiveContainer` draws nothing at all at zero width, so without this the
 * tests below pass against an empty `<svg>` and prove nothing. Restored
 * afterwards so a later file does not inherit a fake layout.
 */
const T0 = 1_700_000_000_000;

const realRect = HTMLElement.prototype.getBoundingClientRect.bind(HTMLElement.prototype);
const SIZE = { width: 900, height: 500 };

/**
 * `SVGTransformList.consolidate`, which happy-dom does not implement.
 *
 * A gap in the DOM simulation, not in the chart: a browser has this method, and
 * `d3-interpolate` calls it while animating a zoom's `transform`. Without it a
 * zoom threw from inside a `d3-timer` callback, after the test had passed.
 * `null` is the documented answer for an empty list.
 */
const svgTransforms: unknown = Object.getPrototypeOf(
  document.createElementNS("http://www.w3.org/2000/svg", "g").transform.baseVal,
);
if (svgTransforms !== null && typeof svgTransforms === "object" && !("consolidate" in svgTransforms)) {
  Object.defineProperty(svgTransforms, "consolidate", { value: () => null, configurable: true });
}

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function rect(this: void): DOMRect {
    return { ...SIZE, top: 0, left: 0, right: SIZE.width, bottom: SIZE.height, x: 0, y: 0, toJSON: () => ({}) };
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: SIZE.width });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: SIZE.height });
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

/** A pane that never gets its report is the state it comes up in; a test that
 *  wants a landed one calls `serve`. */
mockHttp(inFlight());

const EMPTY: Report = {
  scope: "group",
  windowMs: 3_600_000,
  window: { from: T0 - 3_600_000, to: T0 },
  // The extent the store actually holds, which is what a zoom clamps against.
  dataWindow: { from: T0 - 3_600_000, to: T0 },
  stages: [],
  traces: [],
  trend: [],
  flame: [],
  slices: [],
  trace: null,
};

/**
 * A report, with the data extent following the window unless a test says otherwise.
 *
 * `dataWindow` is what a zoom clamps against, so leaving it at the default while
 * overriding `window` builds a fixture whose chart cannot be zoomed out — which
 * is a real state, and never the one a test asking about zooming means.
 */
const report = (over: Partial<Report>): Report => ({
  ...EMPTY,
  ...(over.window && !over.dataWindow ? { dataWindow: over.window } : {}),
  ...over,
});

const stage = (name: string, over: Partial<Report["stages"][number]> = {}) => ({
  name,
  count: 1,
  totalMs: 1_000,
  p50: 1_000,
  p95: 1_000,
  errors: 0,
  reason: null,
  ...over,
});

const trace = (traceId: string, over: Partial<Report["traces"][number]> = {}) => ({
  traceId,
  name: "turn",
  startedAt: T0,
  durationMs: 9_000,
  failed: false,
  ...over,
});

const serve = (answer: Report) => server.use(http.get("/api/v1/telemetry", () => HttpResponse.json(answer)));

/**
 * Rendered the way the app renders it: `app.tsx` wraps the whole panel in
 * `TipRoot`, and Radix's tooltip throws outside its provider.
 */
const show = (ui: React.ReactElement) =>
  render(
    <WithQueries>
      <TipRoot>{ui}</TipRoot>
    </WithQueries>,
  );

/**
 * One scope with something in every block the page still has.
 *
 * Names are distinct per block on purpose: in production a stage, a trace and a
 * flame frame all legitimately read `turn.provider`, and a `getAllByText` count
 * would then be the sum of three views agreeing rather than one view working.
 */
const ONE_TRACE = report({
  stages: [stage("stage.provider", { count: 12, totalMs: 96_000, p50: 7_200, p95: 21_000 })],
  traces: [trace("a".repeat(32), { name: "trace.one" })],
  flame: [
    { path: "flame.turn", totalMs: 9_000, count: 1 },
    { path: "flame.turn;flame.prepare", totalMs: 200, count: 1 },
    { path: "flame.turn;flame.provider", totalMs: 8_000, count: 1 },
  ],
});

/** The flamegraph's own frames. `d3-flame-graph` puts its class on the svg itself. */
const frames = (view: { container: HTMLElement }) => view.container.querySelectorAll("svg.d3-flame-graph rect");

/**
 * The flamegraph's labels.
 *
 * A `div` inside a `foreignObject`, not SVG text — which is why they are found
 * by the library's own class. Looking for `text` finds the `<title>` elements
 * instead, and those are empty whenever a tooltip is installed, so a label
 * assertion written that way passes against a chart with no labels on it.
 */
/** The `<g class="frame">` wrappers, which are what a click and a hover land on. */
const frameGroups = (view: { container: HTMLElement }) => view.container.querySelectorAll("svg.d3-flame-graph g.frame");

/**
 * The one-line readout under the flamegraph. `d3-flame-graph` writes into it on
 * hover, and on search too until `setSearchHandler` was overridden to write
 * nothing; this asserts only the hover half.
 */
const readout = (view: { container: HTMLElement }) =>
  // A sibling of the chart host, not a child of it: the row above the svg holds
  // the zoom breadcrumb and this. Selected on its own class set rather than by
  // position, because `.d3-flame-graph-label` is also `truncate`.
  view.container.querySelector("div.min-w-0.truncate.font-mono")?.textContent ?? "";

const flameLabels = (view: { container: HTMLElement }) =>
  [...view.container.querySelectorAll(".d3-flame-graph-label")].map((node) => node.textContent).filter(Boolean);

/** Where a waterfall label was drawn. The tick is a `<text>`, so its `x` is readable. */
/**
 * Open one kind-group in the stage tree.
 *
 * The rows are shut by default and grouped by span-name prefix, so a stage is
 * not in the DOM until its group is. Any number may be open at once: these rows
 * are comparable, and the reason to open a second is to see it beside the first.
 */
const openGroup = (view: { getByRole: (r: string, o: { name: RegExp }) => HTMLElement }, label: string) =>
  fireEvent.click(view.getByRole("button", { name: new RegExp(label) }));

// ── empty ──────────────────────────────────────────────────────────────────

test("a scope with nothing recorded says so and draws neither chart", async () => {
  serve(EMPTY);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} empty="这个需求还没跑出带追踪的活。" />);

  await waitFor(() => expect(view.getAllByText("这个需求还没跑出带追踪的活。")).toHaveLength(1));
  expect(frames(view)).toHaveLength(0);
  expect(view.queryAllByRole("button")).toHaveLength(0);
});

test("two kinds can be open at once, because the question is which is worse", async () => {
  serve(
    report({
      stages: [stage("watchdog.a", { p95: 900 }), stage("index.b", { p95: 800 })],
      traces: [trace("a".repeat(32), { name: "t" })],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(view.getAllByText("巡检规则")).toHaveLength(1));

  // These rows are comparable, so any number may be open at once: closing the
  // first to open the second is the one thing this control must not do.
  openGroup(view, "巡检规则");
  await waitFor(() => expect(view.getAllByText("watchdog.a")).toHaveLength(1));
  openGroup(view, "代码索引");
  await waitFor(() => expect(view.getAllByText("index.b")).toHaveLength(1));
  expect(view.getAllByText("watchdog.a")).toHaveLength(1);
});

test("a width change re-lays out the flamegraph instead of rebuilding it", async () => {
  // A controllable `ResizeObserver`: happy-dom's does not fire, and a dispatched
  // `window.resize` never reaches one — which is how the first version of this
  // test passed against the bug it was written for.
  const observers: { fire: () => void }[] = [];
  const seen = globalThis.ResizeObserver;
  class Controllable implements ResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      observers.push({ fire: () => this.callback([], this) });
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = Controllable;

  try {
    serve(ONE_TRACE);
    const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
    await waitFor(() => expect(frames(view).length).toBeGreaterThan(0));

    // The node identity is the assertion: with `width` a dependency of the
    // effect that creates the chart, opening `Settings` rebuilt it — 「打开设置页面，
    // 前者会闪一下」. A re-layout keeps the same svg; a rebuild does not.
    const before = view.container.querySelector("svg.d3-flame-graph");
    expect(before).not.toBeNull();
    SIZE.width = 700;
    // Each observer fires itself, so the callback's second argument is the real
    // instance. Constructing a fresh one here would register it mid-iteration
    // and the loop would never end.
    for (const observer of observers) observer.fire();
    await waitFor(() => expect(frames(view).length).toBeGreaterThan(0));
    expect(view.container.querySelector("svg.d3-flame-graph") === before).toBe(true);
  } finally {
    SIZE.width = 900;
    globalThis.ResizeObserver = seen;
  }
});

test("the stage list carries both percentiles, formatted", async () => {
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  await waitFor(() => expect(view.getAllByText("stage")).toHaveLength(1));
  openGroup(view, "stage");
  await waitFor(() => expect(view.getAllByText("stage.provider")).toHaveLength(1));
  expect(view.getAllByText("7.2s")).toHaveLength(1);
  expect(view.getAllByText("21.0s")).toHaveLength(1);
});

test("a failed stage is counted and marked, not dropped", async () => {
  serve(
    report({
      stages: [stage("stage.provider", { count: 3, errors: 2, reason: null, totalMs: 4_800, p95: 4_800 })],
      traces: [trace("a".repeat(32), { name: "trace.one" })],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  // A failed call still consumed its wall clock, so it stays in the totals and
  // the count sits beside the name in the failure colour a failed gate uses.
  await waitFor(() => expect(view.getAllByText("2 失败")).toHaveLength(1));
  expect(view.getAllByText("4.8s").length).toBeGreaterThan(0);
});

// ── the rest ───────────────────────────────────────────────────────────────

test("every frame mixes its colour with the page, so the chart follows the theme", async () => {
  // The regression this pins: fixed OKLCH literals stayed mid-lightness while
  // the page flipped around them and the labels went invisible. The hue is the
  // frame's identity, so it stays a literal; mixing toward `--color-paper` is
  // what makes lightness and chroma follow the theme.
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  await waitFor(() => expect(frames(view).length).toBeGreaterThanOrEqual(4));
  const fills = [...frames(view)].map((node) => node.getAttribute("fill") ?? "");
  expect(fills.filter((fill) => !fill.includes("color-mix(in oklch"))).toEqual([]);
  expect(fills.filter((fill) => !fill.includes("var(--color-paper)"))).toEqual([]);
});

test("sibling frames whose names differ in one token are different colours", async () => {
  // The pairs this fleet actually produces, and the case a reader would see: two
  // frames side by side under one parent. A hash that fed both hue and tint from
  // the same bits put `turn.provider` and `turn.prepare` on one colour.
  serve(
    report({
      stages: [stage("stage.only")],
      traces: [trace("a".repeat(32), { name: "trace.one" })],
      flame: [
        { path: "turn", totalMs: 100, count: 1 },
        { path: "turn;turn.provider", totalMs: 40, count: 1 },
        { path: "turn;turn.prepare", totalMs: 30, count: 1 },
        { path: "turn;GET /api/v1/state", totalMs: 20, count: 1 },
        { path: "turn;GET /api/v1/telemetry", totalMs: 10, count: 1 },
      ],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  await waitFor(() => expect(frames(view).length).toBeGreaterThanOrEqual(6));
  const fills = [...frames(view)].map((node) => node.getAttribute("fill") ?? "");
  // Six: the synthetic root, `turn`, and its four children.
  expect(new Set(fills).size).toBe(fills.length);
});

test("frames of different names are different colours", async () => {
  // The defect this pins: a grey ramp with no hue variance, where every frame
  // was the same flat colour and the chart carried nothing but width. Four
  // distinctly named frames must not collapse to one fill.
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  await waitFor(() => expect(frames(view).length).toBeGreaterThanOrEqual(4));
  const fills = [...frames(view)].map((node) => node.getAttribute("fill") ?? "");
  expect(new Set(fills).size).toBeGreaterThan(1);
});

test("every frame is labelled, in a colour that reads against it", async () => {
  // The library's own stylesheet never loads, so every rule the labels get is
  // one of ours and arrives on the host rather than the label. Unstyled, a label
  // is 16px with no truncation — which is what put "sandb" in a frame.
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  await waitFor(() => expect(flameLabels(view).length).toBeGreaterThanOrEqual(3), { timeout: 3000 });
  expect(flameLabels(view)).toContain("flame.provider");

  const host = view.container.querySelector(".d3-flame-graph")?.parentElement;
  const rules = host?.getAttribute("class") ?? "";
  expect(rules).toContain("[&_.d3-flame-graph-label]:text-ink");
  expect(rules).toContain("[&_.d3-flame-graph-label]:truncate");
  expect(rules).toContain("[&_.d3-flame-graph-label]:text-meta");
});

test("the self-time toggle offers both readings", async () => {
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  await waitFor(() => expect(view.getAllByRole("radio", { name: "自身" })).toHaveLength(1));
  fireEvent.click(view.getByRole("radio", { name: "含下游" }));
  await waitFor(() => expect(frames(view).length).toBeGreaterThanOrEqual(4));
});

test("a chart is neither a control nor a paragraph", async () => {
  const hour = 3_600_000;
  serve(
    report({
      stages: [stage("stage.only")],
      traces: [trace("a".repeat(32), { name: "t" })],
      flame: [{ path: "a", totalMs: 9_000, count: 1 }],
      trend: Array.from({ length: 3 }, (_, i) => ({ at: T0 - (2 - i) * hour, count: 4, p50: 10, p95: 20 })),
    }),
  );
  const view = show(<Telemetry scope={{ kind: "project", id: 7 }} trend />);
  await waitFor(() => expect(view.getAllByText("每次运行的耗时")).toHaveLength(1));

  // Clicking one drew the browser's focus ring and selected the SVG as text,
  // because `ResponsiveContainer` renders a focusable wrapper. Scoped to these
  // two surfaces: a real control still gets its ring.
  const trend = view.container.querySelector("div.touch-none");
  expect(trend?.getAttribute("class")).toContain("select-none");
  expect(trend?.getAttribute("tabindex")).toBe("-1");

  await waitFor(() => expect(view.container.querySelectorAll("svg.d3-flame-graph")).toHaveLength(1));
  const flame = view.container.querySelector("svg.d3-flame-graph")?.parentElement;
  expect(flame?.getAttribute("class")).toContain("select-none");
});

test("scrolling the flamegraph zooms its width, anchored where the pointer is", async () => {
  serve(
    report({
      stages: [stage("stage.only")],
      traces: [trace("a".repeat(32), { name: "t" })],
      flame: [
        { path: "a", totalMs: 9_000, count: 1 },
        { path: "a;b", totalMs: 8_000, count: 1 },
      ],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(view.container.querySelectorAll("svg.d3-flame-graph")).toHaveLength(1));

  const svg = () => view.container.querySelector("svg.d3-flame-graph");
  const before = Number(svg()?.getAttribute("width") ?? 0);
  expect(before).toBeGreaterThan(0);

  // A plain wheel, no modifier: Chrome's profiler default and the binding the
  // user described. The horizontal axis is folded time, so zooming it means the
  // chart is drawn wider and a narrower slice of it is on screen.
  const port = view.container.querySelector("div.overflow-hidden");
  port!.dispatchEvent(
    Object.assign(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }), { clientX: 450 }),
  );

  await waitFor(() => expect(Number(svg()?.getAttribute("width") ?? 0)).toBeGreaterThan(before));

  // The ratio, not just growth: "it grew" is also satisfied by the runaway this
  // replaced, where each render resized what the observer was watching. The
  // minimap's window is the zoom, so svg width × zoom must equal the viewport.
  const pct = Number.parseFloat(
    (await view.findByRole("slider")).firstElementChild?.getAttribute("style")?.match(/width:\s*([\d.]+)%/)?.[1] ?? "",
  );
  expect(Number(svg()?.getAttribute("width") ?? 0) * (pct / 100)).toBeCloseTo(SIZE.width, 0);

  // And a way back, which the node-zoom breadcrumb shares.
  expect(view.getAllByRole("button", { name: /回到全部/ })).toHaveLength(1);
});

test("the minimap appears only once zoomed, and says where you are", async () => {
  serve(
    report({
      stages: [stage("stage.only")],
      traces: [trace("a".repeat(32), { name: "t" })],
      flame: [
        { path: "a", totalMs: 9_000, count: 1 },
        { path: "a;b", totalMs: 8_000, count: 1 },
      ],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(view.container.querySelectorAll("svg.d3-flame-graph")).toHaveLength(1));

  // No control until there is state to undo — Grafana's restraint, and the same
  // rule the reset button already follows.
  expect(view.queryAllByRole("slider")).toHaveLength(0);

  view.container
    .querySelector("div.overflow-hidden")!
    .dispatchEvent(
      Object.assign(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }), { clientX: 450 }),
    );

  // A zoomed flamegraph cannot otherwise say where in the profile you landed.
  const strip = await view.findByRole("slider");
  expect(strip.getAttribute("aria-label")).toBe("看的是哪一段");
  // Narrower than the whole strip, which is the fact it exists to show. Read off
  // the attribute rather than through a cast: the assertion is a number either
  // way, and a cast on a DOM node is the thing the lint rule is there to stop.
  const width = Number.parseFloat(
    strip.firstElementChild?.getAttribute("style")?.match(/width:\s*([\d.]+)%/)?.[1] ?? "",
  );
  expect(width).toBeLessThan(100);
  expect(width).toBeGreaterThan(0);
});

test("the bucket follows the window, and can be pinned", async () => {
  const hour = 3_600_000;
  serve(
    report({
      stages: [stage("stage.only")],
      traces: [trace("a".repeat(32), { name: "t" })],
      trend: Array.from({ length: 4 }, (_, i) => ({ at: T0 - (3 - i) * hour, count: 4, p50: 10, p95: 20 })),
    }),
  );
  const asked: string[] = [];
  const seen = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    asked.push(input instanceof Request ? input.url : String(input));
    return seen(input, init);
  }, seen);

  const view = show(<Telemetry scope={{ kind: "project", id: 7 }} windowMs={24 * hour} trend />);
  await waitFor(() => expect(view.getAllByText("每次运行的耗时")).toHaveLength(1));

  // Derived from the window rather than fixed: the fixed hour is what emptied
  // the chart once the reader zoomed past it.
  expect(String(asked.at(-1))).toContain(`bucketMs=${hour}`);
  // The trigger names the width in force and says it was nobody's choice. A
  // control showing a derived value silently is indistinguishable from one
  // showing a value the reader picked.
  const trigger = view.getByRole("button", { name: /每格 1 小时（跟随）/ });

  // And overridable, because the derived value is a guess about what somebody
  // wants to see.
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await view.findByRole("menuitem", { name: "5 分钟" }));
  await waitFor(() => expect(String(asked.at(-1))).toContain("bucketMs=300000"));
});

test("a width that cannot be drawn across the window is offered and refused", async () => {
  const hour = 3_600_000;
  serve(
    report({
      stages: [stage("stage.only")],
      traces: [trace("a".repeat(32), { name: "t" })],
      // A month at a one-minute bucket is 43,200 points; the old picker took the
      // choice and drew the first eighty minutes, which looks like a dead
      // control. The width comes off the window the *server* answered with, not
      // the request: the endpoint clamps to retention, so they differ.
      window: { from: T0 - 30 * 24 * hour, to: T0 },
      trend: Array.from({ length: 4 }, (_, i) => ({ at: T0 - (3 - i) * hour, count: 4, p50: 10, p95: 20 })),
    }),
  );
  const view = show(<Telemetry scope={{ kind: "project", id: 7 }} windowMs={30 * 24 * hour} trend />);
  await waitFor(() => expect(view.getAllByText("每次运行的耗时")).toHaveLength(1));

  fireEvent.pointerDown(view.getByRole("button", { name: /每格/ }), { button: 0, ctrlKey: false });
  const fine = await view.findByRole("menuitem", { name: /^1 分钟/ });
  expect(fine.getAttribute("aria-disabled")).toBe("true");
  expect(fine.textContent).toContain("画不下");
  // And a width that does fit is takeable, so this is a limit rather than a
  // menu that refuses everything.
  expect(view.getByRole("menuitem", { name: "6 小时" }).getAttribute("aria-disabled")).not.toBe("true");
});

test("scrolling the trend zooms it, and re-reads every block", async () => {
  const hour = 3_600_000;
  serve(
    report({
      stages: [stage("stage.only", { count: 40 })],
      traces: [trace("a".repeat(32), { name: "t" })],
      window: { from: T0 - 6 * hour, to: T0 },
      trend: Array.from({ length: 6 }, (_, i) => ({ at: T0 - (5 - i) * hour, count: 4, p50: 10, p95: 20 })),
    }),
  );
  const asked: string[] = [];
  const seen = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    asked.push(input instanceof Request ? input.url : String(input));
    return seen(input, init);
  }, seen);

  const view = show(<Telemetry scope={{ kind: "project", id: 7 }} trend />);
  await waitFor(() => expect(view.getAllByText("每次运行的耗时")).toHaveLength(1));
  const before = asked.length;

  // A wheel over the chart, not a drag: the gesture the user asked for and the
  // one recharts' `Brush` does not provide.
  // `closest("section")` and not `parentElement`: the heading shares a flex row
  // with the bucket picker now, so its parent is that row rather than the block.
  const chart = view.getByText("每次运行的耗时").closest("section")?.querySelector("div.touch-none");
  // A real `WheelEvent`, not `fireEvent.wheel`'s init object: happy-dom drops
  // `clientX` from the synthetic one, and without a coordinate there is nothing
  // to anchor the zoom on.
  chart!.dispatchEvent(
    Object.assign(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }), { clientX: 450 }),
  );

  // It re-reads, and it asks for an interval rather than a duration — which is
  // the whole point: a window ending at `now` cannot express the middle.
  await waitFor(() => expect(asked.length).toBeGreaterThan(before));
  const url = new URL(String(asked.at(-1)), "http://x");
  expect(url.searchParams.get("from")).not.toBeNull();
  expect(url.searchParams.get("to")).not.toBeNull();
  expect(Number(url.searchParams.get("to"))).toBeGreaterThan(Number(url.searchParams.get("from")));

  expect(view.getAllByRole("button", { name: /回到整段时间/ })).toHaveLength(1);

  // Scrolling the other way widens it again. `report.window` echoes the
  // *requested* window, so using it as the zoom limit made the limit equal the
  // view the instant anybody zoomed: 「反方向滚动缩放回去也没反应」 and
  // 「左右滚动无效」 were that one bug reported twice.
  const narrow = new URL(String(asked.at(-1)), "http://x");
  const narrowSpan = Number(narrow.searchParams.get("to")) - Number(narrow.searchParams.get("from"));
  const after = asked.length;
  chart!.dispatchEvent(
    Object.assign(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }), { clientX: 450 }),
  );
  await waitFor(() => expect(asked.length).toBeGreaterThan(after));
  const wide = new URL(String(asked.at(-1)), "http://x");
  expect(Number(wide.searchParams.get("to")) - Number(wide.searchParams.get("from"))).toBeGreaterThan(narrowSpan);
});

test("耗时 is a view of its own, not a tab under 工单", async () => {
  // A sibling of `Requirement` rather than a tab inside it: as a tab, a project with no
  // requirements could not reach `Time` at all.
  const { contentSlot, VIEWS } = await import("../../web/src/features/navigation/model.ts");
  expect(VIEWS.map(([view]) => view)).toContain("time");
  expect(contentSlot(1, false, "time", 0, false, false)).toBe("time");
  // And reachable with no requirements, which is the state it was invisible in.
  expect(contentSlot(1, false, "time", 0, false, false)).toBe("time");
});

test("the window drives the query every block reads, not just the chart", async () => {
  // The recorder wraps whatever `fetch` is installed, which is MSW's — so it is
  // taken here, after `mockHttp` has started, rather than at module scope.
  serve(report({ stages: [stage("stage.only", { count: 40 })], traces: [trace("a".repeat(32), { name: "t" })] }));
  const asked: string[] = [];
  const seen = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    asked.push(input instanceof Request ? input.url : String(input));
    return seen(input, init);
  }, seen);
  const view = show(<Telemetry scope={{ kind: "project", id: 7 }} windowMs={7 * 24 * 3_600_000} trend />);
  await waitFor(() => expect(view.getAllByText("stage")).toHaveLength(1));

  // What the brush changes is `windowMs` on the one query the whole page reads,
  // which is why narrowing it changes what the *tables* count and not only what
  // the chart draws. The gesture itself is not simulated — recharts' traveller
  // needs real pointer geometry that happy-dom does not provide — so this pins
  // the half that could silently break: the request carrying the window.
  // `draggedWindow` covers the other half, in four unit tests.
  expect(String(asked.at(-1))).toContain(`windowMs=${7 * 24 * 3_600_000}`);

  cleanup();
  const narrower = show(<Telemetry scope={{ kind: "project", id: 7 }} windowMs={3_600_000} trend />);
  await waitFor(() => expect(narrower.getAllByText("stage")).toHaveLength(1));
  expect(String(asked.at(-1))).toContain("windowMs=3600000");
});

test("a trend with one bucket keeps its section, and therefore its controls", async () => {
  serve(
    report({
      stages: [stage("stage.only")],
      traces: [trace("a".repeat(32), { name: "trace.one" })],
      trend: [{ at: T0, count: 4, p50: 1, p95: 2 }],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "project", id: 7 }} trend />);

  // Hiding the whole block on a thin trend also hid the bucket picker and
  // the reset-to-full-range control, so narrowing to one bucket deleted the way back out of the
  // state it created. It stays and says it is empty, in the chart's own slot.
  await waitFor(() => expect(view.getAllByText("stage")).toHaveLength(1));
  expect(view.getAllByText("每次运行的耗时")).toHaveLength(1);
  expect(view.getAllByText("还不够两个时段的数据。")).toHaveLength(1);
  expect(view.getAllByRole("button", { name: /每格/ })).toHaveLength(1);
});

test("the table says what a stage is, not what the code calls it", async () => {
  serve(
    report({
      stages: [stage("sandbox.create", { p50: 7_200, p95: 21_000 }), stage("turn.provider", { p50: 400, p95: 900 })],
      traces: [trace("a".repeat(32), { name: "trace.one" })],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  // Two stages in two different kinds, so the groups are what is on screen
  // first: `Sandbox operation` for sandbox, `Run one turn` for turn.
  await waitFor(() => expect(view.getAllByText("容器操作")).toHaveLength(1));
  expect(view.getAllByText("跑一轮")).toHaveLength(1);
  openGroup(view, "容器操作");
  await waitFor(() => expect(view.getAllByText("开一个新环境")).toHaveLength(1));
  // The identifier is not printed beside the words; it is one hover away.
  expect(view.queryAllByText("sandbox.create")).toHaveLength(0);

  expect(view.getAllByText("一般")).toHaveLength(1);
  expect(view.getAllByText("最慢")).toHaveLength(1);
  expect(view.queryAllByText("p50")).toHaveLength(0);
  expect(view.queryAllByText("p95")).toHaveLength(0);
});

test("a stage nobody has named shows its own identifier", async () => {
  serve(
    report({
      stages: [stage("brand.new.stage", { p95: 900 })],
      traces: [trace("a".repeat(32), { name: "trace.one" })],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  await waitFor(() => expect(view.getAllByText("brand")).toHaveLength(1));
  openGroup(view, "brand");
  await waitFor(() => expect(view.getAllByText("brand.new.stage")).toHaveLength(1));
});

test("the folded tail is a door, not a truncation notice", async () => {
  serve(
    report({
      stages: [
        stage("turn.provider", { p95: 9_000 }),
        stage("turn.prepare", { p95: 12 }),
        stage("turn.checkpoint", { p95: 8 }),
      ],
      traces: [trace("a".repeat(32), { name: "trace.one" })],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  // Folded first: the two fast stages are not rows until asked for. All three
  // are `turn.*`, so they share one group and the fold is the only thing
  // deciding what is inside it.
  await waitFor(() => expect(view.getAllByText("跑一轮")).toHaveLength(1));
  openGroup(view, "跑一轮");
  await waitFor(() => expect(view.getAllByText("模型在想")).toHaveLength(1));
  expect(view.queryAllByText("准备这一轮")).toHaveLength(0);

  fireEvent.click(view.getByRole("button", { name: /展开另外 2 个/ }));
  await waitFor(() => expect(view.getAllByText("准备这一轮")).toHaveLength(1));
  expect(view.getAllByText("存一次档")).toHaveLength(1);

  fireEvent.click(view.getByRole("button", { name: /收起另外 2 个/ }));
  await waitFor(() => expect(view.queryAllByText("准备这一轮")).toHaveLength(0));
});

test("a stage can be hidden, and the page says so with a way back", async () => {
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(view.getAllByText("stage")).toHaveLength(1));

  openGroup(view, "stage");
  await waitFor(() => expect(view.getAllByText("stage.provider")).toHaveLength(1));
  fireEvent.contextMenu(view.getByRole("button", { name: /stage.provider/ }));
  fireEvent.click(await view.findByRole("menuitem", { name: "不看这一段" }));

  // An exclusion nobody can see is the page quietly lying about its own totals.
  await waitFor(() => expect(view.getAllByText("不看：")).toHaveLength(1));
  expect(view.queryAllByText("stage.provider")).toHaveLength(0);

  fireEvent.click(view.getByRole("button", { name: "全部恢复" }));
  await waitFor(() => expect(view.getAllByText("stage.provider")).toHaveLength(1));
});

test("a requirement shows which slice ate the time", async () => {
  serve(
    report({
      stages: [stage("turn.provider", { p95: 9_000 })],
      traces: [trace("a".repeat(32), { name: "trace.one" })],
      slices: [
        { sliceId: 1, totalMs: 1_000, count: 2, errors: 0 },
        { sliceId: 3, totalMs: 12_400, count: 4, errors: 2 },
        { sliceId: null, totalMs: 90, count: 1, errors: 0 },
      ],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);

  await waitFor(() => expect(view.getAllByText("各切片耗时")).toHaveLength(1));
  expect(view.getAllByText("切片 1")).toHaveLength(1);
  expect(view.getAllByText("切片 3")).toHaveLength(1);
  // Unsliced work is a row of its own, so the parts add up to the requirement.
  expect(view.getAllByText("没归到切片")).toHaveLength(1);
  expect(view.getAllByText("12.4s")).toHaveLength(1);
});

test("a scope with no slice split draws no slice block", async () => {
  // A project's slices belong to different requirements and share only their
  // sequence numbers, so the server sends none and the block removes itself
  // rather than drawing a heading over one bar.
  serve(report({ stages: [stage("stage.only")], traces: [trace("a".repeat(32), { name: "trace.one" })] }));
  const view = show(<Telemetry scope={{ kind: "project", id: 7 }} trend />);

  await waitFor(() => expect(view.getAllByText("stage")).toHaveLength(1));
  expect(view.queryAllByText("各切片耗时")).toHaveLength(0);
});

test("selected and hovered are two states, so three appearances between them", async () => {
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(view.getAllByText("stage")).toHaveLength(1));
  openGroup(view, "stage");
  await waitFor(() => expect(view.getAllByText("stage.provider")).toHaveLength(1));

  const row = () => view.getByRole("button", { name: /stage.provider/ }).getAttribute("class") ?? "";
  // Unselected: hover paints the neutral tint.
  expect(row()).toContain("hover:bg-rail");
  expect(row()).not.toContain("bg-accent-soft");

  fireEvent.click(view.getByRole("button", { name: /stage.provider/ }));

  // Selected: its own resting colour, and its own hover on top of it. A plain
  // `hover:bg-rail` here is a later rule on the same property, which is how a
  // selected row lost its selection the moment the pointer crossed it.
  await waitFor(() => expect(row()).toContain("bg-accent-soft"));
  expect(row()).toContain("hover:bg-accent-soft/60");
  expect(row()).not.toContain("hover:bg-rail");
});

test("a group total is a selection, and it reaches the flamegraph", async () => {
  serve(
    report({
      stages: [
        stage("watchdog.repo_map", { p95: 9_000, totalMs: 9_000 }),
        stage("watchdog.turn_timeout", { p95: 8_000, totalMs: 8_000 }),
      ],
      traces: [trace("a".repeat(32), { name: "trace.one" })],
      flame: [
        { path: "watchdog.repo_map", totalMs: 9_000, count: 1 },
        { path: "turn.provider", totalMs: 1_000, count: 1 },
      ],
    }),
  );
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(view.getAllByText("巡检规则")).toHaveLength(1));

  // A total worth showing is a total worth clicking, and clicking it has to
  // reach the other chart. This is the bug that produced `search: 0 of
  // 11271164.5 total samples`: the selection used to be handed over as the kind
  // label `Watchdog rule`, which no frame has ever been called.
  fireEvent.click(view.getAllByRole("button", { name: /^17\.0s$/ })[0]!);

  await waitFor(() => {
    const accent = [...frames(view)].filter((f) => f.getAttribute("fill") === "var(--color-accent)");
    expect(accent.length).toBeGreaterThan(0);
  });
});

test("hovering a frame says what it cost and how much of the chart it is", async () => {
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(frameGroups(view).length).toBeGreaterThanOrEqual(4));

  // Nothing pointed at, nothing said. The line holds its height regardless, so
  // the chart under it does not jump when the pointer arrives.
  expect(readout(view)).toBe("");

  const frame = [...frameGroups(view)].find((node) => node.getAttribute("name") === "flame.provider");
  fireEvent.mouseOver(frame!);

  // Name, time, and share of what is on screen — the three things Grafana's
  // tooltip carries, on one line instead of in a floating card.
  await waitFor(() => expect(readout(view)).toContain("flame.provider"));
  expect(readout(view)).toContain("8.0s");
  expect(readout(view)).toMatch(/\d+\.\d%/);

  fireEvent.mouseOut(frame!);
  await waitFor(() => expect(readout(view)).toBe(""));
});

test("clicking a frame zooms, and the way back out names where you are", async () => {
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(frameGroups(view).length).toBeGreaterThanOrEqual(4));

  expect(view.queryAllByText("← 回到全部")).toHaveLength(0);

  const frame = [...frameGroups(view)].find((node) => node.getAttribute("name") === "flame.provider");
  fireEvent.click(frame!);

  await waitFor(() => expect(view.getAllByText("← 回到全部")).toHaveLength(1));
  expect(view.getAllByText("看的是 flame.provider")).toHaveLength(1);

  fireEvent.click(view.getByText("← 回到全部"));
  await waitFor(() => expect(view.queryAllByText("← 回到全部")).toHaveLength(0));
});

test("clicking back to the root is not a zoom to come back from", async () => {
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(frameGroups(view).length).toBeGreaterThanOrEqual(4));

  // The root frame spans the whole chart, so clicking it is already "all of it".
  const root = [...frameGroups(view)].find((node) => node.getAttribute("name") === "全部");
  fireEvent.click(root!);
  await waitFor(() => expect(frameGroups(view).length).toBeGreaterThanOrEqual(4));
  expect(view.queryAllByText("← 回到全部")).toHaveLength(0);
});

test("self and total are two encodings, not two labels", async () => {
  serve(ONE_TRACE);
  const view = show(<Telemetry scope={{ kind: "group", id: 3 }} />);
  await waitFor(() => expect(frames(view).length).toBeGreaterThanOrEqual(4));
  const widthOf = (name: string) =>
    [...frameGroups(view)]
      .find((node) => node.getAttribute("name") === name)
      ?.querySelector("rect")
      ?.getAttribute("width") ?? "";

  const selfWidth = widthOf("flame.turn");
  expect(selfWidth).not.toBe("");

  fireEvent.click(view.getByRole("radio", { name: "含下游" }));

  // `flame.turn` spent 9s itself and called 8.2s more, so the frame that is a
  // share of one is a different width from the frame that is a share of both.
  // A toggle that changed only the caption would leave this equal.
  await waitFor(() => expect(widthOf("flame.turn")).not.toBe(selfWidth));
});

// ── the page ───────────────────────────────────────────────────────────────

test("系统耗时 is a page with its own heading, on the host's spans", async () => {
  // It was a shut accordion at the foot of the landing page. As a settings pane
  // it names itself and says which window it is answering for, because nothing
  // above it does that any more.
  serve(report({ stages: [stage("GET /api/v1/state", { p50: 4, p95: 9 })] }));
  const view = show(<SystemTiming />);

  await waitFor(() => expect(view.getAllByText("系统耗时")).toHaveLength(1));
  expect(view.getAllByText("这台机器上所有活动的耗时，最近一天")).toHaveLength(1);
  // Routes are one kind, so the group is what names them until it is opened.
  await waitFor(() => expect(view.getAllByText("接口请求")).toHaveLength(1));
});

test("the host page asks for the host's spans and nothing else", async () => {
  // The scope is a module constant rather than an object literal in the JSX: a
  // fresh object every render is a fresh effect dependency, and this pane would
  // re-read on every keystroke anywhere above it.
  const asked: string[] = [];
  const answer = report({ stages: [stage("stage.only")] });
  server.use(
    http.get("/api/v1/telemetry", ({ request }) => {
      asked.push(request.url);
      return HttpResponse.json(answer);
    }),
  );

  const view = show(<SystemTiming />);
  await waitFor(() => expect(view.getAllByText("stage")).toHaveLength(1));

  expect(asked.filter((url) => url.includes("scope=system"))).toHaveLength(1);
  expect(asked.filter((url) => url.includes("id="))).toHaveLength(0);
});

/**
 * The wheel, as arithmetic. Here rather than in `telemetry-model.test.ts`
 * because it reads a real element's box, and that file deliberately runs
 * without a document. `SIZE` is the stubbed viewport: 900 wide, left edge 0.
 */
const INSET = { left: 60, right: 20 };
const PLOT = SIZE.width - INSET.left - INSET.right;
const scroll = (over: { deltaX?: number; deltaY?: number; clientX: number }) =>
  Object.assign(new WheelEvent("wheel", { deltaX: over.deltaX ?? 0, deltaY: over.deltaY ?? 0 }), {
    clientX: over.clientX,
  });

/**
 * recharts reserves the y axis on the left and a margin on the right, and the
 * element that catches the wheel is the whole box. Measuring the pointer against
 * the box rather than the plot anchored every zoom left of where the reader was
 * pointing, so the frame under the cursor slid away as they zoomed at it.
 */
test("a zoom anchors on the pointer, corrected for the axis gutter", () => {
  const el = document.createElement("div");
  // Dead centre of the plot, which sits 60px in: 60 + 820/2.
  const next = wheelWindow(
    scroll({ deltaY: -100, clientX: INSET.left + PLOT / 2 }),
    el,
    { from: 0, to: 1_000 },
    { from: 0, to: 1_000 },
    1,
    INSET,
  );
  expect(next).not.toBeNull();
  expect(next!.to - next!.from).toBeLessThan(1_000);
  expect(next!.from + (next!.to - next!.from) / 2).toBeCloseTo(500, 0);
});

/**
 * A trackpad's two-finger swipe is a horizontal wheel. Treated as a zoom it
 * jittered the scale on every pan; it has to move the window and leave the width
 * the reader chose alone.
 */
test("a horizontal wheel pans by its own distance and keeps the width", () => {
  const el = document.createElement("div");
  const next = wheelWindow(
    scroll({ deltaX: 82, clientX: 400 }),
    el,
    { from: 200, to: 600 },
    { from: 0, to: 1_000 },
    1,
    INSET,
  );
  // 82px across an 820px plot is a tenth of the 400-wide window.
  expect(next).toEqual({ from: 240, to: 640 });
});

/**
 * The axis labels and the margin are inside the element that catches the wheel,
 * so a scroll over them is a real gesture at a negative fraction of the plot.
 * Pointing at the gutter means pointing at the edge, not somewhere off-chart.
 */
test("a scroll over the gutter anchors at the edge rather than outside it", () => {
  const el = document.createElement("div");
  const next = wheelWindow(
    scroll({ deltaY: -100, clientX: 10 }),
    el,
    { from: 200, to: 600 },
    { from: 0, to: 1_000 },
    1,
    INSET,
  );
  expect(next!.from).toBe(200);
});
