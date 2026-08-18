import { useEffect, useRef } from "react";

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
  latest.current = onWheel;
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const handler = (event: WheelEvent) => latest.current(event);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [target]);
}
