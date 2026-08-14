import { basename, dirname, isAbsolute, join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  seedIgnored(spec.repoPath, worktree);
  return { worktree, branch };
}

/**
 * Paths a worktree must keep out of git but does not get from `git checkout`.
 *
 * Nothing is symlinked in any more. `node_modules` used to be, pointing at the
 * main checkout, and that one symlink caused the worst class of failure this
 * system has had: every worktree of a repo shared one dependency tree, so two
 * gates installing at once raced on it and a group read `Failed to link jiti:
 * EEXIST` as its own build being broken. Each worktree installs its own now —
 * 144ms and no extra disk on this repo, because bun hardlinks from its cache.
 *
 * `web/dist` was never seeded for the same shape of reason: a shared bundle meant
 * a group's gate served the main checkout's UI, so its own change was invisible
 * to its own test.
 *
 * These still have to be excluded, or the turn checkpoint's `git add -A` commits
 * them: `.gitignore` says `web/dist/` with a trailing slash, which matches a
 * directory and not a symlink, and once a path is tracked no ignore rule applies
 * again — QA rejected a slice over `web/dist` the group never touched.
 */
const SEED: string[] = [];
const EXCLUDE = ["node_modules", "web/dist"];

/**
 * Without these the gates fail for a reason the group did not cause and cannot
 * fix: `denyOutsideOwns` denies every path outside the group's own boundary, so
 * `bun install` and `bun run build:web` both come back as
 * `Operation not permitted` — measured, one group sat on that blocker for hours.
 *
 * Symlinks, not copies: the main checkout rebuilds and every worktree follows.
 * Writing through them is denied by `denyWrite: <repoPath>/**`, so a group
 * cannot dirty the main checkout this way.
 */
export function seedIgnored(repoPath: string, worktree: string): void {
  excludeSeeds(repoPath);
  for (const rel of SEED) {
    const src = join(repoPath, rel);
    const dst = join(worktree, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    try {
      symlinkSync(src, dst);
    } catch {
      // A worktree that starts without one artifact is worse off, not broken.
    }
  }
}

/**
 * `.gitignore` does not cover these symlinks, and `info/exclude` does.
 *
 * `web/dist/` with a trailing slash matches a directory; the seed is a symlink,
 * which is a file. So `git add -A` in the turn checkpoint swallowed it, and once
 * tracked no ignore rule applies again — QA rejected a slice for "the diff
 * contains web/dist" that the group never touched. `info/exclude` lives in the
 * common git dir, so one write covers every worktree, is never committed, and
 * does not depend on what the branch's `.gitignore` happens to say.
 */
function excludeSeeds(repoPath: string): void {
  const path = join(repoPath, ".git/info/exclude");
  try {
    const have = existsSync(path) ? readFileSync(path, "utf8") : "";
    const lines = have.split("\n").map((l) => l.trim());
    const missing = EXCLUDE.filter((s) => !lines.includes(s));
    if (missing.length) {
      appendFileSync(path, `${have.endsWith("\n") || !have ? "" : "\n"}${missing.join("\n")}\n`);
    }
  } catch {
    // A bare or unusual repo layout: the worktree still works, its build output is
    // just visible to git.
  }
}

/**
 * Bring a fresh worktree's dependencies up, on the host.
 *
 * A worktree is a bare checkout: no `node_modules`, no `.venv`, nothing fetched.
 * The agent cannot fix that itself — the sandbox denies writes outside the
 * group's own paths, so `bun install` comes back `EPERM failed to link` — and
 * every gate then fails for a reason the group did not cause and cannot see.
 * Measured: one group sat on that blocker for hours.
 *
 * So the orchestrator does it, before the first turn, with real permissions. The
 * command comes from the project's config (detected, correctable) rather than
 * from a guess in here, because "how do you install this" is the one thing that
 * differs between every stack.
 */
/**
 * Registries a setup command may reach.
 *
 * Deny-by-default, which is the whole reason this list is acceptable where a list
 * of dangerous commands was not: a missing entry here fails the install with a
 * network error the boss can read, while a missing entry in a blocklist is a hole
 * nobody finds. Extend per project with `config_json.installDomains`.
 */
export const INSTALL_DOMAINS = [
  "registry.npmjs.org", "registry.yarnpkg.com", "npm.pkg.github.com",
  "pypi.org", "files.pythonhosted.org",
  "proxy.golang.org", "sum.golang.org", "storage.googleapis.com",
  "crates.io", "static.crates.io", "index.crates.io",
  "api.nuget.org", "repo.maven.apache.org", "rubygems.org",
  "github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com",
];

/**
 * Run a setup command with a boundary around it.
 *
 * The command comes from an agent (see the bootstrap role), and the first version
 * of this checked it against a list of package-manager names — which is the wrong
 * shape of defence: a blocklist of command shapes is only as good as the last
 * thing somebody thought of. `srt` (@anthropic-ai/sandbox-runtime) is the right
 * shape: seatbelt on macOS, bubblewrap on Linux, deny-by-default filesystem and
 * network, no container. Measured here: a write outside the worktree comes back
 * `Operation not permitted` and a fetch to an unlisted host fails to connect.
 *
 * Caches have to be writable or every install fails, so they are allowed
 * explicitly rather than by allowing `$HOME`.
 *
 * If `srt` is missing the command still runs — an unsandboxed install is what
 * this repo did for months — and the caller's own check is what stands in for it.
 */
export async function installDeps(
  worktree: string,
  cmd: string | null | undefined,
  logPath?: string,
  opts: { domains?: string[]; repoRoot?: string } = {},
): Promise<{ ok: boolean; out: string; sandboxed: boolean }> {
  if (!cmd?.trim()) return { ok: true, out: "", sandboxed: false };
  const srt = join(opts.repoRoot ?? process.cwd(), "node_modules/.bin/srt");
  const sandboxed = existsSync(srt);
  let argv = ["sh", "-lc", cmd];
  if (sandboxed) {
    const home = homedir();
    // Not in the worktree: the turn checkpoint's `git add -A` would commit it,
    // and a settings file in the diff is the group being blamed for our plumbing.
    const settings = join(tmpdir(), `orch-srt-${basename(worktree)}.json`);
    writeFileSync(
      settings,
      JSON.stringify({
        network: { allowedDomains: [...INSTALL_DOMAINS, ...(opts.domains ?? [])], deniedDomains: [] },
        filesystem: {
          allowWrite: [
            worktree,
            "/tmp",
            join(home, ".bun/install/cache"),
            join(home, ".npm"),
            join(home, ".cache"),
            join(home, "Library/Caches"),
            join(home, ".cargo/registry"),
            join(home, "go/pkg/mod"),
            join(home, ".nuget/packages"),
            join(home, ".m2/repository"),
          ],
          denyWrite: [],
          denyRead: [join(home, ".ssh"), join(home, ".aws"), join(home, ".config/gh")],
        },
      }),
    );
    argv = [srt, "-s", settings, "-c", cmd];
  }
  const p = Bun.spawn(argv, { cwd: worktree, stdout: "pipe", stderr: "pipe" });
  const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const out = (so + se).trimEnd();
  const ok = (await p.exited) === 0;
  if (logPath) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `$ ${cmd}${sandboxed ? " (sandboxed)" : ""}\n${out}\n`);
    } catch {}
  }
  return { ok, out, sandboxed };
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
export async function abortStaleRebase(git: GitRunner, repoPath: string, worktree: string): Promise<boolean> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const p = await git(repoPath, ["rev-parse", "--git-path", dir], worktree);
    if (p.code !== 0) continue;
    const path = p.out.trim();
    if (!path || !existsSync(isAbsolute(path) ? path : join(worktree, path))) continue;
    await git(repoPath, ["rebase", "--abort"], worktree);
    return true;
  }
  return false;
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
/** Every path the branch point knew about. Used to tell a deletion from a fiction. */
export async function filesAt(git: GitRunner, repoPath: string, worktree: string, sha: string): Promise<string[]> {
  const r = await git(repoPath, ["ls-tree", "-r", "--name-only", sha], worktree);
  return r.code === 0 ? r.out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
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
): Promise<{ base: string; scope: "slice" | "branch" } | null> {
  const ref = await defaultBase(git, repoPath);
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
