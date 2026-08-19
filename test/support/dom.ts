import { afterEach } from "bun:test";
import { createRequire } from "node:module";

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
 * Test files whose module graph reaches a browser: everything under `test/web`,
 * plus the few outside it that import a browser library directly.
 *
 * A preload runs for every test file, and registering happy-dom costs ~60ms of
 * the ~119ms the two DOM preloads add — paid 149 times for 107 files that never
 * ask for a document. `Bun.main` inside a `bunfig.toml` preload is the absolute
 * path of the test file about to run, which is the one thing available early
 * enough to decide: the gate has to be inside the preloaded file, because the
 * preload list itself is static (see `coverage.ts`, same problem).
 *
 * The list is explicit rather than derived, so that a file joining it is a
 * decision somebody made. `test/governance/preload-scope.test.ts` fails when a
 * test file imports the browser without appearing here — which matters because
 * the runtime symptom does not name the cause: Radix reads `globalThis?.document`
 * once at load, so a missing document reads as "the dialog never arrived".
 *
 * **This gate requires one test file per process**, which is what `--isolate`
 * buys and what `--parallel` implies. Without either, Bun runs every file in one
 * process, the preload is evaluated exactly once, and `Bun.main` names only the
 * *first* file — so `bun test test/governance/` decides the whole directory from
 * `config-schemas.test.ts` and `bundle-boots.test.ts` dies on `HTMLElement is
 * not defined`. `bun run test <path>` carries `--parallel`; bare `bun test
 * <path>` over more than one file does not. Bare `bun test` over the whole suite
 * is the same bug wearing a green tick: it passes only because the file that
 * sorts first happens to be one of these, so the single registration covers
 * everything behind it — `test/web/knob-models.test.ts` here, and
 * `test/api/telemetry.test.ts` on the integrator's tree, which is the point.
 * Rename a file and the run is catastrophic instead of green. The 12.0s against
 * 5.1s is the same fact from the other side: every file paid for the DOM. Measured against Bun 1.3.14, that
 * mode cannot be detected from inside the preload — `process.argv` is rewritten
 * to the current file in both modes, there is no IPC handle to spot the worker,
 * and `[test] parallel`/`isolate` in `bunfig.toml` are not read. The guard is
 * therefore on the command, in `preload-scope.test.ts`, not on the symptom.
 */
const DOM_TESTS = new Set([
  "api/telemetry.test.ts",
  "governance/bundle-boots.test.ts",
  "http/response-json.test.ts",
  // Not a browser test. It imports `waitFor` from `@testing-library/dom` as a
  // polling helper, and `waitFor` reads `document` before it does anything else
  // — so it needs the whole DOM to wait for a row to appear in SQLite.
  "mech/auth.test.ts",
]);

/** Whether `file` — absolute, or relative to the repo root — needs a document. */
export function needsDom(file: string): boolean {
  // Keyed on the path below `test/`, so the same predicate answers for
  // `Bun.main` (absolute) and for a glob result (`test/web/…`). A file name ends
  // `.test.ts`, never `test/`, so the last occurrence is the directory.
  const at = file.lastIndexOf("test/");
  if (at === -1) return false;
  const rest = file.slice(at + "test/".length);
  return rest.startsWith("web/") || DOM_TESTS.has(rest);
}

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
/**
 * A synchronous require, typed by the caller.
 *
 * `createRequire` hands back `any`, which is exactly what the lint rules exist
 * to stop; the module being loaded is a literal here, so its type is known and
 * the generic simply says so.
 */
const load = createRequire(import.meta.url) as <T>(id: string) => T;

/** Bun's `fetch`, for a test that has replaced it and wants it back. */
export const nativeFetch = globalThis.fetch;

if (needsDom(Bun.main)) {
  const native = new Map(
    Object.getOwnPropertyNames(globalThis).map((name) => [name, Reflect.get(globalThis, name) as unknown]),
  );

  // `require`, not a static import: a static import is loaded by all 149 files,
  // and the loading is the cost being removed. Not `await import` either —
  // measured against Bun 1.3.14, a preload's top-level `await` does **not** hold
  // back the test module under `--parallel`, so anything after one is installed
  // after the file it was meant to precede. Registering behind an `await` here
  // put `document is not defined` through 73 tests. `require` is synchronous, so
  // the document exists before Bun goes looking for the test file.
  const { GlobalRegistrator } = load<typeof import("@happy-dom/global-registrator")>("@happy-dom/global-registrator");
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
  // `dispatchEvent` and its two registrars go with the event classes, because they
  // are one mechanism. Restoring Bun's while keeping happy-dom's `Event` left
  // `window.dispatchEvent` silently doing nothing — a happy-dom event handed to
  // Bun's dispatcher, which drops it — while `document.dispatchEvent` worked. The
  // six `window.addEventListener` calls in `web/src` (the theme hotkey and its
  // change event, the panel's shortcuts, `popstate`, `hashchange`) were therefore
  // not merely untested but untestable.
  const DISPATCH = new Set(["dispatchEvent", "addEventListener", "removeEventListener"]);
  const DOM_OWNS = (name: string) =>
    name === "EventTarget" || name.endsWith("Event") || name === "DOMException" || DISPATCH.has(name);
  for (const [name, value] of native) {
    if (DOM_OWNS(name) || Reflect.get(globalThis, name) === value) continue;
    Reflect.set(globalThis, name, value);
  }

  /**
   * Unmount between tests, once, for every file that registered.
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
   * fourteen `afterEach` calls nobody can forget in the fifteenth. It is inside
   * the gate because there is nothing to clean up where nothing was rendered, and
   * importing testing-library is most of what the gate is avoiding.
   */
  const { cleanup } = load<typeof import("@testing-library/react")>("@testing-library/react");
  afterEach(cleanup);
}
