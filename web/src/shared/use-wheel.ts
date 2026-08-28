import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * A wheel listener that is allowed to say no.
 *
 * React registers `onWheel` as a **passive** listener, where `preventDefault()`
 * only logs a warning — and what needs refusing is the trackpad's back/forward
 * gesture, which loses the page mid-pan. `overscroll-behavior` governs scroll
 * chaining, and these elements do not scroll. So `{ passive: false }`, by hand.
 */
export function useWheel(target: React.RefObject<HTMLElement | null>, onWheel: (event: WheelEvent) => void) {
  const latest = useRef(onWheel);
  // Written in a layout effect, not in render: a ref assignment during render is
  // a side effect React is allowed to throw away, and this one exists precisely
  // so the listener below is registered once instead of per callback identity.
  // Layout, so it lands before any wheel event the same commit could produce.
  useLayoutEffect(() => {
    latest.current = onWheel;
  });
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const handler = (event: WheelEvent) => latest.current(event);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [target]);
}
