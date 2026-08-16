import { BOT, type Trailers } from "./ghlogin.ts";

export type { Trailers };

/**
 * git operations on a group's checkout.
 *
 * Every function takes its runner rather than assuming one, and since 007 step 6
 * there is exactly one to hand it: `sandboxGit`, against the clone inside the
 * group's container. The host runner and the repo write lock it needed are gone
 * with the host checkout — one writer, one `.git`, nothing to serialise.
 */

export interface GitRun {
  code: number;
  out: string;
}

export type GitRunner = (repo: string, argv: string[], cwd?: string) => Promise<GitRun>;

/**
 * The ref this branch is measured against, verified to exist: `origin/main`,
 * `origin/develop`, a bare `master` in a clone with no remote — whatever this
 * repository actually has.
 *
 * Null when nothing resolves, and every caller stops on null rather than
 * carrying on. That is the point of returning it: a guessed `origin/main` does
 * not fail as *this repository has no base branch*, it fails as `fatal:
 * ambiguous argument 'origin/main'` in the middle of a rebase, a squash or a
 * diff — three different messages for one cause, none of which names it.
 *
 * Three callers each wrote `origin/${await detectBaseBranch(...)}` and each took
 * an override argument that no caller outside a test ever passed. So the
 * hardcoded `origin/` prefix was the only path in production, and it is wrong
 * for exactly the clone that has no remote — the one where the fallback was
 * supposed to help.
 */
export async function baseRef(git: GitRunner, repoPath: string): Promise<string | null> {
  const name = await detectBaseBranch(git, repoPath);
  // `HEAD` is that function's way of saying it found nothing, and it is the one
  // answer that resolves anyway: `git rebase HEAD` succeeds and does nothing,
  // `git diff HEAD` is empty. Silent wrong answers, both.
  if (name === "HEAD") return null;
  // Remote first: `main` also exists locally on a branch that has not moved, and
  // rebasing onto the local copy is a no-op that reads as "already up to date".
  for (const ref of [`origin/${name}`, name]) {
    const ok = await git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
    if (ok.code === 0) return ref;
  }
  return null;
}

/** Rebase the group's branch onto the latest base. Used at start and on unpark. */
export async function rebaseOntoBase(git: GitRunner, repoPath: string, worktree: string): Promise<GitRun> {
  const base = await baseRef(git, repoPath);
  // Non-zero, so the caller's existing failure path carries it: unpark escalates
  // to the boss and leaves the group parked rather than waking it onto nothing.
  if (!base) return { code: 1, out: "no base branch: nothing named main, master or origin/HEAD resolves here" };
  await abortStaleRebase(git, repoPath, worktree);
  return git(repoPath, ["rebase", base], worktree);
}

/**
 * A rebase nobody is going to finish.
 *
 * A turn killed mid-rebase — the server stopped, the watchdog took the process,
 * the agent hit its turn cap — leaves `rebase-merge/` in the worktree, and every
 * later rebase refuses with "there is already a rebase-merge directory … I am
 * stopping in case you still have something valuable there". Right for a human
 * at a terminal; here it means the group can never wake, and it says so once per
 * wake attempt forever. Observed on response-aiagent-markdown.
 *
 * Nothing valuable is in there: whatever the interrupted rebase was replaying is
 * still in the branch it was replaying from, and this is called at the start of a
 * rebase that is about to redo the work anyway. `--abort` restores the pre-rebase
 * HEAD, which is exactly the state the caller assumes.
 */
async function abortStaleRebase(git: GitRunner, repoPath: string, worktree: string): Promise<boolean> {
  // Ask git rather than look for `.git/rebase-merge` on disk: the checkout lives
  // in the group's sandbox now, and `--abort` on a repository that is not
  // rebasing is a harmless error. One round trip either way.
  const r = await git(repoPath, ["rebase", "--abort"], worktree);
  return r.code === 0;
}

/**
 * The default branch's **bare** name — `main`, `master`, `trunk`, whatever this
 * remote actually calls it.
 *
 * Bare, and that is the whole point of the rewrite: this used to return
 * `origin/main` when `origin/HEAD` was set and `main` when it was not, while four
 * of its callers wrote `origin/${await defaultBase(...)}`. On any repository where
 * `origin/HEAD` exists — which is every clone — those asked git for
 * `origin/origin/main`.
 *
 * Asked in the order that is right rather than convenient: the remote's own HEAD
 * first (a repo whose default is `trunk` says so here), then whichever of
 * main/master exists on the remote, then locally. `HEAD` last, for a repository
 * with no branches yet.
 */
export async function detectBaseBranch(git: GitRunner, repoPath: string): Promise<string> {
  const hasOrigin = await git(repoPath, ["remote"]);
  if (hasOrigin.code === 0 && hasOrigin.out.includes("origin")) {
    const head = await git(repoPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    const local = head.code === 0 ? head.out.trim().replace("refs/remotes/origin/", "") : "";
    if (local) return local;
    // `origin/HEAD` is not set in every clone, and a rename on the remote does not
    // update it. Ask the remote itself before guessing.
    const remote = await git(repoPath, ["ls-remote", "--symref", "origin", "HEAD"]);
    const named = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(remote.out)?.[1];
    if (remote.code === 0 && named) return named;
    for (const b of ["main", "master"]) {
      const ok = await git(repoPath, ["rev-parse", "--verify", "--quiet", `origin/${b}`]);
      if (ok.code === 0) return b;
    }
  }
  for (const b of ["main", "master"]) {
    const ok = await git(repoPath, ["rev-parse", "--verify", "--quiet", b]);
    if (ok.code === 0) return b;
  }
  return "HEAD";
}

/**
 * What a checkpoint contains, from the `git status` it already ran.
 *
 * A checkpoint whose message is only `wip: S2: engineer` says nothing that
 * `git log --stat` does not — but these commits survive into review whenever
 * `squashWip` declines, and the boss reading the branch then has a list of
 * subjects and no idea which one to open. Twelve paths and a count is a page of
 * the log that answers "where did this touch" without a second command.
 */
const CAP = 12;
function touched(porcelain: string): string {
  const files = porcelainPaths(porcelain);
  const head = files.slice(0, CAP).join("\n");
  return files.length > CAP ? `${head}\n… and ${files.length - CAP} more` : head;
}

/** `git status --porcelain -z` and friends. Always `-z`; see `porcelainPaths`. */
export const STATUS_Z = ["status", "--porcelain", "-z"];

/**
 * The paths `git status --porcelain -z` reports, as they exist on disk.
 *
 * Must be the `-z` form, and the reason is not tidiness. Without it git applies
 * `core.quotePath`, which defaults to on: a path outside ASCII comes back as
 * `"docs/\350\256\276\350\256\241.md"` and a path containing a space comes back
 * quoted too. The caller that mattered is the file-ownership sweep in
 * `executor.ts`, which feeds these names straight to `git checkout --` and
 * `git clean -fd` — and a mangled name matches no pathspec, so git answers
 *
 *     error: pathspec 'docs/\350\256\276\350\256\241.md' did not match any file(s)
 *
 * exits 1, changes nothing, and the exit code was not read. The out-of-bounds
 * file survived and the bus announced it had been reverted, with a count. That
 * is decision 005's only remaining enforcement failing open and reporting
 * success, in a project whose runtime output language is Chinese.
 *
 * `-z` also removes the second guess: entries are NUL-separated, so a rename is
 * `XY new\0old\0` rather than `XY old -> new`, and a path that legitimately
 * contains " -> " stops being ambiguous.
 */
export function porcelainPaths(zOut: string): string[] {
  const fields = zOut.split("\0");
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    out.push(f.slice(3));
    // R and C records are two fields: the name now, then the name before.
    if (f[0] === "R" || f[0] === "C" || f[1] === "R" || f[1] === "C") i++;
  }
  return out;
}

/**
 * A `wip:` checkpoint before every turn.
 *
 * This is what makes intercept L3 ("interrupt and roll back") and "undo a
 * stand-in's answer" possible at all: without a commit at the turn boundary
 * there is no consistent state to return to. Squashed before the PR.
 */
export async function checkpoint(
  git: GitRunner,
  repoPath: string,
  worktree: string,
  label: string,
  trailers: Trailers = DEFAULT_TRAILERS,
): Promise<string | null> {
  const status = await git(repoPath, STATUS_Z, worktree);
  if (status.code !== 0) return null;
  if (status.out.trim()) {
    await git(repoPath, ["add", "-A"], worktree);
    await git(
      repoPath,
      [
        "commit",
        "-q",
        "--no-verify",
        ...signoffArgs(trailers),
        "-m",
        withTrailers(`wip: ${label}\n\n${touched(status.out)}`, trailers),
      ],
      worktree,
    );
  }
  const sha = await git(repoPath, ["rev-parse", "HEAD"], worktree);
  return sha.code === 0 ? sha.out.trim() : null;
}

/**
 * What every commit carries besides its message, when nobody said otherwise.
 *
 * `-s` is git's own flag and writes `Signed-off-by` from the configured author,
 * which is why `createCheckout` sets that author from the connected account —
 * DCO checks that the two match.
 *
 * The co-author trailer is appended to the message instead, because git has no
 * flag for it: GitHub reads a `Co-Authored-By:` line in the body. It goes last,
 * after a blank line, which is where every tool that parses trailers looks.
 *
 * The bot is `BOT`, not a copy of it: an address written out twice is an address
 * that can disagree with itself, and the half that is wrong is the half a DCO
 * check rejects — after every gate has already passed.
 */
const DEFAULT_TRAILERS: Trailers = { signoff: true, coauthor: true, bot: { ...BOT } };

const signoffArgs = (t: Trailers = DEFAULT_TRAILERS): string[] => (t.signoff ? ["-s"] : []);

function withTrailers(message: string, t: Trailers = DEFAULT_TRAILERS): string {
  if (!t.coauthor) return message;
  const line = `Co-Authored-By: ${t.bot.name} <${t.bot.email}>`;
  // Already there — a squash rewrites a message that may carry it from the wip
  // commits it is collapsing, and two identical trailers is a diff nobody wants
  // to explain.
  if (message.includes(line)) return message;
  return `${message.replace(/\s+$/, "")}\n\n${line}\n`;
}

export interface SquashResult {
  /** Commits folded away. 0 means nothing was done, and `reason` says why. */
  squashed: number;
  reason: string;
}

/**
 * Fold the turn checkpoints into one commit before the PR.
 *
 * Every turn leaves a `wip:` commit, so a three-slice feature arrives as a
 * dozen commits all called "wip: engineer turn" — unreviewable, and the
 * opposite of the linear history the merge queue wants.
 *
 * Only an all-`wip:` range is squashed. An agent that wrote real commit
 * messages said something worth keeping, and flattening that would destroy
 * information to satisfy a rule about noise.
 */
export async function squashWip(
  git: GitRunner,
  repoPath: string,
  worktree: string,
  message: string,
  trailers: Trailers = DEFAULT_TRAILERS,
): Promise<SquashResult> {
  const base = await baseRef(git, repoPath);
  if (!base) return { squashed: 0, reason: "no base branch to squash against" };
  const mb = await git(repoPath, ["merge-base", base, "HEAD"], worktree);
  if (mb.code !== 0 || !mb.out.trim()) return { squashed: 0, reason: `no merge base with ${base}` };
  const from = mb.out.trim();

  const log = await git(repoPath, ["log", "--format=%s", `${from}..HEAD`], worktree);
  if (log.code !== 0) return { squashed: 0, reason: "could not read the branch log" };
  const subjects = log.out.trim().split("\n").filter(Boolean);
  if (subjects.length < 2) return { squashed: 0, reason: "nothing to squash" };
  const real = subjects.filter((s) => !s.startsWith("wip:"));
  if (real.length) {
    return { squashed: 0, reason: `left alone: ${real.length} commit(s) have real messages` };
  }

  // --soft keeps the tree exactly as it is; only the history collapses.
  const reset = await git(repoPath, ["reset", "--soft", from], worktree);
  if (reset.code !== 0) return { squashed: 0, reason: reset.out.split("\n").slice(-2).join(" ") };
  const commit = await git(
    repoPath,
    ["commit", "-q", "--no-verify", ...signoffArgs(trailers), "-m", withTrailers(message, trailers)],
    worktree,
  );
  if (commit.code !== 0) return { squashed: 0, reason: commit.out.split("\n").slice(-2).join(" ") };
  return { squashed: subjects.length, reason: `${subjects.length} wip commits -> 1` };
}

/**
 * Discard everything after `sha` — intercept L3's "interrupt and roll back".
 *
 * Returns whether it worked. A rollback that quietly fails is worse than one
 * that errors: the boss reads "rolled back to abc123" and believes the state
 * was restored.
 */
export async function rollbackTo(
  git: GitRunner,
  repoPath: string,
  worktree: string,
  sha: string,
): Promise<{ ok: boolean; error?: string }> {
  const reset = await git(repoPath, ["reset", "--hard", sha], worktree);
  if (reset.code !== 0) {
    return { ok: false, error: reset.out.split("\n").slice(-2).join(" ").trim() };
  }
  await git(repoPath, ["clean", "-fd"], worktree);
  return { ok: true };
}

/**
 * Files changed since a checkpoint — the reconcile input, and free narration.
 *
 * Compares the *working tree* against the sha, not `sha..HEAD`. Reconcile runs
 * the moment a task is marked done, while the turn's work is still uncommitted:
 * comparing commits made every first attempt look like it had changed nothing,
 * and it only "passed" on the retry because the next turn's checkpoint had
 * quietly committed the previous turn's work.
 */
/** Every path the branch point knew about. Used to tell a deletion from a fiction. */
export async function filesAt(git: GitRunner, repoPath: string, worktree: string, sha: string): Promise<string[]> {
  const r = await git(repoPath, ["ls-tree", "-r", "--name-only", sha], worktree);
  return r.code === 0
    ? r.out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
}

/**
 * What to diff a slice against, after somebody has rebased the branch.
 *
 * `slice.base_sha` is the branch tip when the slice started, and it is the right
 * base right up until a rebase rewrites the branch onto a newer main. Then the
 * recorded commit is no longer a point on this branch — it is an ancestor of
 * main — and `git diff <base_sha>` starts reporting every other group's landed
 * work as this slice's change. Groups here rebase on every main push (watchdog
 * rule 15), so that is the normal case, not the rare one.
 *
 * Rule: keep `base_sha` only while it still sits on this branch at or after the
 * fork from main. Otherwise diff from the fork point — the whole branch against
 * origin/main, which is exactly what the PR will show. Says which one it used,
 * because "this slice" and "this branch" are different claims and the boss is
 * accepting one of them.
 */
export async function sliceDiffBase(
  git: GitRunner,
  repoPath: string,
  worktree: string,
  baseSha: string | null,
  // The one override worth having: the caller with a `Ctx` knows the project's
  // base branch from GitHub, which survives a rename of the default branch that
  // a clone's `origin/HEAD` does not. Without one, ask the clone.
  projectRef?: string,
): Promise<{ base: string; scope: "slice" | "branch" } | null> {
  const ref = projectRef ?? (await baseRef(git, repoPath));
  if (!ref) return baseSha ? { base: baseSha, scope: "slice" } : null;
  const forkRun = await git(repoPath, ["merge-base", ref, "HEAD"], worktree);
  const fork = forkRun.code === 0 ? forkRun.out.trim() : "";
  if (!baseSha) return fork ? { base: fork, scope: "branch" } : null;
  const [onBranch, afterFork] = await Promise.all([
    git(repoPath, ["merge-base", "--is-ancestor", baseSha, "HEAD"], worktree),
    fork ? git(repoPath, ["merge-base", "--is-ancestor", fork, baseSha], worktree) : Promise.resolve(null),
  ]);
  if (onBranch.code === 0 && (!fork || afterFork?.code === 0)) return { base: baseSha, scope: "slice" };
  return fork ? { base: fork, scope: "branch" } : { base: baseSha, scope: "slice" };
}

export async function changedSince(git: GitRunner, repoPath: string, worktree: string, sha: string): Promise<string[]> {
  // `-z` for the same reason `porcelainPaths` insists on it: without it these
  // two also come back with non-ASCII and spaced paths quoted and escaped, and
  // these names are what the boss's slice diff is built from.
  const [tracked, untracked] = await Promise.all([
    git(repoPath, ["diff", "--name-only", "-z", sha], worktree),
    git(repoPath, ["ls-files", "--others", "--exclude-standard", "-z"], worktree),
  ]);
  const lines = [
    ...(tracked.code === 0 ? tracked.out.split("\0") : []),
    ...(untracked.code === 0 ? untracked.out.split("\0") : []),
  ];
  return [...new Set(lines.filter(Boolean))];
}
