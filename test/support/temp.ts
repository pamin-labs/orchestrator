import { join } from "node:path";
import { rootTemporaryDirectory, temporaryDirectory } from "tempy";

/**
 * A temporary directory that is removed even when the test throws.
 *
 * `mkdtempSync` was the previous owner, at fifty-four call sites across
 * twenty-seven files, and two of them cleaned up. The other fifty-two leaked on
 * every run — and *always* on the run that mattered, because a test that fails
 * never reaches whatever `rmSync` was written after the assertion.
 *
 * The fix is not a `try/finally` per call site, which is the rule every twenty-
 * seventh file forgets. `parentDirectory` puts everything this run creates under
 * one directory, so removing all of it is a single `rm` that `test/support/setup.ts`
 * runs from `afterAll` — a hook Bun runs whether the tests passed, failed or
 * threw. Per process, so two `bun test` runs on one machine cannot delete each
 * other's directories.
 *
 * `prefix` is kept from the old call sites and is still worth passing: it is the
 * only thing naming which suite a directory belongs to while the run is still
 * going.
 *
 * Where a directory genuinely lives and dies inside one function, prefer tempy's
 * `temporaryDirectoryTask` directly — it removes the directory the moment that
 * function returns or throws, rather than at the end of the run.
 */
const PARENT = `orch-test-${process.pid}`;

/** Everything {@link tempDir} makes, in one place, so cleanup is one call. */
export const tempRoot = join(rootTemporaryDirectory, PARENT);

export function tempDir(prefix: string): string {
  return temporaryDirectory({ prefix, parentDirectory: PARENT });
}
