import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { mockHttp, server } from "../support/http.ts";
import { cleanup, render, waitFor } from "../support/render.tsx";
import { ProjectPane } from "../../web/src/features/settings/project.tsx";
import type { ProjectConfig } from "../../web/src/features/project/view.tsx";
import { AskHost } from "../../web/src/ui/confirm.tsx";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";

/**
 * Removing a project is the one irreversible thing in the panel, and the one
 * whose result nobody sees: the dialog closes, the panel goes home, and the row
 * is *absent*. Absence is not a confirmation, least of all after a confirm that
 * listed the containers, cards, records and attachments going with it.
 */
/**
 * Every other mutation in this dialog shows its effect where the boss is already
 * looking, which is why they carry no toast and this one does. The assertion is
 * on `toast.success` and not on a rendered surface because `onRemoved` unmounts
 * this component before the notification could be read from it.
 */

// Whole, not narrowed with an assertion: the pane takes the shape the endpoint
// returns, and a fixture that lies about it is the kind that keeps passing after
// the shape moves.
const config: ProjectConfig = {
  repoPath: "/srv/acme",
  config: {},
  resources: [],
  baseBranch: null,
  baseBranchNow: "main",
  basePinned: false,
  branches: [],
};

// At module scope: `mockHttp` registers a `beforeAll`, and arming interception
// per file is what keeps `onUnhandledRequest: "error"` absolute here without
// reaching `test/integration`, which talks to a real server.
mockHttp();

afterEach(() => {
  cleanup();
  mock.restore();
});

// `AskHost` alongside, because `ask()` resolves through a module-level handle
// that only exists while the host is mounted — without it the confirm never
// opens and the removal never runs.
const pane = (onRemoved: () => void) => (
  <TipRoot>
    <AskHost />
    <ProjectPane
      section="remove"
      data={config}
      busy={false}
      projectId={7}
      groupCount={2}
      patch={() => {}}
      onRemoved={onRemoved}
    />
  </TipRoot>
);

/**
 * Driven the way the boss drives it — press the danger button, then confirm in
 * the dialog it opens. Stubbing `ask` would leave the thing this page exists for
 * untested: that removal is behind a confirm at all.
 */
async function removeAndConfirm(view: { queryAllByRole: (role: string) => HTMLElement[] }) {
  const buttons = () => view.queryAllByRole("button");
  const before = buttons().length;
  buttons().at(-1)?.click();
  // A count, never the node: a `waitFor` on an element prints the whole document
  // when it gives up, which turns one line into a screenful.
  await waitFor(() => expect(buttons().length > before).toBe(true));
  // Cancel is drawn first and the affirmative last, so the dialog's own yes is
  // the last control in the tree.
  buttons().at(-1)?.click();
}

test("a removed project says so, because the row simply going is not a receipt", async () => {
  const said = spyOn(toast, "success").mockImplementation(() => "");
  server.use(http.delete("*/api/v1/projects/7", () => HttpResponse.json({ ok: true })));
  const onRemoved = mock(() => {});
  const view = render(pane(onRemoved));
  await removeAndConfirm(view);
  await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(said).toHaveBeenCalledTimes(1));
});

/**
 * The half that matters more: a refusal must not read as a receipt. `mutate`
 * already puts the server's reason in an error toast, so a success beside it
 * would be the panel contradicting itself in the same corner.
 */
test("a refused removal neither navigates nor claims to have worked", async () => {
  const said = spyOn(toast, "success").mockImplementation(() => "");
  server.use(http.delete("*/api/v1/projects/7", () => HttpResponse.json({ error: "in use" }, { status: 409 })));
  const onRemoved = mock(() => {});
  const view = render(pane(onRemoved));
  await removeAndConfirm(view);
  await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(0));
  expect(said).toHaveBeenCalledTimes(0);
});
