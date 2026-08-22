import { afterEach, beforeEach, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { act, cleanup, fireEvent, render as mount, waitFor } from "../support/render.tsx";
import { inFlight, mockHttp } from "../support/http.ts";
import { WithQueries } from "./queries.tsx";
import { TipRoot } from "../../web/src/ui/tooltip.tsx";
import { SettingsDialog } from "../../web/src/features/settings/view.tsx";
import { defaultFor, settablePaths } from "../../src/platform/config/settings.ts";

/**
 * The shell around the panes, which is the part with rules in it.
 *
 * `Knobs` is covered by `knobs-render`; nothing imported the dialog that holds it, so
 * three decisions were unasserted: which pane opens, what happens when the hash asks
 * for one that needs a project there is none of, and whether choosing a pane is
 * reported back to the caller that owns the URL.
 */
const rows = () =>
  [...settablePaths()].map(([path, type]) => ({
    path,
    type,
    value: defaultFor(path),
    default: defaultFor(path),
    overridden: false,
  }));

mockHttp(
  http.get("*/api/v1/settings", () => HttpResponse.json({ settings: rows() })),
  http.get("*/api/v1/credentials", () => HttpResponse.json({ credentials: [] })),
  inFlight(),
);

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = class extends EventTarget {
    close() {}
  };
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "EventSource");
});

/**
 * Which pane is open, read off `aria-current` rather than off the text.
 *
 * The left rail lists every pane by name at all times, so `getByText("运行方式")` matches
 * whether or not that pane is showing — the first draft of two of these tests
 * asserted exactly that and passed against a component with the rule deleted.
 */
const current = (view: ReturnType<typeof mount>): string | undefined =>
  view
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-current") === "true")
    ?.textContent?.trim();

const open = (props: Partial<Parameters<typeof SettingsDialog>[0]> = {}) => {
  const picked: string[] = [];
  const view = mount(
    <WithQueries>
      <TipRoot>
        <SettingsDialog
          open
          onOpenChange={() => {}}
          initial="cred"
          projectId={1}
          onSection={(s) => picked.push(s)}
          {...props}
        />
      </TipRoot>
    </WithQueries>,
  );
  return { view, picked };
};

/**
 * The hash decides which pane opens, and it keeps deciding.
 *
 * A link to `#…&s=ops` that landed on `Model account` would make every settings link in
 * the product point at the same place.
 */
test("the dialog opens on the pane it was asked for", async () => {
  const { view } = open({ initial: "ops" });
  await waitFor(() => expect(current(view)).toBe("运行方式"));
});

/**
 * A pane that needs a project, with no project, falls back rather than drawing empty.
 *
 * `Gates`, `Sandbox` and `Remove project` are all about one repository. Opened with `projectId` null
 * they have nothing to render and nothing to say about it — an empty dialog reads as
 * a broken one, and the hash can ask for this at any time because it is a URL.
 */
test("a project-scoped pane with no project falls back to one that works", async () => {
  const { view } = open({ initial: "gates", projectId: null });
  await waitFor(() => expect(current(view)).toBe("模型账号"));

  // And with a project it opens where it was asked to, so the fallback is a
  // fallback rather than `Gates` being unreachable.
  cleanup();
  const withProject = open({ initial: "gates", projectId: 1 });
  await waitFor(() => expect(current(withProject.view)).toBe("闸门"));
});

/**
 * Choosing a pane is reported, because the URL is not this component's to hold.
 *
 * `app.tsx` owns the hash. A rail that changed panes without saying so would leave
 * the address bar naming the pane the reader arrived at rather than the one they are
 * reading, and a reload would take them back.
 */
test("picking a pane tells the caller that owns the URL", async () => {
  const { view, picked } = open();
  await waitFor(() => expect(current(view)).toBe("模型账号"));

  act(() => void fireEvent.click(view.getAllByRole("button", { name: "运行方式" })[0]!));
  await waitFor(() => expect(picked).toContain("ops"));
});
