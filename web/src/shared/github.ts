/**
 * Every github.com URL this panel builds out of stored text.
 *
 * Two callers assemble one, from two different columns, and both are assembling a
 * link the boss will click to leave the panel: a link that points at the wrong
 * repository is worse than no link. They lived apart — one in `lib/utils.ts`, one
 * private to `select.ts` — and the name segment here was `(.+?)`, which matches
 * slashes, so a remote of `github.com/o/n/../../x` produced the repository
 * `o/n/../../x`. The fix was applied to one of them; being one file is what makes
 * the next such fix reach both.
 */

/**
 * A project's repository, as a link.
 *
 * `repo_path` is `owner/name` for every project — migration 037 converted the
 * absolute host paths that used to live there. The shape is still checked
 * rather than assumed, because that migration deliberately leaves a row it
 * cannot convert holding its old path (a project whose remote was missing or
 * was not GitHub), and `https://github.com//Users/…` is worse than plain text.
 */
export const repoHref = (repoPath?: string | null): string | null =>
  repoPath && /^[\w.-]+\/[\w.-]+$/.test(repoPath) ? `https://github.com/${repoPath}` : null;

/** `owner/name` from a git remote, or nothing. Neither segment may contain a slash. */
export const githubRepo = (remote: string) => {
  const match = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote);
  return match ? `${match[1]}/${match[2]}` : null;
};
