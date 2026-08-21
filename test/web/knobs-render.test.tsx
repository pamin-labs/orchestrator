import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { cleanup, fireEvent, render as mount, valueOf, waitFor } from "../support/render.tsx";
import { mockHttp, server } from "../support/http.ts";
import { WithQueries } from "./queries.tsx";
import { KNOB_SECTIONS, Knobs, SECTIONS } from "../../web/src/features/knobs/view.tsx";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { ConfigSchema } from "../../src/contracts/config.ts";
import { defaultFor, settablePaths } from "../../src/platform/config/settings.ts";

afterEach(cleanup);

/**
 * The settings page draws, from the paths the server actually offers.
 *
 * Nothing rendered `Knobs` before this, so the switch that picks an editor per path
 * was at 0% while carrying the blast radius of the whole dialog. It is a `switch`
 * with `default: null`, which fails by drawing *nothing*.
 *
 * The rows come from `settablePaths()` rather than a fixture, so a schema change
 * arrives as a real row instead of a fixture nobody updated.
 */
// `TipRoot` as well as the query client, because every knob label carries a Tip
// and Radix's tooltip refuses to render outside its provider. `app.tsx` mounts
// both; a test that mounts one gets a stack trace about context instead of a
// page.
const render = (node: ReactNode) =>
  mount(
    <WithQueries>
      <TipRoot>{node}</TipRoot>
    </WithQueries>,
  );

const rows = () =>
  [...settablePaths()].map(([path, type]) => ({
    path,
    type,
    value: defaultFor(path),
    default: defaultFor(path),
    overridden: false,
  }));

mockHttp(http.get("*/api/v1/settings", () => HttpResponse.json({ settings: rows() })));

test("the models section draws every path it lists, embedding among them", async () => {
  const view = render(<Knobs section="models" />);
  await waitFor(() => expect(view.getAllByText("索引模型")).toHaveLength(1));

  expect(view.getAllByText("向量检索")).toHaveLength(1);
  expect(view.getAllByText("走索引树")).toHaveLength(1);
  // The endpoint and the credential are not rows any more: they are fields of
  // the 向量检索 row, drawn only under remote. Two empty boxes under a segment
  // reading 本地 are a form for a mode nobody chose.
  expect(view.queryAllByLabelText("Endpoint")).toHaveLength(0);
  expect(view.queryAllByLabelText("凭据名")).toHaveLength(0);
});

test("the embedding row is one row: the mode and the model together", async () => {
  const view = render(<Knobs section="models" />);
  await waitFor(() => expect(view.getAllByText("向量检索")).toHaveLength(1));

  // The default is local, so the segmented control offers both and the model box
  // carries the default model — the pairing is what puts them on one line.
  expect(view.getAllByRole("radio", { name: "本地" })).toHaveLength(1);
  expect(view.getAllByRole("radio", { name: "远程" })).toHaveLength(1);
  // The model is an input's value, not text — `textContent` would pass on an
  // empty box, which is exactly the failure the pairing exists to prevent.
  const model = ConfigSchema.shape.embedding.shape.model.parse(defaultFor("embedding.model"));
  expect(view.getAllByRole("combobox").map((c) => valueOf(c))).toContain(model);
});

/**
 * The two things the boss reported, as renders rather than as tables.
 *
 * One was a row labelled `intervals.notifyBackoffMs` with a JSON box under it;
 * the other was the embedding model drawn twice, once by the picker built for it
 * and once by the generic row underneath. Both are invisible to the type checker
 * and to every other test here, because both render perfectly well.
 */
test("no row is labelled by its config path, in any section", async () => {
  for (const name of KNOB_SECTIONS) {
    const view = render(<Knobs section={name} />);
    await waitFor(() => expect(view.container.querySelectorAll("[data-slot=field]").length).toBeGreaterThan(0));
    // The paths themselves, not a shape: a model id like `gpt-5.6-luna` looks
    // dotted too, and it is a value rather than a label.
    const paths = SECTIONS[name].groups.flatMap((g) => g.paths);
    expect(paths.filter((path) => view.queryAllByText(path).length)).toEqual([]);
    cleanup();
  }
});

test("the embedding model has one control on the page, not two", async () => {
  const view = render(<Knobs section="models" />);
  await waitFor(() => expect(view.getAllByText("向量检索")).toHaveLength(1));
  const model = ConfigSchema.shape.embedding.shape.model.parse(defaultFor("embedding.model"));
  // By value, because the second control was a plain text box holding the same
  // string — two editors for one setting, and whichever one the reader found
  // last is the one they believed.
  expect([...view.container.querySelectorAll("input")].filter((box) => box.value === model)).toHaveLength(1);
});

test("the reminder ladder is a row per step, not a line of JSON", async () => {
  const view = render(<Knobs section="notify" />);
  await waitFor(() => expect(view.getAllByText("提醒阶梯")).toHaveLength(1));
  const steps = ConfigSchema.shape.intervals.shape.notifyBackoffMs.parse(defaultFor("intervals.notifyBackoffMs"));
  expect(view.getAllByText(/^第 \d+ 级$/)).toHaveLength(steps.length);
  expect([...view.container.querySelectorAll("input")].map((box) => box.value)).not.toContain(JSON.stringify(steps));
});

/**
 * A refused write is shown where the value is, not assumed to have landed.
 *
 * `putSetting` applies a value to the whole config before storing it and returns
 * the reason when it cannot — the order that stopped `embedding.mode = "remote"`
 * with no endpoint from surviving in the database and killing every boot after
 * it. The panel's half is this: a 422 carries a sentence and the row that caused
 * it prints the sentence, rather than a toast that is gone by the time anybody
 * reads the pane.
 */
/**
 * On a plain row, because the embedding row no longer produces this case at all
 * — it knows the rule and does not send a write that would bounce. Every other
 * knob still can, and this is the path they land on.
 */
test("a refused write prints the server's reason on the row it came from", async () => {
  const why = "maxGroups: too many";
  server.use(http.post("*/api/v1/settings", () => HttpResponse.json({ error: why }, { status: 422 })));
  const view = render(<Knobs section="ops" />);
  await waitFor(() => expect(view.getAllByText("同时开工的需求数")).toHaveLength(1));

  const box = view.getByLabelText("同时开工的需求数");
  fireEvent.change(box, { target: { value: "40" } });
  fireEvent.blur(box);
  await waitFor(() => expect(view.getAllByText(why)).toHaveLength(1));
});
