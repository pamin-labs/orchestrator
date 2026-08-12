/**
 * All git *writes* for one repo run one at a time.
 *
 * Multiple worktrees share a single `.git`, so concurrent fetch / rebase / ref
 * writes from different groups corrupt each other. Reads (status, diff, log)
 * are safe and deliberately not serialised — locking them would make the desk
 * wall block on whatever group is rebasing.
 */

const WRITE_SUBCOMMANDS = new Set([
  "commit",
  "fetch",
  "pull",
  "push",
  "merge",
  "rebase",
  "checkout",
  "switch",
  "branch",
  "worktree",
  "reset",
  "cherry-pick",
  "stash",
  "tag",
  "add",
  "rm",
  "mv",
  "apply",
  "gc",
  "remote",
  "update-ref",
  "clean",
]);

export function isWrite(argv: string[]): boolean {
  for (const a of argv) {
    if (a.startsWith("-")) continue; // skip global flags like -C <path>
    return WRITE_SUBCOMMANDS.has(a);
  }
  return false;
}

export class RepoLock {
  private chains = new Map<string, Promise<unknown>>();

  /** Serialise `fn` against other writes to `repo`. Reads bypass entirely. */
  run<T>(repo: string, argv: string[], fn: () => Promise<T>): Promise<T> {
    if (!isWrite(argv)) return fn();
    const prev = this.chains.get(repo) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive but never let a rejection poison the next waiter.
    this.chains.set(
      repo,
      next.catch(() => {}),
    );
    return next;
  }
}
