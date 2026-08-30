import { afterEach, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render as mount, waitFor } from "../support/render.tsx";
import { mockHttp } from "../support/http.ts";
import type { Evidence } from "../../web/src/shared/api.ts";
import { EvidencePanel } from "../../web/src/features/evidence/view.tsx";

/**
 * The longest list in the panel, drawn from a window.
 *
 * `src/api/orch/review.ts` caps a gate log at 4000 lines and a `bun test` run
 * reaches it. Nothing rendered one in a test before, so windowing it was a
 * change to the panel's biggest list with no cover over the thing that matters:
 * that the lines are still there, and that the filter still finds them.
 */

const LINES = 4000;
const log = Array.from({ length: LINES }, (_, i) => (i === 2500 ? "(fail) the needle" : `line ${i}`)).join("\n");

const evidence = (): Evidence => ({
  grp_id: 1,
  seq: 1,
  title: "Ship archives",
  accept_spec: "archives are verifiable",
  base_sha: "abc",
  retries: 0,
  stat: "1 file changed",
  diff: "diff --git a/a b/a",
  truncated: false,
  scope: "slice",
  verdicts: [],
  gates: [{ name: "test", path: "gate.log", size: log.length }],
});

// The seeded cache answers the first paint, but the panel still revalidates —
// and `onUnhandledRequest: "error"` means an unanswered read is noise in the log.
mockHttp(
  http.get("*/api/v1/slices/:id/gate/:name", () => HttpResponse.json({ text: log })),
  http.get("*/api/v1/slices/:id/evidence", () => HttpResponse.json(evidence())),
);

afterEach(cleanup);

/** The panel opens on `diff`; the gate is a tab beside it, named after the gate. */
const render = () => {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(["evidence", 1], evidence());
  const view = mount(
    <QueryClientProvider client={queries}>
      <EvidencePanel sliceId={1} />
    </QueryClientProvider>,
  );
  fireEvent.click(view.getByText("test", { selector: "button, button *" }));
  return view;
};

/** A count, never a node: a failed assertion holding an element prints a browser. */
const rows = (view: { container: HTMLElement }) => view.container.querySelectorAll("[data-index]").length;

test("a four-thousand-line gate log draws a window, not four thousand rows", async () => {
  const view = render();
  await waitFor(() => expect(rows(view)).toBeGreaterThan(0));

  expect(rows(view)).toBeLessThan(LINES / 4);
  expect(view.queryAllByText("line 0", { exact: false }).length).toBeGreaterThan(0);
});

test("the toolbar counts every line, not the drawn ones", async () => {
  const view = render();
  await waitFor(() => expect(rows(view)).toBeGreaterThan(0));

  expect(view.queryAllByText(String(LINES), { exact: false }).length).toBeGreaterThan(0);
});
