import type { GitRunner } from "../src/mech/git/worktree.ts";

/**
 * Real git, on a real directory, for the tests that need one.
 *
 * `worktree.ts` is our workflow rather than git plumbing — checkpoint, squash,
 * rebase, the diff bases — and the cheapest honest way to check it is against a
 * repository that actually exists. Production has no host runner since 007 step
 * 6: every caller passes `sandboxGit` and the code runs in the group's
 * container. This is the fixture that stands in for it, and it lives in `test/`
 * so nothing can wire it into the server by accident.
 *
 * No lock: one host checkout with three concurrent writers is what `gitlock.ts`
 * existed for, and a test file drives one repository from one place.
 */
export const testGit: GitRunner = async (repo, argv, cwd) => {
  const p = Bun.spawn(["git", ...argv], { cwd: cwd ?? repo, stdout: "pipe", stderr: "pipe" });
  const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (so + se).trimEnd() };
};
