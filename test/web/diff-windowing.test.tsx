import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "../support/render.tsx";
import { DiffView } from "../../web/src/features/diff/view.tsx";

/**
 * The diff mounted every file at once, whatever its length.
 *
 * The per-file cap of 400 rows was standing in for windowing, and it could not
 * do that job: it bounds one file, not a hundred and thirty of them, and it stops
 * applying the moment a reader expands one.
 */
/**
 * The rail is the part windowing could have broken. It used to observe every
 * file's header with an IntersectionObserver and scroll by measuring one's
 * `offsetTop`; neither survives a list where most files are not mounted.
 */

afterEach(cleanup);

/** `n` files of `lines` added lines each, as a unified diff. */
const manyFiles = (n: number, lines: number) =>
  Array.from({ length: n }, (_, f) => {
    const body = Array.from({ length: lines }, (_, i) => `+file ${f} line ${i}`).join("\n");
    return `--- a/f${f}.txt\n+++ b/f${f}.txt\n@@ -0,0 +1,${lines} @@\n${body}\n`;
  }).join("");

const mounted = (root: HTMLElement) => root.querySelectorAll("[data-index]").length;

/** The index rail: a `nav` of one button per file, built from the parsed diff. */
function railOf(root: HTMLElement): HTMLElement {
  const nav = root.querySelector("nav");
  if (!nav) throw new Error("no rail");
  return nav;
}

/** The element the file list scrolls — `VirtualList`'s own box. */
function scrollerOf(root: HTMLElement): HTMLElement {
  const scroller = root.querySelector("[data-index]")?.closest<HTMLElement>(".overflow-y-auto");
  if (!scroller) throw new Error("no scroller");
  return scroller;
}

test("a hundred files mount as a window, not as a hundred", () => {
  const { container } = render(<DiffView diff={manyFiles(100, 30)} />);

  expect(mounted(container)).toBeGreaterThan(0);
  expect(mounted(container)).toBeLessThan(100);
});

test("the rows drawn are the visible files' rows, not every file's", () => {
  const { container } = render(<DiffView diff={manyFiles(100, 30)} />);

  // 100 files × (30 rows + 1 hunk gap) is 3100 if nothing windows them.
  expect(container.querySelectorAll("tr").length).toBeLessThan(3100 / 2);
});

test("the rail names every file, mounted or not", () => {
  const { container } = render(<DiffView diff={manyFiles(100, 30)} />);

  // The rail is built from the parsed diff, not from what is on screen: a reader
  // cannot jump to a file the index does not list.
  expect(railOf(container).querySelectorAll("button").length).toBe(100);
});

test("clicking a rail entry asks the list to go there", () => {
  const { container } = render(<DiffView diff={manyFiles(100, 30)} />);
  const scroller = scrollerOf(container);
  let asked = 0;
  scroller.scrollTo = () => {
    asked += 1;
  };

  // The last one, which windowing guarantees is not mounted — the case the old
  // `offsetTop` of an unmounted header could not answer.
  fireEvent.click(railOf(container).querySelectorAll("button")[99]!);

  expect(asked).toBeGreaterThan(0);
});

test("a file over the cap still offers the rest, and drawing it does not draw every file", () => {
  const { container } = render(<DiffView diff={manyFiles(2, 500)} />);
  const before = container.querySelectorAll("tr").length;

  // By place, not by label: the panel renders in whichever of ten languages the
  // reader chose, and these tests run under the Chinese catalogue.
  const more = [...container.querySelectorAll("button")].find((b) => !b.closest("nav"));
  if (!more) throw new Error("a file over the cap offered no way to see the rest");
  fireEvent.click(more);

  expect(container.querySelectorAll("tr").length).toBeGreaterThan(before);
  expect(mounted(container)).toBeLessThanOrEqual(2);
});
