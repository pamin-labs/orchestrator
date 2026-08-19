import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { cleanup, render as mount, valueOf, waitFor } from "../support/render.tsx";
import { mockHttp } from "../support/http.ts";
import { WithQueries } from "./queries.tsx";
import { Knobs } from "../../web/src/features/knobs/view.tsx";
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
  expect(view.getAllByText("远程 endpoint")).toHaveLength(1);
  expect(view.getAllByText("远程凭据名")).toHaveLength(1);
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
