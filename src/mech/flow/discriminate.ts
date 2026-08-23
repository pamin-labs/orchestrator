import { activeTracer } from "../../platform/observability/traces.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import { errText } from "../../platform/process/text.ts";
import { STATUS_Z, type GitRunner } from "../git/gitops.ts";

/**
 * Do this slice's tests discriminate anything?
 *
 * The deterministic gate believes any suite that exits 0, `reconcile` compares
 * file paths rather than assertions, and QA reads the diff the same model wrote.
 * So the cheapest way to turn a slice green is to weaken a test, and no layer
 * here could see it.
 */
/**
 * The check is the repository's own rule made executable: "a new guard is shown
 * failing before it is kept". Put the slice's source back the way it was, run the
 * project's own tests, and they must fail. Still green means the new tests
 * distinguish nothing — which is what a mutation tool measures, minus the
 * per-language dependency we cannot take into somebody else's repository.
 */

export type Discrimination = { ran: false; why: string } | { ran: true; discriminates: boolean };

/**
 * Paths that hold tests, in the languages this runs in — which is all of them.
 *
 * Guessing wrong costs a skipped check, never a wrong verdict: a path this fails
 * to recognise lands in `source`, and reverting more than the change under test
 * only makes the suite likelier to fail, which is the healthy answer.
 */
const TEST_PATH =
  /(^|\/)(tests?|spec|__tests__|src\/test)\/|(^|\/)[^/]*[._-](test|spec)s?\.[^/]+$|(^|\/)(test|spec)_[^/]+$|[^/]*Tests?\.[^/]+$/;

/** More than this and the slice has a problem no check here can name. */
const MAX_SOURCE = 100;

export interface DiscriminateOpts {
  git: GitRunner;
  worktree: string;
  baseSha: string;
  /** What this slice changed, as `review.ts` already computed it. */
  changed: string[];
  /** The project's own `test` gate. Returns its exit code. */
  runTest: () => Promise<number>;
}

export const isTestPath = (path: string): boolean => TEST_PATH.test(path);

export async function discriminate(opts: DiscriminateOpts): Promise<Discrimination> {
  return activeTracer().startActiveSpan("gate.discriminate", async (span) => {
    try {
      const out = await run(opts);
      span.setAttribute("discriminate.ran", out.ran);
      if (out.ran) span.setAttribute("discriminate.discriminates", out.discriminates);
      return out;
    } catch (cause) {
      // Never the slice's failure: this layer produces evidence, and evidence
      // that could not be gathered is silence, not a verdict.
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(cause) });
      const failed: Discrimination = { ran: false, why: errText(cause) };
      return failed;
    } finally {
      span.end();
    }
  });
}

async function run(opts: DiscriminateOpts): Promise<Discrimination> {
  const { git, worktree, baseSha, changed } = opts;
  const tests = changed.filter(isTestPath);
  const source = changed.filter((p) => !isTestPath(p));
  if (!tests.length) return { ran: false, why: "no test file changed" };
  if (!source.length) return { ran: false, why: "no source file changed" };
  if (source.length > MAX_SOURCE) return { ran: false, why: `${source.length} source files` };

  // Committed work only, and this is the one line that must not be wrong: every
  // step below restores from a git object, so anything not in one is lost.
  const dirty = await git(STATUS_Z, worktree);
  if (dirty.code !== 0) return { ran: false, why: "git status failed" };
  if (dirty.out.length) return { ran: false, why: "uncommitted work in the worktree" };

  const known = new Set(await filesAt(git, worktree, baseSha));
  const existed = source.filter((p) => known.has(p));
  const added = source.filter((p) => !known.has(p));

  try {
    // Both halves. Reverting the edited files but leaving a new module in place
    // means the tests written for that module still pass, and the check reports
    // "discriminates nothing" about a slice that discriminates fine.
    if (existed.length && (await git(["checkout", baseSha, "--", ...existed], worktree)).code !== 0)
      return { ran: false, why: "could not restore the base revision" };
    if (added.length && (await git(["rm", "-f", "-q", "--", ...added], worktree)).code !== 0)
      return { ran: false, why: "could not remove this slice's new files" };

    // Non-zero is the healthy answer, compile errors included: a test that names
    // a symbol this slice introduced cannot build without it, and failing to
    // build is the test distinguishing the change.
    return { ran: true, discriminates: (await opts.runTest()) !== 0 };
  } finally {
    // `checkout HEAD --` writes the index and the worktree, so a file removed
    // above comes back with it. Verified rather than assumed: what this leaves
    // behind is the branch an agent is about to commit to.
    await git(["checkout", "HEAD", "--", ...source], worktree);
  }
}

/** `git status` after the restore, for the caller to check. Empty means clean. */
export async function stillClean(git: GitRunner, worktree: string): Promise<boolean> {
  const after = await git(STATUS_Z, worktree);
  return after.code === 0 && after.out.length === 0;
}

async function filesAt(git: GitRunner, worktree: string, sha: string): Promise<string[]> {
  const r = await git(["ls-tree", "-r", "--name-only", "-z", sha], worktree);
  return r.code === 0 ? r.out.split("\0").filter(Boolean) : [];
}
