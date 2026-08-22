import { afterEach } from "bun:test";
import { createRequire } from "node:module";
import { needsDom } from "../../scripts/needs-dom.ts";

/**
 * A document, installed before any test module is evaluated.
 *
 * A preload entry rather than an import, because the ordering is not advisory:
 * Radix reads `globalThis?.document` when its module is evaluated and decides
 * then whether `useLayoutEffect` is React's or a no-op, so a file that pulls in a
 * primitive first leaves every portal unmounted for the whole process — and the
 * failure reads as "the dialog never arrived". Imports are hoisted, so "import
 * this first" is a rule nothing enforces; a preload entry is a property.
 */
/**
 * Bun's documented happy-dom setup is this file plus that preload line
 * (https://bun.com/docs/test/dom). Registration costs ~60ms per test file, which
 * is what the gate below is for: it reads `Bun.main`, and that names one file only
 * when each gets its own process — `--parallel` implies `--isolate` and buys that,
 * and `preload-scope.test.ts` checks the flag never leaves the scripts.
 */

/**
 * Bun's own `fetch`, captured before the DOM replaces it.
 *
 * This was load-bearing for a whole class of test: happy-dom's `fetch` cannot talk
 * to a real socket, and `test/integration` was being given a document it never
 * asked for. Those files are no longer classified as browser tests, so the ambient
 * `fetch` is already Bun's for them.
 */
/**
 * What is left is `restoreFetch` in `render.tsx`, for the three files that hold
 * `globalThis.fetch` themselves to order a reply against a render. Capturing still
 * has to happen before `register`, which was the bug before this one: the value
 * saved to "restore" was read afterwards, so it was happy-dom's own.
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
   * Unmount between tests, once, for every file that registered.
   *
   * testing-library registers its own `afterEach(cleanup)` when its module is
   * evaluated, and `bun test` scopes hooks to the file that registered them — so
   * that hook belongs to whichever test file imported it first and every later
   * file inherits the previous one's nodes. The symptom is "Found multiple
   * elements", and the second symptom is failures printing an ever-larger document.
   */
  /**
   * From the preload for the same reason the document is: a preload's hooks apply
   * to every file, so this is one line instead of fourteen `afterEach` calls
   * nobody can forget in the fifteenth. Inside the gate because there is nothing
   * to clean up where nothing was rendered.
   */
  const { cleanup } = load<typeof import("@testing-library/react")>("@testing-library/react");
  afterEach(cleanup);
}
