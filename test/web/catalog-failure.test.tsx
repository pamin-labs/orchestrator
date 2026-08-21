import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "../support/render.tsx";
import { i18n, startLocale } from "../../web/src/i18n.ts";
import { Timeline } from "../../web/src/features/timeline/view.tsx";
import { emptyState } from "../../web/src/shared/api.ts";

/**
 * A catalog that will not load must not take the panel down with it.
 *
 * Each one is its own chunk and `startLocale()` is awaited before the first
 * paint, so a stale index or a half-deployed `web/dist` used to reject at the
 * entry point's top level and render nothing at all — a blank page because one
 * language file was missing.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  mock.restore();
  i18n.activate("zh");
});

test("a catalog that 404s leaves the panel readable in English", async () => {
  void mock.module("../../web/src/locales/ja.json", () => {
    throw new Error("404");
  });
  // Spied rather than left to print: the message is the point — a panel reading
  // in the wrong language has to be findable — and an unsilenced `console.error`
  // is a red line in every suite run that looks like a failure and is not.
  const said = spyOn(console, "error").mockImplementation(() => {});
  // Nothing activated yet is the first-paint case: the locale has to come from
  // somewhere, and English needs no catalog to be one of the answers. Loaded
  // empty first, or Lingui warns about activating a locale it has no messages
  // for — which is true, and is the state being set up.
  i18n.load("", {});
  i18n.activate("");
  localStorage.setItem("orch.locale", "ja");

  // Resolves rather than rejects: that is the whole property.
  expect(await startLocale()).toBeUndefined();
  expect(i18n.locale).toBe("en");

  const { getByRole } = render(<Timeline st={emptyState()} frames={[]} grpId={null} projectId={null} />);
  expect(getByRole("heading").textContent).toContain("Event stream");

  expect(said).toHaveBeenCalled();
  expect(String(said.mock.calls[0]?.[0])).toContain("the ja catalog did not load");
});
