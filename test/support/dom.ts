import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * A document, installed before any test module is evaluated.
 *
 * This is a preload entry rather than an import, because the ordering is not
 * advisory. Radix decides once, when its module is evaluated, whether
 * `useLayoutEffect` is React's or a no-op — it reads `globalThis?.document` at
 * load time — so a file that pulls in a Radix primitive before a document exists
 * leaves every portal, dialog and popover in the process permanently unmounted,
 * and the failure reads as "the dialog never arrived" rather than as an import
 * order. Imports are hoisted, so "import this first" is a rule nothing enforces;
 * a preload entry is a property. `bunfig.toml` explains the same thing about
 * `coverage.ts`, one line above.
 *
 * Bun's documented setup for happy-dom is exactly this file plus that preload
 * line: https://bun.com/docs/test/dom
 */

/**
 * Bun's own network stack, taken before the DOM replaces it.
 *
 * `GlobalRegistrator.register()` installs happy-dom's `fetch` and friends over
 * Bun's. That is right for a browser simulation and wrong for this process,
 * where `test/integration` starts a real `Bun.serve` and talks to it over a real
 * socket — through happy-dom those requests fail with
 * `Failed to execute "fetch()" on "Window" … Parse Error`.
 *
 * Capturing has to happen before `register`, which is the bug this replaces: the
 * previous version read `globalThis.fetch` after registration, so the value it
 * saved to "restore" was happy-dom's own.
 */
/** Bun's `fetch`, for a test that has replaced it and wants it back. */
export const nativeFetch = globalThis.fetch;

const native = new Map(
  Object.getOwnPropertyNames(globalThis).map((name) => [name, Reflect.get(globalThis, name) as unknown]),
);

GlobalRegistrator.register({ url: "http://localhost/" });

/**
 * What the DOM is allowed to keep: the names it invented.
 *
 * Registration adds 487 globals and *replaces* 35 that Bun already had —
 * `setTimeout`, `AbortController`, `Event`, `URL`, `Blob`, `TransformStream`,
 * `fetch` among them. The 487 are the point; the 35 are collateral, and they
 * are the primitives the server-side suites run on. Restoring every name that
 * existed before registration keeps the substitution to exactly the DOM.
 *
 * The event classes stay happy-dom's, because dispatch is an identity check:
 * `EventTarget.dispatchEvent` throws unless the argument `instanceof` its own
 * `Event`, and Radix builds a `CustomEvent` from the global. Hand back Bun's and
 * every dismissable layer in the panel fails on mount.
 */
const DOM_OWNS = (name: string) => name === "EventTarget" || name.endsWith("Event") || name === "DOMException";
for (const [name, value] of native) {
  if (DOM_OWNS(name) || Reflect.get(globalThis, name) === value) continue;
  Reflect.set(globalThis, name, value);
}

/**
 * Unmount between tests, once, for every file.
 *
 * testing-library registers its own `afterEach(cleanup)` when its module is
 * evaluated, and `bun test` scopes lifecycle hooks to the file that registered
 * them — so that hook belongs to whichever test file imported it first, and
 * every later file inherits the previous one's nodes in `document.body`. The
 * symptom is "Found multiple elements", and the second symptom is that failures
 * print an ever-larger document.
 *
 * Registering it here, from the preload, is the same reason the document itself
 * is here: a preload's hooks apply to every file, so this is one line instead of
 * fourteen `afterEach` calls nobody can forget in the fifteenth.
 */
const { cleanup } = await import("@testing-library/react");
afterEach(cleanup);
