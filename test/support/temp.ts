import { tmpdir } from "node:os";
import { temporaryDirectory } from "tempy";

/**
 * A temporary directory that is removed even when the test throws.
 *
 * Not a `try/finally` per call site — that is the rule every twenty-seventh file
 * forgets, and `mkdtempSync` proved it: fifty-four call sites, two of which
 * cleaned up, and the leak was worst on the run that mattered because a failing
 * test never reaches an `rmSync` written after the assertion.
 */
/**
 * `parentDirectory` puts everything one run creates under a single directory, so
 * cleanup is one `rm` from `setup.ts`'s `afterAll` — which Bun runs whether the
 * tests passed, failed or threw. Per process, so two runs on one machine cannot
 * delete each other's.
 *
 * `prefix` is the only thing naming which suite a directory belongs to while the
 * run is still going. Where a directory lives and dies inside one function,
 * prefer tempy's `temporaryDirectoryTask` directly.
 */
const PARENT = `orch-test-${process.pid}-`;

/**
 * Everything {@link tempDir} makes, in one place, so cleanup is one call.
 *
 * tempy allocates this directory rather than us joining a path onto its
 * `rootTemporaryDirectory` export. That export is a re-export of `temp-dir`,
 * initialised in that module's own body, and reading it while this module is being
 * evaluated only worked because the two happened to be ordered that way — under
 * `--isolate` every file is evaluated afresh and the order stopped holding, in all
 * 135 files at once.
 */
/**
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
