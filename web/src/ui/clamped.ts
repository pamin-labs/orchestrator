import { useLayoutEffect, useRef, useState } from "react";

/**
 * Whether the element is actually cut off, asked of the browser.
 *
 * The two disclosure buttons that need this each guessed from `text.length`, and
 * a character count is not a display width: at `max-w-[72ch]` a CJK glyph takes
 * about two columns, so three clamped lines hold ~108 of them against ~200
 * Latin. A 150-glyph Korean verdict was clamped with no Expand button — the
 * content unreachable, in the language this product is mostly read in.
 */
/**
 * `useLayoutEffect` and no `ResizeObserver`: the answer is read before paint,
 * and re-read when `on` moves. A window resize between renders is the honest
 * gap, and it costs a button that is briefly wrong rather than content that
 * cannot be reached.
 */
/**
 * `on` is a resolved key, not the values it stands for — `` `${text}:${open}` ``
 * rather than `[text, open]`, because an array literal is a new identity every
 * render and the effect would never settle. Same rule as a React `key`.
 */
/**
 * The reading is stored *with* the content it was taken of. As a bare boolean,
 * `on` was a dependency the effect never read — an extra one, by
 * `exhaustive-effect-dependencies`, and correctly so: nothing in the body tied
 * the measurement to the thing measured. Dropping the array instead trades that
 * for `react-hooks(exhaustive-deps)`, a setState with no list. Keeping the key in
 * the state says what the boolean is an answer about.
 */
export function useClamped<T extends HTMLElement>(on: string): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [measured, setMeasured] = useState({ on, clamped: false });
  useLayoutEffect(() => {
    const el = ref.current;
    // A hair of tolerance: sub-pixel line heights make an unclamped element
    // report a scrollHeight a fraction above its client height.
    if (el) setMeasured({ on, clamped: el.scrollHeight > el.clientHeight + 1 });
  }, [on]);
  // Not `measured.clamped` alone: between `on` changing and the effect running,
  // the stored answer is about the previous content.
  return [ref, measured.on === on && measured.clamped];
}
