import { expect, test } from "bun:test";
import type { Usage } from "../../web/src/shared/api.ts";
import { windowRing } from "../../web/src/features/usage/view.tsx";

/**
 * The header rings are the fleet's fuel gauge: a window shown without its
 * reading, or a reading shown for a window the plan does not have, both make the
 * boss start work an account cannot finish.
 */

const usage = (over: Partial<Usage>): Usage => ({ runtime: "claude", at: 1000, ...over });

test("each ring carries exactly its own window's reading and reset", () => {
  const u = usage({ fiveHourPercent: 12.5, resetsAt: 111, weeklyPercent: 66, weeklyResetsAt: 222 });
  expect(windowRing(u, "five")).toEqual({ v: 12.5, at: 111 });
  expect(windowRing(u, "week")).toEqual({ v: 66, at: 222 });

  // An account without the weekly window holds the column open and says nothing:
  // an empty ring is the plan's shape, not a failed read.
  const fiveOnly = usage({ fiveHourPercent: 42, resetsAt: 111 });
  expect(windowRing(fiveOnly, "five")).toEqual({ v: 42, at: 111 });
  expect(windowRing(fiveOnly, "week")).toEqual({});
});
