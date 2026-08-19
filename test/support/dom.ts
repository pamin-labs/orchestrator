import { afterEach } from "bun:test";
import { readFileSync } from "node:fs";
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
/**
 * What "reaches the browser" means. The dependency, not the directory.
 *
 * It was the directory — everything under `test/web` plus a hand-kept list — and
 * that is what put the restoration loop here. Sixteen of the forty-one files in
 * `test/web` touch no document; they are there because they import a pure module
 * from `web/src`. One of them, `panel-text.test.ts`, builds a `Request` and
 * asserts a 413, which happy-dom's `Request` answers as 400. So a document
 * nobody asked for had to be half-undone for a file that never wanted it, and
 * undoing it split `dispatchEvent` from `Event` — after which no `window` event
 * fired anywhere, for anyone.
 *
 * Not a scan for `web/src` either, which was the first cut and reproduced the
 * same fault one layer in: `panel-text.test.ts` imports three *pure* `.ts`
 * modules from there and still got a document. A `.tsx` is the signal, because
 * evaluating one evaluates Radix, and Radix reads `globalThis?.document` once at
 * module load and never asks again.
 *
 * `test/mech/auth.test.ts` is the other direction: it imports `waitFor` from
 * `@testing-library/dom`, which calls `getDocument()` before it does anything
 * else. A server-side test with a browser dependency.
 */
const reachesDom = (spec: string): boolean =>
  spec.endsWith(".tsx") ||
  spec.includes("support/render") ||
  spec.startsWith("@testing-library/") ||
  spec.includes("happy-dom");

/**
 * `Bun.Transpiler`, synchronously, on the file about to run.
 *
 * Measured at 0.28ms including the read, against ~60ms to register happy-dom for
 * a file that does not need it — so deriving costs less than the list it
 * replaces and cannot drift from it. Synchronous because a preload's top-level
 * `await` does not hold back the test module under `--parallel`.
 *
 * Direct imports only, which is the one thing a list did better: a test reaching
 * the browser through a helper of its own is not seen here. That failure is loud
 * — Radix decides at module evaluation, so every portal in the file stays
 * unmounted — but it does not name its cause, so a helper that pulls in
 * `web/src` should re-export from `support/render`, where this can see it.
 */
const scan = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };

/** Whether the test file at `path` needs a document. */
export function needsDom(path: string): boolean {
  if (!path.includes("test/")) return false;
  try {
    const source = readFileSync(path, "utf8");
    return scan[path.endsWith(".tsx") ? "tsx" : "ts"].scanImports(source).some(({ path: spec }) => reachesDom(spec));
  } catch {
    // Unreadable is not a browser test; the run says so on its own terms.
    return false;
  }
}

/**
 * Bun's own `fetch`, captured before the DOM replaces it.
 *
 * This used to be load-bearing for a whole class of test: happy-dom's `fetch`
 * cannot talk to a real socket — `test/integration` starts a `Bun.serve` and gets
 * `Failed to execute "fetch()" on "Window" … Parse Error` — and those files were
 * being given a document they never asked for. They are no longer classified as
 * browser tests, so the ambient `fetch` is already Bun's for them.
 *
 * What is left is `restoreFetch` in `render.tsx`, for the three files that hold
 * `globalThis.fetch` themselves to order a reply against a render. Capturing
 * still has to happen before `register`, which was the bug before this one: the
 * value saved to "restore" was read afterwards, so it was happy-dom's own.
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
