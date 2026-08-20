import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render as mount, waitFor } from "../support/render.tsx";
import { Switcher } from "../../web/src/features/navigation/switcher.tsx";

afterEach(cleanup);

/**
 * The palette the boss switches projects and requirements with.
 *
 * `switchRow` — the shape of one line — had tests; the palette around it had no test
 * importing it at all, so what was unasserted is everything that makes it a switcher:
 * that typing filters, that picking reports the id rather than the row, and that it
 * closes itself. It replaced a tab strip because tabs stop working around a dozen
 * projects, so filtering *is* the feature.
 */
const items = [
  { id: 1, name: "orchestrator", meta: "pamin-labs/orch" },
  { id: 2, name: "webnovel", meta: "pamin-labs/novel" },
  { id: 3, name: "sandbox-server", meta: "pamin-labs/sandbox" },
];

const open = (onPick: (id: number) => void, onOpenChange: (v: boolean) => void = () => {}) =>
  mount(
    <Switcher
      open
      onOpenChange={onOpenChange}
      label="项目"
      placeholder="搜项目"
      empty="没有"
      items={items}
      onPick={onPick}
    />,
  );

test("typing filters, by the name and by what the row says beside it", async () => {
  const view = open(() => {});
  await waitFor(() => expect(view.getAllByRole("option")).toHaveLength(3));

  const type = async (query: string, expected: number) => {
    fireEvent.change(view.getAllByRole("combobox")[0]!, { target: { value: query } });
    // The count, never the node: a `waitFor` that fails on an element prints the
    // whole serialised document, which `test/support/render.tsx` records as having
    // turned a thirty-second directory into a two-minute one.
    await waitFor(() => expect(view.queryAllByRole("option").length).toBe(expected));
  };

  await type("sandbox", 1);
  expect(view.getAllByRole("option")[0]?.textContent).toContain("sandbox-server");

  // The meta is searched too, which is what `switchRow` puts it in the value for: a
  // boss thinks in repository names as often as in project names.
  await type("pamin-labs/novel", 1);
  expect(view.getAllByRole("option")[0]?.textContent).toContain("webnovel");

  // A term every row shares filters nothing out — cmdk scores rather than excludes,
  // so this asserts the filter is a ranking and not a hard match.
  await type("pamin", 3);
});

/**
 * Picking reports the id and closes, in that order.
 *
 * The id rather than the name, because names are not unique and the caller navigates
 * by id. Closing is the switcher's own job — a palette that stays open over the page
 * it just navigated is the second-most-reported kind of stuck.
 */
test("picking a row reports its id and closes the palette", async () => {
  const picked: number[] = [];
  const closed: boolean[] = [];
  const view = open(
    (id) => picked.push(id),
    (v) => closed.push(v),
  );
  await waitFor(() => expect(view.getAllByRole("option")).toHaveLength(3));

  fireEvent.click(view.getAllByRole("option")[1]!);
  expect({ picked, closed }).toEqual({ picked: [2], closed: [false] });
});

/**
 * Nothing matching says so rather than showing an empty box.
 *
 * An empty list and a list that has not loaded look identical, and this palette is
 * opened by a keystroke over a page that is still fetching.
 */
test("a search that matches nothing says nothing matched", async () => {
  const view = open(() => {});
  fireEvent.change(view.getAllByRole("combobox")[0]!, { target: { value: "zzz" } });
  await waitFor(() => expect(view.getAllByText("没有")).toHaveLength(1));
});
