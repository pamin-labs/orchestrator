/**
 * Whether a test file reaches the browser, asked in two places.
 *
 * `test/support/dom.ts` asks about the file that is running, to decide whether
 * to register happy-dom. `scripts/stress-tests.ts` asks about every file, to
 * leave the browser tests out of a run that is deliberately not `--isolate`.
 */
/** Here rather than in `dom.ts` because `scripts/` is a different TypeScript
 *  project and `tsc` will not let it see `test/`. One copy of the question is
 *  what keeps the two answers the same. */
import { readFileSync } from "node:fs";

/**
 * What "reaches the browser" means. The dependency, not the directory.
 *
 * The directory was the signal once, and it is what put a global-restoration loop
 * in this file: sixteen of the forty-one files in `test/web` touch no document,
 * and one of them asserts a 413 that happy-dom's `Request` answers as 400.
 * Undoing the document for it split `dispatchEvent` from `Event`, after which no
 * `window` event fired anywhere.
 */
/**
 * Not `web/src` either — that reproduced the same fault one layer in. A `.tsx` is
 * the signal, because evaluating one evaluates Radix, and Radix reads
 * `globalThis?.document` once at module load and never asks again.
 * `test/mech/auth.test.ts` is the other direction: a server-side test whose
 * `waitFor` calls `getDocument()`.
 */
const reachesDom = (spec: string): boolean =>
  spec.endsWith(".tsx") ||
  spec.includes("support/render") ||
  spec.startsWith("@testing-library/") ||
  spec.includes("happy-dom");

/**
 * `Bun.Transpiler`, synchronously, on the file about to run.
 *
 * Measured at 0.28ms including the read, against ~60ms to register happy-dom for a
 * file that does not need it — so deriving costs less than the list it replaces and
 * cannot drift from it. Synchronous because a preload's top-level `await` does not
 * hold back the test module under `--parallel`.
 */
/**
 * Direct imports only, which is the one thing a list did better: a test reaching the
 * browser through a helper of its own is not seen here. That failure is loud but
 * does not name its cause, so a helper that pulls in `web/src` should re-export from
 * `support/render`, where this can see it.
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
