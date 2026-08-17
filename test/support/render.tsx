import { nativeFetch } from "./dom.ts";

/**
 * testing-library, over the document `dom.ts` installed at preload.
 *
 * These tests used to call `renderToStaticMarkup` and match substrings of the
 * result, which made a class name (`breathe`) as much of an assertion as a
 * label, and rendered every Radix dialog, popover, menu and tooltip as nothing
 * at all — a portal has no server output, so those surfaces were untested
 * rather than passing. A real document renders the portals and lets a query ask
 * the questions a reader would: what is this control called, is it pressed, is
 * it disabled.
 *
 * Registration is not here. It is `test/support/dom.ts`, a `bunfig.toml` preload
 * entry, because the document has to exist before any module that reaches
 * `web/src` is *evaluated* and an import cannot promise that.
 *
 * Assertions must never hold a DOM node. `expect(queryByRole(…)).toBeNull()`
 * reads well and prints a serialised browser — window, document, every handler
 * getter — the moment it fails; five such failures once produced a
 * 267,533-line log and turned a thirty-second directory into a two-minute one.
 * Assert a count, an accessible name, or a property: `queryAllByRole(…)` with
 * `toHaveLength(0)`, `input.disabled`, `element.textContent`.
 */
export { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * The network these panes see while a test looks at them.
 *
 * A real document runs effects, and half of these panes fetch on mount — which
 * is new: `renderToStaticMarkup` ran no effect, so every pane was frozen in its
 * first-paint state whether the test wanted that state or not. A path with no
 * entry here is answered by a request that never comes back, which *is* the
 * first-paint state, and is now something a test opts into rather than the only
 * thing it can have.
 */
export function stubFetch(routes: Record<string, unknown> = {}): void {
  const answer = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const reply = Object.entries(routes).find(([path]) => url.includes(path));
    if (!reply) return new Promise<Response>(() => {});
    return Promise.resolve(new Response(JSON.stringify(reply[1]), { headers: { "content-type": "application/json" } }));
  };
  globalThis.fetch = Object.assign(answer, { preconnect: nativeFetch.preconnect });
}

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
