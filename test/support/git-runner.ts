import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitRunner } from "../../src/mech/git/gitops.ts";
import { tempDir } from "./temp.ts";

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
export const testGit: GitRunner = async (argv, cwd) => {
  // `cwd` decides where this runs, and nothing else does. The runner used to take
  // a repository argument that only *this* implementation honoured — production's
  // `sandboxGit` opened `async (_repo, …)` and always ran in `WORK` — so a caller
  // could name a directory and be ignored everywhere that mattered.
  const p = Bun.spawn(["git", ...argv], { cwd: cwd ?? process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (so + se).trimEnd() };
};

/** An origin repository and a group's checkout of it, as {@link gitFixture} hands them out. */
export interface GitFixture {
  /** The remote: one commit on `main`, holding `a.txt` and a `.gitignore` for build output. */
  origin: string;
  /** A clone of it on `orch/g1`, configured as an agent — the group's checkout. */
  work: string;
}

/**
 * The pair, built once per module and copied per test.
 *
 * Replaying the same nine commands per test is what made `worktree.test.ts` 31%
 * of the suite: measured at 112ms of `git init`/`config`/`commit`/`clone` for
 * every one of them, against 0.6ms to copy the finished pair. Git is not being
 * faked — every helper under test still drives the real binary against a real
 * repository. What is skipped is *building* a repository fourteen times to get
 * fourteen identical ones.
 *
 * Copied, never shared: a test that commits, rebases or rolls back is working in
 * its own directory, and the template is only ever read after the one build. The
 * clone's remote is `../origin` rather than an absolute path, so the copy's
 * `fetch` reaches the copy's own origin — an absolute one would point every test
 * at the template and let the first `git commit` there leak into all the others.
 */
let template: Promise<string> | undefined;

async function buildTemplate(): Promise<string> {
  const dir = tempDir("orch-git-tpl-");
  const origin = join(dir, "origin");
  mkdirSync(origin);
  await testGit(["init", "-q", "-b", "main"], origin);
  await testGit(["config", "user.email", "t@example.com"], origin);
  await testGit(["config", "user.name", "test"], origin);
  writeFileSync(join(origin, "a.txt"), "one\n");
  writeFileSync(join(origin, ".gitignore"), "node_modules/\nweb/dist/\n");
  await testGit(["add", "-A"], origin);
  await testGit(["commit", "-q", "-m", "init"], origin);

  const work = join(dir, "work");
  await testGit(["clone", "-q", origin, work], dir);
  await testGit(["remote", "set-url", "origin", "../origin"], work);
  await testGit(["config", "user.email", "a@orch.local"], work);
  await testGit(["config", "user.name", "orch agent"], work);
  await testGit(["checkout", "-q", "-b", "orch/g1"], work);
  return dir;
}

/** A private copy of the pair. `prefix` names the suite in the temp root, as `tempDir` does. */
export async function gitFixture(prefix = "orch-git-"): Promise<GitFixture> {
  const dir = tempDir(prefix);
  cpSync(await (template ??= buildTemplate()), dir, { recursive: true });
  return { origin: join(dir, "origin"), work: join(dir, "work") };
}
