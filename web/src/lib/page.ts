import { useState } from "react";

/**
 * Show a page, keep the rest one click away.
 *
 * Every list here is sorted so the rows that need the boss are at the top, which
 * makes the tail cheap to defer — but never to hide: the count of what is not shown
 * is always rendered, because a silently truncated list reads as a complete one.
 *
 * ponytail: slice + a button, not a virtual list. Swap in windowing when a real
 * project actually has thousands of rows and this measurably janks.
 */
export function usePaged<T>(items: T[], size = 40) {
  const [n, setN] = useState(size);
  return {
    page: items.length <= n ? items : items.slice(0, n),
    rest: Math.max(0, items.length - n),
    more: () => setN((x) => x + size),
    total: items.length,
  };
}
