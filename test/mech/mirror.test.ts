import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { listTree, pushBranch } from "../../src/mech/git/checkout.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";
import * as fx from "../support/factories.ts";

/**
 * The bare mirror the repo map and the DRAFT path check are read from.
 *
 * Verified against a real `git clone --bare` before writing this: such a
 * repository has `refs/heads/main` and no `refs/remotes/` at all, and it is
 * created with *no* `remote.origin.fetch` refspec — `--mirror` writes one,
 * `--bare` does not.
 */
const ctxWith = async (run: (cmd: string) => { out?: string; code?: number }) => {
  const db = await openMemory();
  const sandbox = fakeSandbox(run);
  return testContext({ db, sandbox });
};

test("the mirror is never asked for a ref a bare repository cannot have", async () => {
  // `baseRefFor` builds `origin/main`, which is right for a worktree — there it
  // is the remote-tracking ref. Against the mirror it produced
  //   git ls-tree origin/main exited 128: fatal: Not a valid object name origin/main
  // once a tick, forever, and the repo map never refreshed again.
  const seen: string[] = [];
  const ctx = await ctxWith((cmd) => {
    seen.push(cmd);
    if (cmd.includes("test -d")) return { out: "yes" };
    if (cmd.includes("ls-tree")) return { out: "src/a.ts\nREADME.md" };
    return {};
  });
  const r = await listTree(ctx, "git@github.com:o/p.git", "origin/main");
  expect(r.files).toEqual(["src/a.ts", "README.md"]);
  const lsTree = seen.find((c) => c.includes("ls-tree"))!;
  expect(lsTree).toContain("'main'");
  expect(lsTree).not.toContain("origin/main");
});

test("an existing mirror is fetched, or every answer describes the day it was cloned", async () => {
  // `git clone --bare` writes no fetch refspec, so this was not "the mirror goes
  // stale slowly" — nothing could ever update it. A DRAFT card naming a file
  // added after the first clone came back "not in the repo", permanently, on a
  // project that had been working.
  const seen: string[] = [];
  const ctx = await ctxWith((cmd) => {
    seen.push(cmd);
    if (cmd.includes("test -d")) return { out: "yes" };
    return { out: "" };
  });
  await listTree(ctx, "git@github.com:o/p.git", "main");
  const fetch = seen.find((c) => c.includes(" fetch "));
  expect(fetch).toBeDefined();
  // The refspec has to be explicit; a bare clone has none of its own.
  expect(fetch).toContain("+refs/heads/*:refs/heads/*");
  // And pruned, or a branch deleted on the remote is one this keeps offering.
  expect(fetch).toContain("--prune");
});

test("a mirror that cannot be reached is stale, not empty-because-broken", async () => {
  // Best effort: refusing on a failed fetch would turn one unreachable network
  // into "this repository has no files", which is the answer the caller reports
  // to the boss.
  const ctx = await ctxWith((cmd) => {
    if (cmd.includes("test -d")) return { out: "yes" };
    if (cmd.includes(" fetch ")) return { code: 128, out: "could not resolve host" };
    if (cmd.includes("ls-tree")) return { out: "src/a.ts" };
    return {};
  });
  expect((await listTree(ctx, "git@github.com:o/p.git", "main")).files).toEqual(["src/a.ts"]);
});

test("a work-in-progress branch is kept where prune cannot delete it", async () => {
  // `ensureMirror` runs `fetch --prune origin '+refs/heads/*:refs/heads/*'`, and
  // prune deletes by the *destination* of the refspec, not by "remote-tracking".
  // Measured against a real bare clone: a local-only `refs/heads/orch/foo` is
  // reported `- [deleted] (none) -> orch/foo` and is gone. `push()` calls
  // `ensureMirror` a second time after the bundle landed, so the branch it was
  // about to push was pruned first and the push failed with
  // `src refspec ... does not match any` — every group's first push.
  //
  // So the bundle lands under `refs/orch/*`, which that refspec does not own,
  // and `refs/heads/*` keeps mirroring the remote for `listTree`.
  const cmds: string[] = [];
  const sandbox = fakeSandbox((cmd) => {
    cmds.push(cmd);
    if (cmd.includes("test -d")) return { out: "yes" };
    return {};
  });
  const ctx = await testContext({ sandbox });
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p", remote: "git@github.com:o/p.git" });
  const g = await f.grp.create({ project_id: p.id, name: "g1", branch: "orch/g1" });

  const r = await pushBranch(ctx, g.id);
  expect(r.ok).toBe(true);

  const fetched = cmds.find((c) => c.includes(".bundle") && c.includes("fetch"))!;
  expect(fetched).toContain("refs/orch/orch/g1");
  const pushed = cmds.find((c) => c.includes("push"))!;
  expect(pushed).toContain("refs/orch/orch/g1:refs/heads/orch/g1");
});
