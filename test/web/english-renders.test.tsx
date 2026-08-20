import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "../support/render.tsx";
import { i18n } from "../../web/src/i18n.ts";
import { Timeline } from "../../web/src/features/timeline/view.tsx";
import { emptyState } from "../../web/src/shared/api.ts";

/**
 * The source language, rendered.
 *
 * Every other web test runs under the Chinese catalog, which is what makes those
 * 544 assertions a check on the catalog. It also means English — the language
 * the code is written in — is never rendered in CI at all: a malformed `<Trans>`,
 * a placeholder that lost its name, a `` t`` `` that landed in the wrong slot,
 * all invisible.
 */

afterEach(() => {
  cleanup();
  i18n.activate("zh");
});

test("a pane renders its source language when English is active", () => {
  i18n.activate("en");
  const { getByRole, getByText } = render(<Timeline st={emptyState()} frames={[]} grpId={null} projectId={null} />);
  // The heading is a `<Trans>`; the empty state is a second one, so a broken
  // macro in either shows up as a missing name rather than as Chinese.
  expect(getByRole("heading").textContent).toContain("Event stream");
  expect(getByText("No events").tagName).toBe("DIV");
});

/**
 * Falling back is the behaviour that keeps a half-translated catalog usable: a
 * message with no translation renders its English source rather than its id or
 * an empty box. Asserted here because it is what the README's percentage means.
 */
test("an untranslated message falls back to the English the macro hashed", () => {
  // A third locale with nothing in it, which is what the day someone adds one
  // looks like — `load` merges rather than replaces, so emptying `zh` would not
  // have tested this.
  i18n.load("ja", {});
  i18n.activate("ja");
  const { getByRole } = render(<Timeline st={emptyState()} frames={[]} grpId={null} projectId={null} />);
  expect(getByRole("heading").textContent).toContain("Event stream");
});
