import { expect, test } from "bun:test";
import { createSelectSchema } from "drizzle-orm/zod";
import { Group, Slice, Task } from "../../src/contracts/panel.ts";
import { grp, slice, task } from "../../src/platform/persistence/schema.ts";

/**
 * The panel's shapes are written by hand and have to keep matching their tables.
 *
 * Derived instead, `web/src/shared/api.ts` imports them and Drizzle lands in the
 * browser: measured at +57KB on a 1.70MB bundle, for types the browser never
 * reads. So the check lives here, which nothing ships. It exists because they
 * did drift — `owns_json` was declared a string long after the column became
 * `jsonb`, and the only thing checking was a copy of the wrong answer.
 */
const sample = {
  grp: {
    id: 1,
    project_id: 1,
    name: "g",
    branch: null,
    status: "RUNNING",
    owns_json: ["src/a.ts"],
    budget_tokens: null,
    spent_tokens: 0,
    pr_number: null,
    approved_at: null,
  },
  slice: {
    id: 1,
    grp_id: 1,
    seq: 1,
    title: "t",
    accept_spec: "a",
    difficulty: "normal",
    status: "pending",
    gates_json: {},
    spent_tokens: 0,
    awaiting_at: null,
  },
  task: { id: 1, grp_id: 1, slice_id: null, title: "t", status: "pending" },
} as const;

test.each([
  ["grp", Group, grp, sample.grp],
  ["slice", Slice, slice, sample.slice],
  ["task", Task, task, sample.task],
])("the panel's %s shape is one its table can produce", (_name, wire, table, row) => {
  // `pick` wants a literal key map; these keys are read from the wire schema's
  // own shape one line up, so the mask is exactly its own keys.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built from `wire.shape`, which is the very object being picked from
  const mask = Object.fromEntries(Object.keys(wire.shape).map((k) => [k, true])) as never;
  const fromTable = createSelectSchema(table).pick(mask);
  // Both directions: a row the table allows must satisfy the wire shape, and a
  // row the wire shape allows must satisfy the table. One direction alone lets a
  // wire field go wider than its column and never says so.
  expect({ wire: wire.safeParse(row).success, table: fromTable.safeParse(row).success }).toEqual({
    wire: true,
    table: true,
  });
  expect(Object.keys(fromTable.shape).sort()).toEqual(Object.keys(wire.shape).sort());
});
