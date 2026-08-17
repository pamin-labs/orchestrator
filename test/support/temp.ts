import { tmpdir } from "node:os";
import { temporaryDirectory } from "tempy";

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
const PARENT = `orch-test-${process.pid}-`;

/**
 * Everything {@link tempDir} makes, in one place, so cleanup is one call.
 *
 * tempy allocates this directory rather than us joining a path onto its
 * `rootTemporaryDirectory` export. That export is a re-export of `temp-dir`,
 * initialised in that module's own body, and reading it while this module is
 * being evaluated only worked because the two happened to be ordered that way.
 * Under `bun test --isolate` — which `--parallel` implies — every file is
 * evaluated afresh and the order stopped holding: `Cannot access
 * 'rootTemporaryDirectory' before initialization`, in all 135 files.
 *
 * Allocated on first use, so a file that makes no temporary directory creates
 * nothing at all.
 */
let root: string | undefined;
const tempRoot = (): string => (root ??= temporaryDirectory({ prefix: PARENT, rootDirectory: tmpdir() }));

/**
 * The path, if one was ever made — for teardown, which may not call tempy.
 *
 * Under `--isolate` the module graph is torn down before `afterAll` runs, so a
 * tempy call from there re-enters a half-initialised `temp-dir` and throws
 * `Cannot access 'tempDir' before initialization` from inside the library. The
 * cleanup hook therefore works from the string this already handed out, and a
 * file that made no directory removes nothing.
 */
export const createdRoot = (): string | undefined => root;

export function tempDir(prefix: string): string {
  return temporaryDirectory({ prefix, rootDirectory: tempRoot() });
}
