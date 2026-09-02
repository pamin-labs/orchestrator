import { afterEach, beforeEach, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { act, cleanup, render as mount, waitFor } from "../support/render.tsx";
import { inFlight, mockHttp } from "../support/http.ts";
import { WithQueries } from "./queries.tsx";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { App } from "../../web/src/app/app.tsx";
import { emptyState } from "../../web/src/shared/api.ts";

/**
 * The back button, and the shortcuts, against the real component.
 *
 * Neither could be tested until `window` events fired at all: `dom.ts` handed the
 * process Bun's dispatcher under happy-dom's `Event`, so a dispatched `popstate`
 * reached nobody and a test asserting on it passed by asserting nothing happened.
 */
/**
 * That is also why `app.tsx` sits in `fallow health --coverage-gaps`: its routing is
 * four `window` listeners, and a listener nothing can reach is a listener nothing
 * can cover.
 */
const STATE = {
  ...emptyState(),
  projects: [
    { id: 1, name: "one", repo_path: "/tmp/one", remote: null, base_branch: "main" },
    { id: 2, name: "two", repo_path: "/tmp/two", remote: null, base_branch: "main" },
  ],
};

/**
 * The stream, opened and never spoken on.
 *
 * `useOrch` opens an `EventSource` on mount and happy-dom has none. A real one would
 * be a second source of state changes in a test about the first.
 */
class QuietSource extends EventTarget {
  close() {}
}

// The catch-all goes last: MSW takes the first handler that matches, so `inFlight()`
// in front of these would swallow both and the panel would render its empty state.
// Every project-config read this file makes, so a request for one that is not in
// `STATE` can be counted. It answers 404 the way the server does — the catch-all
// `inFlight()` leaves an unhandled request pending forever, which would have made
// the guard below pass against a panel that still asked.
const configAsked: string[] = [];

mockHttp(
  http.get("*/api/v1/state", () => HttpResponse.json(STATE)),
  http.get("*/api/v1/cost", () => HttpResponse.json({ rows: [] })),
  http.get("*/api/v1/project/:id/config", ({ params }) => {
    const id = String(params.id);
    configAsked.push(id);
    if (id !== "1" && id !== "2") return HttpResponse.json({ error: "no such project" }, { status: 404 });
    return HttpResponse.json({ repoPath: "/tmp/one", config: {}, resources: [], baseBranch: "main" });
  }),
  inFlight(),
);

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = QuietSource;
});

afterEach(() => {
  cleanup();
  configAsked.length = 0;
  location.hash = "";
  Reflect.deleteProperty(globalThis, "EventSource");
});

const panel = () =>
  mount(
    <WithQueries>
      <TipRoot>
        <App />
      </TipRoot>
    </WithQueries>,
  );

/**
 * Going back re-reads the hash, rather than leaving the page where it was.
 *
 * The URL is the panel's whole navigation state, and the browser changes it without
 * telling React. A `popstate` nothing listens to is a back button that moves the
 * address bar and nothing else — which reads as the panel having frozen.
 */
test("the back button puts the panel back where the hash says", async () => {
  location.hash = "#p=1&v=cost";
  const view = panel();
  await waitFor(() => expect(view.container.textContent).toBeTruthy());

  // What the browser does on Back: the hash changes, then the event fires.
  location.hash = "#p=2&v=owns";
  act(() => void window.dispatchEvent(new Event("popstate")));

  await waitFor(() => expect(location.hash).toBe("#p=2&v=owns"));
  expect(view.container.textContent).toContain("two");
});

/**
 * `hashchange` is the other half and not the same event.
 *
 * A hash typed into the address bar, or a link to `#p=2`, fires `hashchange` and not
 * `popstate`. They are registered together in `app.tsx` for that reason, and a test
 * that only drove one would leave the other free to be deleted.
 */
test("editing the hash directly moves the panel too", async () => {
  location.hash = "#p=1&v=cost";
  const view = panel();
  await waitFor(() => expect(view.container.textContent).toBeTruthy());

  location.hash = "#p=2&v=cost";
  act(() => void window.dispatchEvent(new Event("hashchange")));

  await waitFor(() => expect(view.container.textContent).toContain("two"));
});

/**
 * ⌘S opens settings, against the component rather than against the rule.
 *
 * `navigationShortcut` is a pure function and has its own tests; what those cannot
 * see is whether anything listens to it. The listener is a `window` keydown, which is
 * the class that could not be reached at all before `dom.ts` was fixed — so a
 * shortcut that stopped being wired would have looked exactly like one that worked.
 */
test("a shortcut reaches the panel, not just the rule that decodes it", async () => {
  location.hash = "#p=1&v=cost";
  const view = panel();
  await waitFor(() => expect(view.container.textContent).toContain("one"));

  act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true })));
  await waitFor(() => expect(location.hash).toContain("v=settings"));
});

/**
 * A chord the rule refuses changes nothing, and must not be swallowed either.
 *
 * The handler calls `preventDefault` before acting, so a listener that acted on
 * everything would eat the browser's own ⌘R and ⌘F on this page.
 */
test("a chord that is not a shortcut is left to the browser", async () => {
  location.hash = "#p=1&v=cost";
  const view = panel();
  await waitFor(() => expect(view.container.textContent).toContain("one"));

  const event = new KeyboardEvent("keydown", { key: "r", metaKey: true, cancelable: true });
  act(() => void window.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(location.hash).toBe("#p=1&v=cost");
});

/**
 * The side panel stays where the boss put it, across a reload.
 *
 * `readSide` is pure and tested; the write is an effect in `app.tsx` and was not.
 * Only one of the two halves failing is enough — a panel that reads the preference
 * and never writes it comes up right once and then reverts on every reload, which
 * reads as the toggle not working rather than as the write being absent.
 *
 * ⌘B is the toggle, which is also the third of the four shortcuts reaching real code.
 */
test("toggling the side panel is remembered", async () => {
  localStorage.setItem("orch.side", "1");
  location.hash = "#p=1&v=cost";
  const view = panel();
  await waitFor(() => expect(view.container.textContent).toContain("one"));

  act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true })));
  await waitFor(() => expect(localStorage.getItem("orch.side")).toBe("0"));

  act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true })));
  await waitFor(() => expect(localStorage.getItem("orch.side")).toBe("1"));
});

/**
 * A hash naming a project that is gone, which is what a new server on the same
 * address looks like to a browser still holding the old link.
 *
 * The shell already looked the project up — `home` is computed from it — but
 * `SettingsDialog` took `sel.p` raw, so the dialog asked for a config that is
 * not there.
 */
/**
 * `readApi` records a 404 as a *successful* read of `null`, so TanStack had no
 * error to de-duplicate: a fresh English toast on mount, on every window focus,
 * and on every credential save, over a dialog whose project panes sat at
 * `Loading…` for good. Which is the state the boss was in while trying to sign
 * Claude and Codex in.
 */
test("a project the snapshot does not have is dropped instead of asked about", async () => {
  location.hash = "#p=99&v=settings";
  const view = panel();
  await waitFor(() => expect(view.container.textContent).toBeTruthy());

  // The hash repairs itself rather than keeping a dead id and an empty crumb.
  await waitFor(() => expect(location.hash).not.toContain("p=99"));
  expect(configAsked).not.toContain("99");
});

/**
 * The other half, and the reason `loaded` exists: a deep link is legitimate
 * before the snapshot arrives. Repairing on an empty list alone would discard the
 * project on every cold load — the trap `repairMissingGroup` already documents,
 * except that for projects an empty list is also a real state.
 */
test("a deep link survives the render before the snapshot lands", async () => {
  location.hash = "#p=2&v=cost";
  const view = panel();
  await waitFor(() => expect(view.container.textContent).toContain("two"));
  expect(location.hash).toContain("p=2");
});
