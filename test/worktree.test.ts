import { expect, test } from "bun:test";
import { testGit } from "./git-runner.ts";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseBranch, LINK_AGENTS_MD } from "../src/mech/git/checkout.ts";
import { openMemory } from "../src/db.ts";
import type { Ctx } from "../src/api.ts";
import {
  changedSince,
  detectBaseBranch,
  checkpoint,
  rebaseOntoBase,
  rollbackTo,
  sliceDiffBase,
  squashWip,
} from "../src/mech/git/worktree.ts";

/**
 * A group's checkout, as a plain clone.
 *
 * It is a clone in a sandbox in production and a clone in a temp dir here, and
 * every helper below takes its git runner rather than assuming one — which is
 * exactly what makes the two interchangeable.
 */
async function checkout(origin: string, branch = "orch/g1"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "orch-wt-"));
  const work = join(dir, "work");
  await git(dir, ["clone", "-q", origin, work]);
  await git(work, ["config", "user.email", "a@orch.local"], work);
  await git(work, ["config", "user.name", "orch agent"], work);
  await git(work, ["checkout", "-q", "-b", branch], work);
  return work;
}

const git = testGit;

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

test("a worktree installs its own dependencies and keeps them out of git", async () => {
  const dir = await repo();
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  mkdirSync(join(dir, "web/dist"), { recursive: true });
  writeFileSync(join(dir, "web/dist/main.js"), "built\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\nweb/dist/\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "ignore built things"]);
  const wt = { worktree: await checkout(dir, "orch/g1"), branch: "orch/g1" };

  // A group's checkout starts with nothing built in it. It used to start with a
  // `node_modules` symlink to the main checkout, and that one symlink caused the
  // worst class of failure this system has had: every worktree of a repo shared
  // one dependency tree, so two gates installing at once raced on it and the
  // group read `Failed to link jiti: EEXIST` as its own build being broken.
  expect(existsSync(join(wt.worktree, "node_modules"))).toBe(false);
  expect(existsSync(join(wt.worktree, "web/dist"))).toBe(false);

  // Whatever the install writes must stay invisible to git, or the turn
  // checkpoint's `git add -A` commits it and QA rejects a slice over a file the
  // group never touched.
  mkdirSync(join(wt.worktree, "node_modules"), { recursive: true });
  writeFileSync(join(wt.worktree, "node_modules/marker"), "x");
  expect((await git(wt.worktree, ["status", "--porcelain"], wt.worktree)).out).toBe("");
});

test("a repo that has never been built still gets a worktree", async () => {
  const dir = await repo();
  const wt = { worktree: await checkout(dir, "orch/g1"), branch: "orch/g1" };
  expect(existsSync(join(wt.worktree, "a.txt"))).toBe(true);
  expect(existsSync(join(wt.worktree, "node_modules"))).toBe(false);
});

test("checkpoint commits dirty work and returns a sha to come back to", async () => {
  const dir = await repo();
  const wt = { worktree: await checkout(dir, "orch/g1"), branch: "orch/g1" };

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
  const wt = { worktree: await checkout(dir, "orch/g1"), branch: "orch/g1" };
  const a = await checkpoint(git, dir, wt.worktree, "turn");
  const b = await checkpoint(git, dir, wt.worktree, "turn");
  expect(a).toBe(b);
});

test("rollback discards a turn's work — this is intercept L3", async () => {
  const dir = await repo();
  const wt = { worktree: await checkout(dir, "orch/g1"), branch: "orch/g1" };
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
  const wt = { worktree: await checkout(dir, "orch/g1"), branch: "orch/g1" };
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

test("wip checkpoints are squashed into one commit, and the tree survives", async () => {
  const dir = await repo();
  const wt = { worktree: await checkout(dir, "orch/g1"), branch: "orch/g1" };

  for (const [file, body] of [["b.txt", "one\n"], ["c.txt", "two\n"], ["d.txt", "three\n"]]) {
    writeFileSync(join(wt.worktree, file!), body!);
    await checkpoint(git, dir, wt.worktree, "engineer turn");
  }
  expect((await git(dir, ["log", "--format=%s", "main..HEAD"], wt.worktree)).out.split("\n").length).toBe(3);

  const r = await squashWip(git, dir, wt.worktree, "feat: the whole thing", "main");
  expect(r.squashed).toBe(3);

  const log = (await git(dir, ["log", "--format=%s", "main..HEAD"], wt.worktree)).out.trim();
  expect(log).toBe("feat: the whole thing");
  // --soft, so every file the turns wrote is still there and still committed.
  for (const f of ["b.txt", "c.txt", "d.txt"]) expect(existsSync(join(wt.worktree, f))).toBe(true);
  expect((await git(dir, ["status", "--porcelain"], wt.worktree)).out.trim()).toBe("");
});

test("a real commit message is never squashed away", async () => {
  const dir = await repo();
  const wt = { worktree: await checkout(dir, "orch/g1"), branch: "orch/g1" };

  writeFileSync(join(wt.worktree, "b.txt"), "one\n");
  await checkpoint(git, dir, wt.worktree, "engineer turn");
  writeFileSync(join(wt.worktree, "c.txt"), "two\n");
  await git(dir, ["add", "-A"], wt.worktree);
  await git(dir, ["commit", "-q", "-m", "fix: the actual bug"], wt.worktree);

  const r = await squashWip(git, dir, wt.worktree, "squashed", "main");
  expect(r.squashed).toBe(0);
  expect(r.reason).toContain("real messages");
  expect((await git(dir, ["log", "--format=%s", "main..HEAD"], wt.worktree)).out).toContain("fix: the actual bug");
});

test("a rebased branch stops reporting other groups' landed work as this slice's diff", async () => {
  const dir = await repo();
  const wt = { worktree: await checkout(dir, "orch/g1"), branch: "orch/g1" };

  // Where the slice started: the branch tip at the time, which here is main.
  const base = (await git(dir, ["rev-parse", "HEAD"], wt.worktree)).out.trim();
  writeFileSync(join(wt.worktree, "mine.txt"), "slice work\n");
  await checkpoint(git, dir, wt.worktree, "engineer turn");

  // Untouched branch: the recorded base is still a point on it.
  expect(await sliceDiffBase(git, dir, wt.worktree, base)).toEqual({ base, scope: "slice" });

  // Another group lands on main, and this branch is rebased onto it (rule 15).
  // The base is `origin/main`: a clone's own `main` does not move when the
  // remote does, which is the whole reason rule 15 fetches first.
  writeFileSync(join(dir, "theirs.txt"), "somebody else\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "other group"]);
  await git(wt.worktree, ["fetch", "-q", "origin"], wt.worktree);
  await rebaseOntoBase(git, wt.worktree, wt.worktree, "origin/main");

  // The recorded base is now a commit on main, so diffing from it would call
  // `theirs.txt` part of this slice. Fall back to the fork point instead.
  const after = await sliceDiffBase(git, wt.worktree, wt.worktree, base);
  expect(after?.scope).toBe("branch");
  const files = (await git(dir, ["diff", "--name-only", after!.base], wt.worktree)).out;
  expect(files).toContain("mine.txt");
  expect(files).not.toContain("theirs.txt");
});

test("a repo with only AGENTS.md gets CLAUDE.md, and the other way round", () => {
  // Runs inside the checkout, in the container — this used to be a host
  // `symlinkSync` against `/work`, which does not exist here, so it silently did
  // nothing for every turn. The command itself is what is checked.
  const link = (dir: string) => Bun.spawnSync(["sh", "-c", LINK_AGENTS_MD], { cwd: dir });

  const dir = mkdtempSync(join(tmpdir(), "orch-md-"));
  writeFileSync(join(dir, "AGENTS.md"), "rules\n");
  link(dir);
  // A codex-native repo: a claude turn used to run with no project instructions
  // at all, which looks exactly like a project that has none.
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("rules\n");

  const other = mkdtempSync(join(tmpdir(), "orch-md-"));
  writeFileSync(join(other, "CLAUDE.md"), "rules\n");
  link(other);
  expect(readFileSync(join(other, "AGENTS.md"), "utf8")).toBe("rules\n");

  // A repo shipping both is left alone: it said what it wanted.
  const both = mkdtempSync(join(tmpdir(), "orch-md-"));
  writeFileSync(join(both, "CLAUDE.md"), "for claude\n");
  writeFileSync(join(both, "AGENTS.md"), "for codex\n");
  link(both);
  expect(readFileSync(join(both, "AGENTS.md"), "utf8")).toBe("for codex\n");
});

test("the base branch is a bare name, whatever the remote calls it", async () => {
  // The bug: this returned `origin/main` when `origin/HEAD` was set and `main`
  // when it was not, while four callers wrote `origin/${...}` around it. On any
  // ordinary clone they were asking git for `origin/origin/main`.
  const origin = await repo();
  await git(origin, ["branch", "-m", "main", "trunk"]);
  const dir = mkdtempSync(join(tmpdir(), "orch-base-"));
  const work = join(dir, "work");
  await git(dir, ["clone", "-q", origin, work]);

  expect(await detectBaseBranch(git, work)).toBe("trunk");
  // Without origin/HEAD it has to ask the remote rather than guess main.
  await git(work, ["update-ref", "-d", "refs/remotes/origin/HEAD"], work);
  expect(await detectBaseBranch(git, work)).toBe("trunk");
});

test("a renamed default branch is picked up rather than breaking every clone", async () => {
  // GitHub is the source, never host git: `repo_path` is `owner/name` and there
  // is no checkout on this machine to ask. The drift itself still has to be
  // caught — a default branch renamed on the remote leaves every clone, rebase
  // and diff resolving against a ref that is not there.
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', 'acme/p', 0)");
  const said: string[] = [];
  let branch = "main";
  const ctx = {
    db,
    bus: { emit: (e: { body: string }) => said.push(e.body) },
    gh: { remaining: () => null, request: async () => ({ ok: true, status: 200, data: { default_branch: branch } }) },
  } as unknown as Ctx;

  // Resolved once, then stored: the diff baseline has to mean the same thing on
  // the day a slice was cut and the day the boss reads it.
  expect(await baseBranch(ctx, 1)).toBe("main");
  expect(db.query<{ b: string | null }, []>("SELECT base_branch AS b FROM project").get()!.b).toBe("main");
  // Learning it the first time is not a change, so it is not announced.
  expect(said).toEqual([]);

  branch = "mainline";
  expect(await baseBranch(ctx, 1)).toBe("mainline");
  expect(said.join(" ")).toContain("mainline");

  // GitHub unreachable keeps what is stored: resetting a project that develops
  // on `develop` to `main` because the network blinked would repoint every diff.
  const offline = { ...ctx, gh: { remaining: () => null, request: async () => ({ ok: false, status: 0, bucket: "transient", message: "x" }) } } as unknown as Ctx;
  expect(await baseBranch(offline, 1)).toBe("mainline");
});
