import { expect, test } from "bun:test";
import { gitFixture, testGit } from "../support/git-runner.ts";
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseBranch, LINK_AGENTS_MD } from "../../src/mech/git/checkout.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { project } from "../../src/platform/persistence/schema.ts";
import type { Github } from "../../src/mech/git/github.ts";
import {
  baseRef,
  changedSince,
  detectBaseBranch,
  checkpoint,
  rebaseOntoBase,
  rollbackTo,
  sliceDiffBase,
  squashWip,
} from "../../src/mech/git/gitops.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";
import { tempDir } from "../support/temp.ts";

/** What `baseBranchFallbacks` ships as; the subject here is the search, not the list. */
const FALLBACKS = ["main", "master"] as const;

const git = testGit;

/**
 * How long real git is allowed to take.
 *
 * What it costs is I/O, and I/O on a shared CI runner is not the I/O on a
 * developer's machine — `wip checkpoints are squashed` runs in 0.6s here and hit
 * the 5s default on a GitHub runner, failing a job over a slow disk.
 *
 * Generous rather than tuned: a ceiling on a hang, not a performance assertion.
 */
const GIT_IO = 30_000;

/**
 * A real origin and a real clone of it on `orch/g1` — a group's checkout.
 *
 * Real git, because this plumbing is easy to fake wrong: every helper below takes a
 * git runner rather than assuming one, which makes the temp directory here and the
 * container in production interchangeable.
 *
 * `gitFixture` builds the pair once for the file and hands out a private copy —
 * 0.6ms against 112ms of `init`/`config`/`commit`/`clone`.
 */
async function checkout(): Promise<{ dir: string; wt: { worktree: string; branch: string } }> {
  const { origin, work } = await gitFixture("orch-wt-");
  return { dir: origin, wt: { worktree: work, branch: "orch/g1" } };
}

test.concurrent(
  "a worktree installs its own dependencies and keeps them out of git",
  async () => {
    // A built origin, and then a checkout taken from it — the order is the point.
    const { dir } = await checkout();
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    mkdirSync(join(dir, "web/dist"), { recursive: true });
    writeFileSync(join(dir, "web/dist/main.js"), "built\n");
    const worktree = join(dir, "../built-work");
    await git(["clone", "-q", dir, worktree], dir);

    // A group's checkout starts with nothing built in it. It used to start with a
    // `node_modules` symlink to the main checkout, and that one symlink caused the
    // worst class of failure this system has had: every worktree of a repo shared
    // one dependency tree, so two gates installing at once raced on it and the
    // group read `Failed to link jiti: EEXIST` as its own build being broken.
    expect({
      node_modules: existsSync(join(worktree, "node_modules")),
      "web/dist": existsSync(join(worktree, "web/dist")),
    }).toEqual({ node_modules: false, "web/dist": false });

    // Whatever the install writes must stay invisible to git, or the turn
    // checkpoint's `git add -A` commits it and QA rejects a slice over a file the
    // group never touched.
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    writeFileSync(join(worktree, "node_modules/marker"), "x");
    expect((await git(["status", "--porcelain"], worktree)).out).toBe("");
  },
  GIT_IO,
);

test.concurrent(
  "a repo that has never been built still gets a worktree",
  async () => {
    // Nothing has created `node_modules` in this copy of the origin, and nothing
    // needs to have: the checkout does not depend on a build existing anywhere.
    const { wt } = await checkout();
    expect({
      "a.txt": existsSync(join(wt.worktree, "a.txt")),
      node_modules: existsSync(join(wt.worktree, "node_modules")),
    }).toEqual({ "a.txt": true, node_modules: false });
  },
  GIT_IO,
);

test.concurrent(
  "checkpoint commits dirty work and returns a sha to come back to",
  async () => {
    const { wt } = await checkout();

    const before = await checkpoint(git, wt.worktree, "engineer turn");
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(wt.worktree, "b.txt"), "two\n");
    const after = await checkpoint(git, wt.worktree, "engineer turn");
    expect(after).not.toBe(before);

    // What the turn changed, for reconcile and for free narration.
    expect(await changedSince(git, wt.worktree, before!)).toEqual(["b.txt"]);

    // And in the message, because these commits survive into review whenever
    // `squashWip` declines: a branch of subjects that all say `wip: engineer turn`
    // gives the boss no way to pick which one to open.
    const msg = (await git(["log", "-1", "--format=%B"], wt.worktree)).out;
    expect(msg).toContain("b.txt");
  },
  GIT_IO,
);

test.concurrent(
  "checkpoint on a clean tree does not create an empty commit",
  async () => {
    const { wt } = await checkout();
    const a = await checkpoint(git, wt.worktree, "turn");
    const b = await checkpoint(git, wt.worktree, "turn");
    expect(a).toBe(b);
  },
  GIT_IO,
);

test.concurrent(
  "rollback discards a turn's work — this is intercept L3",
  async () => {
    const { wt } = await checkout();
    const before = (await checkpoint(git, wt.worktree, "turn"))!;

    writeFileSync(join(wt.worktree, "half-done.txt"), "abandoned\n");
    await checkpoint(git, wt.worktree, "turn");
    writeFileSync(join(wt.worktree, "untracked.txt"), "also gone\n");

    await rollbackTo(git, wt.worktree, before);
    // Both the committed checkpoint and the untracked leftovers go, or the next
    // turn starts from a state nobody chose.
    expect({
      "half-done.txt": existsSync(join(wt.worktree, "half-done.txt")),
      "untracked.txt": existsSync(join(wt.worktree, "untracked.txt")),
      "a.txt": existsSync(join(wt.worktree, "a.txt")),
    }).toEqual({ "half-done.txt": false, "untracked.txt": false, "a.txt": true });
  },
  GIT_IO,
);

test.concurrent(
  "changedSince sees uncommitted work — reconcile runs before any commit",
  async () => {
    const { wt } = await checkout();
    const base = (await checkpoint(git, wt.worktree, "start"))!;

    // Exactly the state reconcile sees: the turn wrote files and marked the task
    // done, and nothing has been committed yet.
    writeFileSync(join(wt.worktree, "a.txt"), "changed\n"); // tracked, modified
    writeFileSync(join(wt.worktree, "new.txt"), "added\n"); // untracked

    const changed = await changedSince(git, wt.worktree, base);
    // Comparing base..HEAD instead would return nothing here, which made every
    // first attempt fail reconcile spuriously.
    expect(changed.sort()).toEqual(["a.txt", "new.txt"]);
  },
  GIT_IO,
);

test.concurrent(
  "wip checkpoints are squashed into one commit, and the tree survives",
  async () => {
    const { wt } = await checkout();

    for (const [file, body] of [
      ["b.txt", "one\n"],
      ["c.txt", "two\n"],
      ["d.txt", "three\n"],
    ]) {
      writeFileSync(join(wt.worktree, file!), body!);
      await checkpoint(git, wt.worktree, "engineer turn");
    }
    expect((await git(["log", "--format=%s", "main..HEAD"], wt.worktree)).out.split("\n").length).toBe(3);

    const r = await squashWip(git, wt.worktree, "feat: the whole thing", FALLBACKS);
    expect(r.squashed).toBe(3);

    const log = (await git(["log", "--format=%s", "main..HEAD"], wt.worktree)).out.trim();
    expect(log).toBe("feat: the whole thing");
    // --soft, so every file the turns wrote is still there and still committed.
    for (const f of ["b.txt", "c.txt", "d.txt"]) expect(existsSync(join(wt.worktree, f))).toBe(true);
    expect((await git(["status", "--porcelain"], wt.worktree)).out.trim()).toBe("");
  },
  GIT_IO,
);

test.concurrent(
  "a real commit message is never squashed away",
  async () => {
    const { wt } = await checkout();

    writeFileSync(join(wt.worktree, "b.txt"), "one\n");
    await checkpoint(git, wt.worktree, "engineer turn");
    writeFileSync(join(wt.worktree, "c.txt"), "two\n");
    await git(["add", "-A"], wt.worktree);
    await git(["commit", "-q", "-m", "fix: the actual bug"], wt.worktree);

    const r = await squashWip(git, wt.worktree, "squashed", FALLBACKS);
    expect(r.squashed).toBe(0);
    expect(r.reason).toContain("real messages");
    expect((await git(["log", "--format=%s", "main..HEAD"], wt.worktree)).out).toContain("fix: the actual bug");
  },
  GIT_IO,
);

test.concurrent(
  "a rebased branch stops reporting other groups' landed work as this slice's diff",
  async () => {
    const { dir, wt } = await checkout();

    // Where the slice started: the branch tip at the time, which here is main.
    const base = (await git(["rev-parse", "HEAD"], wt.worktree)).out.trim();
    writeFileSync(join(wt.worktree, "mine.txt"), "slice work\n");
    await checkpoint(git, wt.worktree, "engineer turn");

    // Untouched branch: the recorded base is still a point on it.
    expect(await sliceDiffBase(git, wt.worktree, base)).toEqual({ base, scope: "slice" });

    // Another group lands on main, and this branch is rebased onto it (rule 15).
    // The base is `origin/main`: a clone's own `main` does not move when the
    // remote does, which is the whole reason rule 15 fetches first.
    writeFileSync(join(dir, "theirs.txt"), "somebody else\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-q", "-m", "other group"], dir);
    await git(["fetch", "-q", "origin"], wt.worktree);
    await rebaseOntoBase(git, wt.worktree, FALLBACKS);

    // The recorded base is now a commit on main, so diffing from it would call
    // `theirs.txt` part of this slice. Fall back to the fork point instead.
    const after = await sliceDiffBase(git, wt.worktree, base);
    expect(after?.scope).toBe("branch");
    const files = (await git(["diff", "--name-only", after!.base], wt.worktree)).out;
    expect(files).toContain("mine.txt");
    expect(files).not.toContain("theirs.txt");
  },
  GIT_IO,
);

test(
  "a repo with only AGENTS.md gets CLAUDE.md, and the other way round",
  () => {
    // Runs inside the checkout, in the container — this used to be a host
    // `symlinkSync` against `/work`, which does not exist here, so it silently did
    // nothing for every turn. The command itself is what is checked.
    const link = (dir: string) => Bun.spawnSync(["sh", "-c", LINK_AGENTS_MD], { cwd: dir });

    const dir = tempDir("orch-md-");
    writeFileSync(join(dir, "AGENTS.md"), "rules\n");
    link(dir);
    // A codex-native repo: a claude turn used to run with no project instructions
    // at all, which looks exactly like a project that has none.
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("rules\n");

    const other = tempDir("orch-md-");
    writeFileSync(join(other, "CLAUDE.md"), "rules\n");
    link(other);
    expect(readFileSync(join(other, "AGENTS.md"), "utf8")).toBe("rules\n");

    // A repo shipping both is left alone: it said what it wanted.
    const both = tempDir("orch-md-");
    writeFileSync(join(both, "CLAUDE.md"), "for claude\n");
    writeFileSync(join(both, "AGENTS.md"), "for codex\n");
    link(both);
    expect(readFileSync(join(both, "AGENTS.md"), "utf8")).toBe("for codex\n");
  },
  GIT_IO,
);

test.concurrent(
  "the base branch is a bare name, whatever the remote calls it",
  async () => {
    // The bug: this returned `origin/main` when `origin/HEAD` was set and `main`
    // when it was not, while four callers wrote `origin/${...}` around it. On any
    // ordinary clone they were asking git for `origin/origin/main`.
    const { dir: origin } = await checkout();
    await git(["branch", "-m", "main", "trunk"], origin);
    // Cloned after the rename, so `origin/HEAD` is what a real clone of this remote
    // would have. The fixture's own clone predates it and is not the subject here.
    const work = join(origin, "../renamed-work");
    await git(["clone", "-q", origin, work], origin);

    expect(await detectBaseBranch(git, work, FALLBACKS)).toBe("trunk");
    // Without origin/HEAD it has to ask the remote rather than guess main.
    await git(["update-ref", "-d", "refs/remotes/origin/HEAD"], work);
    expect(await detectBaseBranch(git, work, FALLBACKS)).toBe("trunk");
  },
  GIT_IO,
);

test.concurrent(
  "with no base branch to rebase onto, the caller is told that and not `ambiguous argument`",
  async () => {
    // Three helpers used to write `origin/${detectBaseBranch(..., FALLBACKS)}` and hand git a
    // ref they had never verified. In a clone with no remote — or one whose remote
    // has gone — that is `origin/main` against a repository that has no `origin`
    // at all, so the rebase fails deep inside git with a message about argument
    // parsing. `unpark` then shows the boss that message.
    const dir = tempDir("orch-nobase-");
    await git(["init", "-q", "-b", "solo"], dir);
    await git(["config", "user.email", "t@example.com"], dir);
    await git(["config", "user.name", "test"], dir);
    writeFileSync(join(dir, "a.txt"), "one\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-q", "-m", "one"], dir);

    expect(await baseRef(git, dir, FALLBACKS)).toBeNull();
    const r = await rebaseOntoBase(git, dir, FALLBACKS);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no base branch");
    // And the squash declines with a reason instead of committing onto nothing.
    expect((await squashWip(git, dir, "feat: x", FALLBACKS)).reason).toContain("no base branch");
  },
  GIT_IO,
);

test(
  "a renamed default branch is picked up rather than breaking every clone",
  async () => {
    // GitHub is the source, never host git: `repo_path` is `owner/name` and there
    // is no checkout on this machine to ask. The drift itself still has to be
    // caught — a default branch renamed on the remote leaves every clone, rebase
    // and diff resolving against a ref that is not there.
    const db = await openMemory();
    await fx.on(db).project.create({ name: "p", repo_path: "acme/p" });
    let branch = "main";
    const gh: Github = {
      remaining: () => null,
      request: async (_method, _path, schema) => ({
        ok: true,
        status: 200,
        data: schema.parse({ default_branch: branch, full_name: "acme/p" }),
      }),
    };
    const ctx = await testContext({ db, gh });

    // Resolved once, then stored: the diff baseline has to mean the same thing on
    // the day a slice was cut and the day the boss reads it.
    expect(await baseBranch(ctx, 1)).toBe("main");
    expect((await db.select({ b: project.base_branch }).from(project))[0]!.b).toBe("main");
    // Learning it the first time is not a change, so it is not announced.
    expect(await ctx.bus.since(0)).toEqual([]);

    branch = "mainline";
    expect(await baseBranch(ctx, 1)).toBe("mainline");
    expect((await ctx.bus.since(0)).map((event) => event.body).join(" ")).toContain("mainline");

    // GitHub unreachable keeps what is stored: resetting a project that develops
    // on `develop` to `main` because the network blinked would repoint every diff.
    const unavailable: Github = {
      remaining: () => null,
      request: async () => ({ ok: false, status: 0, bucket: "transient", message: "x" }),
    };
    const offline = await testContext({ ...ctx, gh: unavailable });
    expect(await baseBranch(offline, 1)).toBe("mainline");
  },
  GIT_IO,
);

test(
  "a repository renamed or moved to another org is followed, not left pointing at the old name",
  async () => {
    // Observed: the org renamed to lowercase and the panel kept showing the old
    // capitalisation, because nothing ever re-read the name. GitHub redirects
    // `GET /repos/old/name` — which is why everything kept working and nothing
    // said anything — but a POST to open a pull request does not survive a
    // redirect, and the old path only works until somebody claims the freed name.
    const db = await openMemory();
    await fx.on(db).project.create({ name: "p", repo_path: "Old-Org/p", remote: "https://github.com/Old-Org/p.git" });
    const gh: Github = {
      remaining: () => null,
      request: async (_method, _path, schema) => ({
        ok: true,
        status: 200,
        data: schema.parse({
          default_branch: "main",
          full_name: "new-org/p",
          clone_url: "https://github.com/new-org/p.git",
        }),
      }),
    };
    const ctx = await testContext({ db, gh });

    await baseBranch(ctx, 1);
    const [row] = await db.select({ p: project.repo_path, r: project.remote }).from(project);
    expect(row!.p).toBe("new-org/p");
    // The remote too, or the clone still fetches by the old URL.
    expect(row!.r).toBe("https://github.com/new-org/p.git");
    expect((await ctx.bus.since(0)).map((event) => event.body).join(" ")).toContain("new-org/p");
  },
  GIT_IO,
);
