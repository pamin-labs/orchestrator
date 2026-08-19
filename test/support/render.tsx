import { nativeFetch } from "./dom.ts";
// Side-effecting: initializes the same i18next instance production uses, so a
// component calling `t()` renders real copy rather than the raw key — without
// this, every accessible-name assertion against translated text was failing
// silent-wrong: not an error, just a query that could never match anything.
import "../../web/src/i18n/index.ts";

/**
 * testing-library, over the document `dom.ts` installs at preload.
 *
 * These tests used to call `renderToStaticMarkup` and match substrings, which made
 * a class name as much of an assertion as a label and rendered every Radix
 * dialog, popover, menu and tooltip as nothing at all — a portal has no server
 * output, so those surfaces were untested rather than passing.
 */
/**
 * **Assertions must never hold a DOM node.** `expect(queryByRole(…)).toBeNull()`
 * reads well and prints a serialised browser the moment it fails; five such
 * failures once produced a 267,533-line log and turned a thirty-second directory
 * into a two-minute one. Assert a count, an accessible name, or a property.
 */
export { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

/**
 * The network these panes see while a test looks at them: `test/support/http.ts`.
 *
 * A real document runs effects and half these panes fetch on mount — new
 * behaviour, since `renderToStaticMarkup` ran none and froze every pane in its
 * first-paint state. MSW answers those reads, armed per file with `mockHttp()`:
 * a replaced `globalThis.fetch` fakes the wrong layer and cannot be reconciled
 * with `onUnhandledRequest: "error"`, and a suite with two mocking vocabularies
 * has the gate over neither.
 */
/**
 * `restoreFetch` below is not that vocabulary coming back. The three files that
 * still hold `globalThis.fetch` — `read-races`, `evidence-race`,
 * `pending-transitions` — release a reply from inside the test to order it against
 * a render, which is a promise the test owns rather than a route.
 */

/** Hands the process back Bun's own `fetch`; `bun test` shares one for every file. */
export function restoreFetch(): void {
  globalThis.fetch = nativeFetch;
}

/**
 * What a form control currently holds, and whether it is refusing input.
 *
 * `getByLabelText` answers with an `HTMLElement` — which is the right answer,
 * because a label can point at anything — so reading `.value` off one needs
 * either a cast the linter refuses or this, which asks the element instead of
 * telling it. Neither takes the node into an `expect`: a failed assertion on a
 * DOM node prints a serialised browser.
 */
export const valueOf = (el: HTMLElement): string =>
  "value" in el && typeof el.value === "string" ? el.value : `<${el.tagName.toLowerCase()} holds no value>`;

export const isDisabled = (el: HTMLElement): boolean => "disabled" in el && el.disabled === true;
