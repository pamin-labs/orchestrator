import { afterEach } from "bun:test";
import { createRequire } from "node:module";

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

/**
 * The globals a server test needs back, captured before happy-dom lands.
 *
 * happy-dom brings its own `Request`, and its own is not Bun's: a body over the
 * limit is answered 400 where Bun answers 413, which is an assertion in
 * `test/http/stream.test.ts`. Registering for the whole worker means every
 * server test in it would inherit those, so the network primitives are put back
 * and only the document half of happy-dom is kept.
 */
/**
 * `fetch` is in the list for the older reason: happy-dom's cannot talk to a real
 * socket, and `test/integration` boots a real server on a real port.
 */
const NETWORK = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "WebSocket",
  // `AbortController` too, and for a reason worth stating: a signal made by one
  // realm's controller is not an `AbortSignal` to the other's `Request`, so a
  // half-restored set fails as `signal is not of type AbortSignal` rather than as
  // anything about aborting.
  "AbortController",
  "AbortSignal",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
] as const;
const native = new Map(NETWORK.map((name) => [name, Reflect.get(globalThis, name) as unknown]));

/**
 * Registered for every worker, not for the files that ask.
 *
 * The gate used to read `Bun.main`, which names one file only when each gets its
 * own process — and that is what `--isolate` buys, at the price of re-evaluating
 * every module graph per file. A preload runs once per worker, so registering
 * here is ~60ms ten times rather than ~60ms for each of the 67 browser files,
 * and it is what lets the suite run without a fresh world per file at all.
 */
{
  // `require`, not a static import: a static import is loaded by all 149 files,
  // and the loading is the cost being removed. Not `await import` either —
  // measured against Bun 1.3.14, a preload's top-level `await` does **not** hold
  // back the test module under `--parallel`, so anything after one is installed
  // after the file it was meant to precede. Registering behind an `await` here
  // put `document is not defined` through 73 tests. `require` is synchronous, so
  // the document exists before Bun goes looking for the test file.
  const { GlobalRegistrator } = load<typeof import("@happy-dom/global-registrator")>("@happy-dom/global-registrator");
  GlobalRegistrator.register({ url: "http://localhost/" });
  for (const [name, value] of native) Reflect.set(globalThis, name, value);

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
  giveElementsABox();
}

/**
 * A box, for the one thing here that asks how big something is.
 *
 * happy-dom has no layout engine, so every element measures zero. Anything that
 * windows a list reads that as a viewport with no room and draws no rows:
 * `VirtualList` renders its first pass from `initialRect`, the scroll element is
 * then observed, the observation says zero, and every row disappears. Six tests
 * that mount `Timeline` and assert on its text would go red for a reason none of
 * them is about.
 */
/**
 * `offsetWidth`/`offsetHeight` specifically, because that is what the virtualizer
 * reads — `getBoundingClientRect` was the obvious guess and measuring said
 * otherwise. Only on the prototype: a test that pins a size on an element of its
 * own sets an own property, which still wins.
 */
function giveElementsABox(): void {
  for (const [name, size] of [
    ["offsetWidth", 1024],
    ["offsetHeight", 768],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => size });
  }
}
