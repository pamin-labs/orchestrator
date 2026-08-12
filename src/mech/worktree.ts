import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { RepoLock } from "./gitlock.ts";

/**
 * One worktree per group, created under `workRoot` — deliberately outside
 * `$HOME`, because the sandbox is deny-only and denying `$HOME` is how writes
 * get confined (docs/decisions/001).
 */

export interface WorktreeSpec {
  repoPath: string;
  workRoot: string;
  group: string;
  /** Branch to create. Defaults to `orch/<group>`. */
  branch?: string;
  baseRef?: string;
}

export interface GitRun {
  code: number;
  out: string;
}

export type GitRunner = (repo: string, argv: string[], cwd?: string) => Promise<GitRun>;

/** Runs git under the repo write lock, so parallel groups cannot corrupt `.git`. */
export function makeGitRunner(lock: RepoLock): GitRunner {
  return (repo, argv, cwd) =>
    lock.run(repo, argv, async () => {
      const p = Bun.spawn(["git", ...argv], { cwd: cwd ?? repo, stdout: "pipe", stderr: "pipe" });
      const [so, se] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      return { code: await p.exited, out: (so + se).trimEnd() };
    });
}

export async function createWorktree(
  git: GitRunner,
  spec: WorktreeSpec,
): Promise<{ worktree: string; branch: string }> {
  const branch = spec.branch ?? `orch/${spec.group}`;
  const worktree = join(spec.workRoot, spec.group);
  mkdirSync(spec.workRoot, { recursive: true });

  // Attach to the branch if it already exists — that is the unpark path, and
  // also what happens when a previous attempt failed after creating the branch.
  const exists = await git(spec.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const argv =
    exists.code === 0
      ? ["worktree", "add", worktree, branch]
      : // Branch from the freshest base, not from whatever HEAD happens to be:
        // a group that starts stale pays for it at merge time.
        ["worktree", "add", "-b", branch, worktree, spec.baseRef ?? (await defaultBase(git, spec.repoPath))];

  const add = await git(spec.repoPath, argv);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.out}`);
  return { worktree, branch };
}

export async function removeWorktree(
  git: GitRunner,
  repoPath: string,
  worktree: string,
  opts: { deleteBranch?: string } = {},
): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktree]);
  if (opts.deleteBranch) await git(repoPath, ["branch", "-D", opts.deleteBranch]);
}

/** Rebase the group's branch onto the latest base. Used at start and on unpark. */
export async function rebaseOntoBase(
  git: GitRunner,
  repoPath: string,
  worktree: string,
  baseRef?: string,
): Promise<GitRun> {
  const base = baseRef ?? (await defaultBase(git, repoPath));
  return git(repoPath, ["rebase", base], worktree);
}

export async function defaultBase(git: GitRunner, repoPath: string): Promise<string> {
  const hasOrigin = await git(repoPath, ["remote"]);
  if (hasOrigin.code === 0 && hasOrigin.out.includes("origin")) {
    const head = await git(repoPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (head.code === 0 && head.out.trim()) return head.out.trim().replace("refs/remotes/", "");
    for (const b of ["origin/main", "origin/master"]) {
      const ok = await git(repoPath, ["rev-parse", "--verify", "--quiet", b]);
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
): Promise<string | null> {
  const status = await git(repoPath, ["status", "--porcelain"], worktree);
  if (status.code !== 0) return null;
  if (status.out.trim()) {
    await git(repoPath, ["add", "-A"], worktree);
    await git(repoPath, ["commit", "-q", "--no-verify", "-m", `wip: ${label}`], worktree);
  }
  const sha = await git(repoPath, ["rev-parse", "HEAD"], worktree);
  return sha.code === 0 ? sha.out.trim() : null;
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
  baseRef?: string,
): Promise<SquashResult> {
  const base = baseRef ?? (await defaultBase(git, repoPath));
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
  const commit = await git(repoPath, ["commit", "-q", "--no-verify", "-m", message], worktree);
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
export async function changedSince(
  git: GitRunner,
  repoPath: string,
  worktree: string,
  sha: string,
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(repoPath, ["diff", "--name-only", sha], worktree),
    git(repoPath, ["ls-files", "--others", "--exclude-standard"], worktree),
  ]);
  const lines = [
    ...(tracked.code === 0 ? tracked.out.split("\n") : []),
    ...(untracked.code === 0 ? untracked.out.split("\n") : []),
  ];
  return [...new Set(lines.map((l) => l.trim()).filter(Boolean))];
}
