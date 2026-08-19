/**
 * `d3-flame-graph` ships no types and has no `@types` package.
 *
 * Declared here rather than reached for with `any`: the point of the React shell
 * around this library is that its lifecycle is easy to get wrong, and a shell the
 * compiler cannot check keeps compiling after `destroy` is renamed. Only the
 * methods used are declared — transcribing thirty-eight chainable setters would be
 * a second copy of somebody else's API to keep in sync.
 */
/**
 * `FlameFrame` is for the mappers in `view.tsx`, inside this same project.
 * Nothing in an ambient declaration crosses the project reference into
 * `tsconfig.test.json` — a test importing a name from here resolves to an error
 * type, which is how that was noticed — so the type a *test* holds is `FlameNode`
 * in `model.ts`, an ordinary export that does cross.
 */
declare module "d3-flame-graph" {
  /**
   * One frame, as the library hands it to a mapper: a `d3-hierarchy` node.
   *
   * `data` is ours, unchanged. The other three are the library's own working.
   * `value` is the number the frame was *laid out* by, which is not `data.value` —
   * under `selfValue(false)` it is the subtree's sum, so a mapper reading
   * `data.value` reports self time while the frame is drawn to total. `x0`/`x1` are
   * the span of the chart in 0–1, the only place a percentage can come from, and
   * `parent` is `null` at the root.
   */
  export interface FlameFrame {
    data: { name: string; value: number };
    value: number;
    x0: number;
    x1: number;
    parent: FlameFrame | null;
    highlight?: boolean;
  }

  export interface FlameGraph {
    /**
     * The chart is itself a function: `selection.call(chart)` is how it
     * attaches. The selection is `unknown` because the only caller passes d3's
     * own and nothing here reads it — narrowing it would mean transcribing
     * `Selection`'s four type parameters to no benefit.
     */
    (selection: unknown): void;
    width(px: number): FlameGraph;
    cellHeight(px: number): FlameGraph;
    /** Frames narrower than this are not drawn — the deep-nesting floor. */
    minFrameSize(px: number): FlameGraph;
    /** `true` measures a frame by its own time rather than its subtree's. */
    selfValue(on: boolean): FlameGraph;
    /** Our tokens instead of the library's hot-orange default. */
    setColorMapper(map: (node: FlameFrame) => string): FlameGraph;
    /**
     * What a hover says. Not the text on the frame — that is always the bare
     * name — but the string written into the details element and the `<title>`.
     */
    setLabelHandler(label: (node: FlameFrame) => string): FlameGraph;
    /**
     * What to write into the details element when a search runs.
     *
     * Overridden to write nothing. The default composes an English sentence with
     * a raw float — `search: 0 of 11271164.521939998 total samples ( 0.000%)` —
     * in a vocabulary this product does not use, and the highlighted frames say
     * the same thing without it.
     */
    setSearchHandler(handler: () => void): FlameGraph;
    /**
     * Where that string is written. The library sets `textContent` on hover and
     * clears it on mouseout, so this element belongs to the hover and nothing
     * else may share it.
     */
    setDetailsElement(el: HTMLElement | null): FlameGraph;
    /** Called after a click has already zoomed, with the frame zoomed into. */
    onClick(handler: (node: FlameFrame) => void): FlameGraph;
    /** Back to the whole tree. The way out of a zoom. */
    resetZoom(): void;
    sort(on: boolean): FlameGraph;
    inverted(on: boolean): FlameGraph;
    transitionDuration(ms: number): FlameGraph;
    /** Highlights matching frames; the empty string clears the highlight. */
    search(term: string): void;
    update(data?: unknown): void;
    /** Tears the chart out of its container. The reason this shell exists. */
    destroy(): void;
  }

  export default function flamegraph(): FlameGraph;
}
