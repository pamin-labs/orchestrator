/**
 * All git *writes* for one repo run one at a time.
 *
 * Not the groups' checkouts — each of those is a clone inside its own container,
 * with nothing to share. This is the boss's own repository, which the host still
 * writes to from three places that run concurrently: the watchdog's
 * `fetch origin`, ingesting a group's bundle, and the push behind a PR. Same
 * `.git`, three writers, so they queue.
 *
 * Reads (status, diff, log) are safe and deliberately not serialised — locking
 * them would make the desk wall block on whatever group is being pushed.
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

/**
 * Global flags that consume the next argument. Skipping the flag but not its
 * value makes the value look like the subcommand, so `git -C <path> rebase`
 * reads as a non-write and slips past the lock — the precise corruption this
 * lock exists to prevent.
 */
const VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

export function isWrite(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue; // valueless global flag, or --flag=value
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
