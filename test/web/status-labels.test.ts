import { expect, test } from "bun:test";
import { GRP_STATES } from "../../src/contracts/states.ts";
import { heldApproved, STATUS_LABEL, statusLabel } from "../../web/src/shared/select.ts";
import { i18n } from "../../web/src/i18n.ts";

/**
 * Every state the vocabulary can hold has a word the boss reads.
 *
 * `STATUS_LABEL` is `Record<GrpState, …>`, so a missing row is a compile error
 * and there is no test here for it. What a type cannot say is that the row holds
 * a *word*: `PR_OPEN: msg`PR_OPEN`` type-checks and shows the boss the enum.
 */

type Group = Parameters<typeof statusLabel>[0];

/** A whole group, because narrowing one with a cast is the assertion Oxlint bans. */
const group = (status: Group["status"], approvedAt: number | null = null): Group => ({
  id: 1,
  project_id: 1,
  name: "g",
  branch: null,
  status,
  owns_json: [],
  budget_tokens: null,
  spent_tokens: 0,
  pr_number: null,
  approved_at: approvedAt,
});

test("no group state is labelled with its own enum name", () => {
  // Resolved, not compared as descriptors: the table holds `msg`, and what the
  // boss reads is what it resolves to under the active catalog.
  expect(GRP_STATES.filter((s) => i18n._(STATUS_LABEL[s]) === s)).toEqual([]);
});

test("an approved draft says so, because 待批 would be a lie once it is approved", () => {
  // The one state whose label depends on more than the state: a DRAFT the boss
  // has approved is waiting on the boundary, not on the boss, and saying 待批
  // sends them looking for a button that is already pressed.
  expect(statusLabel(group("DRAFT"))).toBe("待批");
  expect(statusLabel(group("DRAFT", 1))).toBe("已批·等边界");
  const held = { DRAFT: heldApproved(group("DRAFT", 1)), RUNNING: heldApproved(group("RUNNING", 1)) };
  // Approval on any other state is not this case. Compared against the same
  // state unapproved rather than against the label's text, so this keeps saying
  // "approval changes nothing here" after somebody rewords 在跑.
  expect(held).toEqual({ DRAFT: true, RUNNING: false });
  expect(statusLabel(group("RUNNING", 1))).toBe(statusLabel(group("RUNNING")));
});
