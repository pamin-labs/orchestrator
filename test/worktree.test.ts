import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoLock } from "../src/mech/gitlock.ts";
import { isWrite } from "../src/mech/gitlock.ts";
import {
  changedSince,
  checkpoint,
  createWorktree,
  makeGitRunner,
  removeWorktree,
  rollbackTo,
} from "../src/mech/worktree.ts";

const git = makeGitRunner(new RepoLock());

/** A real repo with one commit. Real git, because this plumbing is easy to fake wrong. */
async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "orch-repo-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("only git writes take the repo lock; reads pass straight through", () => {
  expect(isWrite(["commit", "-m", "x"])).toBe(true);
  // A value-taking global flag must not make its value look like the
  // subcommand, or this write slips past the lock entirely.
  expect(isWrite(["-C", "/tmp/x", "rebase", "main"])).toBe(true);
  expect(isWrite(["-c", "user.name=x", "commit"])).toBe(true);
  expect(isWrite(["--git-dir", "/tmp/x/.git", "fetch"])).toBe(true);
  expect(isWrite(["-C", "/tmp/x", "status"])).toBe(false);
  // Locking reads would make the desk wall block on whichever group is rebasing.
  expect(isWrite(["status", "--porcelain"])).toBe(false);
  expect(isWrite(["diff", "--name-only"])).toBe(false);
  expect(isWrite(["log", "-1"])).toBe(false);
});

test("the repo lock serialises writes and survives a failing one", async () => {
  const lock = new RepoLock();
  const order: string[] = [];
  const slow = lock.run("/r", ["commit"], async () => {
    await Bun.sleep(20);
    order.push("first");
    throw new Error("boom");
  });
  const next = lock.run("/r", ["commit"], async () => {
    order.push("second");
  });
  await expect(slow).rejects.toThrow("boom");
  await next;
  // A rejected write must not poison the chain for whoever is behind it.
  expect(order).toEqual(["first", "second"]);
});

test("a worktree is created on its own branch, outside the main checkout", async () => {
  const dir = await repo();
  const workRoot = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const wt = await createWorktree(git, { repoPath: dir, workRoot, group: "auth-refactor" });

  expect(wt.branch).toBe("orch/auth-refactor");
  expect(existsSync(join(wt.worktree, "a.txt"))).toBe(true);
  // Outside the main checkout, so denying the main checkout confines the group.
  expect(wt.worktree.startsWith(workRoot)).toBe(true);
  expect(wt.worktree.startsWith(dir)).toBe(false);

  await removeWorktree(git, dir, wt.worktree, { deleteBranch: wt.branch });
  expect(existsSync(wt.worktree)).toBe(false);
});

test("two groups get separate worktrees and separate branches", async () => {
  const dir = await repo();
  const workRoot = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const a = await createWorktree(git, { repoPath: dir, workRoot, group: "g1" });
  const b = await createWorktree(git, { repoPath: dir, workRoot, group: "g2" });
  expect(a.worktree).not.toBe(b.worktree);
  expect(a.branch).not.toBe(b.branch);
});

test("checkpoint commits dirty work and returns a sha to come back to", async () => {
  const dir = await repo();
  const workRoot = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const wt = await createWorktree(git, { repoPath: dir, workRoot, group: "g1" });

  const before = await checkpoint(git, dir, wt.worktree, "engineer turn");
  expect(before).toMatch(/^[0-9a-f]{40}$/);

  writeFileSync(join(wt.worktree, "b.txt"), "two\n");
  const after = await checkpoint(git, dir, wt.worktree, "engineer turn");
  expect(after).not.toBe(before);

  // What the turn changed, for reconcile and for free narration.
  expect(await changedSince(git, dir, wt.worktree, before!)).toEqual(["b.txt"]);
});

test("checkpoint on a clean tree does not create an empty commit", async () => {
  const dir = await repo();
  const workRoot = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const wt = await createWorktree(git, { repoPath: dir, workRoot, group: "g1" });
  const a = await checkpoint(git, dir, wt.worktree, "turn");
  const b = await checkpoint(git, dir, wt.worktree, "turn");
  expect(a).toBe(b);
});

test("rollback discards a turn's work — this is intercept L3", async () => {
  const dir = await repo();
  const workRoot = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const wt = await createWorktree(git, { repoPath: dir, workRoot, group: "g1" });
  const before = (await checkpoint(git, dir, wt.worktree, "turn"))!;

  writeFileSync(join(wt.worktree, "half-done.txt"), "abandoned\n");
  await checkpoint(git, dir, wt.worktree, "turn");
  writeFileSync(join(wt.worktree, "untracked.txt"), "also gone\n");

  await rollbackTo(git, dir, wt.worktree, before);
  // Both the committed checkpoint and the untracked leftovers go, or the next
  // turn starts from a state nobody chose.
  expect(existsSync(join(wt.worktree, "half-done.txt"))).toBe(false);
  expect(existsSync(join(wt.worktree, "untracked.txt"))).toBe(false);
  expect(existsSync(join(wt.worktree, "a.txt"))).toBe(true);
});

test("changedSince sees uncommitted work — reconcile runs before any commit", async () => {
  const dir = await repo();
  const workRoot = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const wt = await createWorktree(git, { repoPath: dir, workRoot, group: "g1" });
  const base = (await checkpoint(git, dir, wt.worktree, "start"))!;

  // Exactly the state reconcile sees: the turn wrote files and marked the task
  // done, and nothing has been committed yet.
  writeFileSync(join(wt.worktree, "a.txt"), "changed\n"); // tracked, modified
  writeFileSync(join(wt.worktree, "new.txt"), "added\n"); // untracked

  const changed = await changedSince(git, dir, wt.worktree, base);
  // Comparing base..HEAD instead would return nothing here, which made every
  // first attempt fail reconcile spuriously.
  expect(changed.sort()).toEqual(["a.txt", "new.txt"]);
});
