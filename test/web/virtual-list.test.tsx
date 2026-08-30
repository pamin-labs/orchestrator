import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render as mount } from "../support/render.tsx";
import { VirtualList } from "../../web/src/ui/virtual-list.tsx";

/**
 * Windowing, and the half of "stay at the bottom" that was missing.
 *
 * Two copies of the pin rule existed five files apart: `Bootstrap` kept a
 * `pinned` ref and followed only while the reader was already at the bottom,
 * and `Workspace` had the effect without the guard — scrolling up in the
 * container log yanked you back on the next line.
 */
/**
 * The assertion is that the list *asks* to scroll. happy-dom has no layout and
 * no scrolling, so whether the box moves is not a fact this environment holds;
 * whether the component requested it is.
 */

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);

const List = ({ items, pin = false }: { items: string[]; pin?: boolean }) => (
  <VirtualList items={items} estimate={20} keyOf={(v) => v} pin={pin} className="h-40">
    {(value) => <div>{value}</div>}
  </VirtualList>
);

/** The element `VirtualList` scrolls: its own outermost div. */
function scrollerIn(container: HTMLElement): HTMLDivElement {
  const scroller = container.querySelector("div");
  if (!scroller) throw new Error("VirtualList rendered no scroller");
  return scroller;
}

/** Replaces the scroller's `scrollTo` with a counter, and hands back the count. */
function watchScrolling(container: HTMLElement): () => number {
  let asked = 0;
  scrollerIn(container).scrollTo = () => {
    asked += 1;
  };
  return () => asked;
}

/** Puts the reader far from the bottom, the way a scroll up would. */
function scrollAway(container: HTMLElement): void {
  const scroller = scrollerIn(container);
  for (const [name, value] of [
    ["scrollHeight", 8000],
    ["clientHeight", 160],
  ] as const) {
    Object.defineProperty(scroller, name, { value, configurable: true });
  }
  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
}

afterEach(cleanup);

test("a long list renders a window, not every row", () => {
  const { container } = mount(<List items={lines(5000)} />);
  const drawn = container.querySelectorAll("[data-index]").length;

  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(200);
});

test("every row is reachable: the window moves with the reader", () => {
  const { container } = mount(<List items={lines(5000)} />);
  const drawn = [...container.querySelectorAll("[data-index]")].map((el) => Number(el.getAttribute("data-index")));

  // Contiguous from the top, which is what a window is — not a sample.
  expect(drawn[0]).toBe(0);
  expect(drawn).toEqual(drawn.map((_, i) => i));
});

test("the reader who stays at the bottom is carried to the newest row", () => {
  const { container, rerender } = mount(<List items={lines(50)} pin />);
  const asked = watchScrolling(container);

  rerender(<List items={lines(80)} pin />);

  expect(asked()).toBeGreaterThan(0);
});

test("the reader who scrolled up is left where they are", () => {
  const { container, rerender } = mount(<List items={lines(400)} pin />);
  scrollAway(container);
  const asked = watchScrolling(container);

  rerender(<List items={lines(500)} pin />);

  expect(asked()).toBe(0);
});

test("a list that does not pin never follows, however many rows arrive", () => {
  const { container, rerender } = mount(<List items={lines(50)} />);
  const asked = watchScrolling(container);

  rerender(<List items={lines(500)} />);

  expect(asked()).toBe(0);
});
