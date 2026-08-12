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

/** Discard everything after `sha` — intercept L3's "interrupt and roll back". */
export async function rollbackTo(
  git: GitRunner,
  repoPath: string,
  worktree: string,
  sha: string,
): Promise<void> {
  await git(repoPath, ["reset", "--hard", sha], worktree);
  await git(repoPath, ["clean", "-fd"], worktree);
}

/** Files changed since a checkpoint — the reconcile input, and free narration. */
export async function changedSince(
  git: GitRunner,
  repoPath: string,
  worktree: string,
  sha: string,
): Promise<string[]> {
  const r = await git(repoPath, ["diff", "--name-only", `${sha}..HEAD`], worktree);
  if (r.code !== 0) return [];
  return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
}
