import { expect, test } from "bun:test";
import { GRP_STATES } from "../../src/contracts/states.ts";
import { heldApproved, STATUS_ZH, statusLabel } from "../../web/src/shared/select.ts";

/**
 * Every state the vocabulary can hold has a word the boss reads.
 *
 * `statusLabel` falls back to `g.status`, so a state added to
 * `src/contracts/states.ts` without a line here does not fail anywhere — it
 * quietly shows `PR_OPEN` on the panel to someone who has never read the enum.
 * The fallback is right (an unlabelled state is better than an empty cell) and
 * that is exactly why it needs a test: nothing else notices.
 */

const group = (status: string, approvedAt: number | null = null) =>
  ({ status, approved_at: approvedAt }) as Parameters<typeof statusLabel>[0];

test("every group state has a label, and none of them is the enum name", () => {
  const missing = GRP_STATES.filter((s) => !STATUS_ZH[s]);
  expect(missing).toEqual([]);
  // Not merely present: a label that is the identifier back again would pass the
  // check above while showing the boss the same thing the fallback would.
  const echoed = GRP_STATES.filter((s) => STATUS_ZH[s] === s);
  expect(echoed).toEqual([]);
});

test("an approved draft says so, because 待批 would be a lie once it is approved", () => {
  // The one state whose label depends on more than the state: a DRAFT the boss
  // has approved is waiting on the boundary, not on the boss, and saying 待批
  // sends them looking for a button that is already pressed.
  expect(statusLabel(group("DRAFT"))).toBe("待批");
  expect(statusLabel(group("DRAFT", 1))).toBe("已批·等边界");
  expect(heldApproved(group("DRAFT", 1))).toBe(true);
  // Approval on any other state is not this case.
  expect(heldApproved(group("RUNNING", 1))).toBe(false);
  expect(statusLabel(group("RUNNING", 1))).toBe(STATUS_ZH.RUNNING);
});

test("a state the vocabulary does not have falls back rather than rendering nothing", () => {
  expect(statusLabel(group("SOMETHING_NEW"))).toBe("SOMETHING_NEW");
});
