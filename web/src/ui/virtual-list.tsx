import { useEffect, useImperativeHandle, useRef, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "./cn";

/**
 * The one place windowing is wired, and the one file allowed to import the
 * virtualizer.
 *
 * Four lists were each capped to a literal — 160 timeline rows, 300 bootstrap
 * lines, 4000 gate transcript lines — because nothing windowed them. The cap was
 * the wrong half: the gate log reaches its 4000 on any `bun test` run, and the
 * filter box above it redrew all of them per keystroke.
 */
/**
 * `test/governance/one-file-owns-windowing.test.ts` keeps the import here, so
 * swapping the library is one file rather than four — and so the stick-to-bottom
 * rule has one copy rather than the two that had already drifted apart.
 *
 * The caller gives items, a key, and a row. It never sees a virtual item, a
 * measurement, or a scroll offset — `handle` and `onTop` speak in item indexes,
 * which is a fact about the list rather than about the library under it.
 */

/**
 * A viewport for an environment that has no layout.
 *
 * `getBoundingClientRect` returns zeros under happy-dom, so a virtualizer
 * measures a zero-high window and renders no rows at all — six tests that mount
 * `Timeline` and assert on its text would go red for a reason none of them is
 * about. `initialRect` is the documented entry point for exactly this, and it is
 * also what an unmeasured first paint uses in a browser.
 */
const ASSUMED = { width: 640, height: 640 };

/** Within this of the bottom counts as "the reader is at the bottom". */
const AT_BOTTOM_PX = 24;

/** What a caller with an index rail beside the list can ask of it. */
export type ListHandle = { scrollTo: (index: number) => void };

export function VirtualList<T>({
  items,
  estimate,
  keyOf,
  children,
  className,
  pin = false,
  role,
  label,
  handle,
  onTop,
}: {
  items: T[];
  /**
   * Row height before anything is measured. A number where rows are alike; a
   * function where they are not — a diff's files run from three rows to four
   * hundred, and one number for both makes the scrollbar jump as each is
   * measured. The row count is known before the row is drawn, so say so.
   */
  estimate: number | ((item: T) => number);
  keyOf: (item: T) => string;
  children: (item: T) => ReactNode;
  className?: string;
  /** Follow the newest row, but only while the reader is already there. */
  pin?: boolean;
  role?: string;
  label?: string;
  /** For a caller that has to drive the list — an index rail, a jump target. */
  handle?: RefObject<ListHandle | null>;
  /** The topmost item, for a rail that follows the reader rather than leading. */
  onTop?: (index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Not state: a scroll must not re-render the list, and the effect below reads
  // it at the moment a row arrives rather than at the moment it was set.
  const pinned = useRef(true);

  // oxlint-disable-next-line react/incompatible-library -- the rule's concern is a virtualizer value reaching a memoised component and going stale. None does: this file passes the caller `items[row.index]`, never a virtual item, a measurement or an offset, which is the whole point of the wrapper. The one memoised row in the panel, `TimelineRow`, takes a frame and a string.
  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => box.current,
    estimateSize: (index) => (typeof estimate === "number" ? estimate : estimate(items[index]!)),
    getItemKey: (index) => keyOf(items[index]!),
    initialRect: ASSUMED,
    overscan: 12,
  });

  useImperativeHandle(handle, () => ({ scrollTo: (index) => rows.scrollToIndex(index, { align: "start" }) }), [rows]);

  const drawn = rows.getVirtualItems();
  // The virtualizer already knows what is at the top, so a caller that wants it
  // does not need an IntersectionObserver over every item to find out — which is
  // what the diff rail was doing, over items that are no longer all mounted.
  const top = drawn[0]?.index;
  useEffect(() => {
    if (onTop && top !== undefined) onTop(top);
  }, [onTop, top]);

  const count = items.length;
  useEffect(() => {
    // `scrollToIndex`, not `scrollTop = scrollHeight`: past the measured range
    // the total size is estimated, so the raw height is a guess and the
    // virtualizer is the thing that knows how to correct it as rows measure.
    if (pin && count && pinned.current) rows.scrollToIndex(count - 1, { align: "end" });
  }, [pin, count, rows]);

  return (
    <div
      ref={box}
      role={role}
      aria-label={label}
      className={cn("overflow-y-auto", className)}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
      }}
    >
      <div className="relative w-full" style={{ height: rows.getTotalSize() }}>
        {drawn.map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={rows.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {children(items[row.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}
