import { expect, test } from "bun:test";
import type { Ctx } from "../src/api.ts";
import { Bus } from "../src/bus.ts";
import { openMemory } from "../src/db.ts";
import { listTree } from "../src/mech/git/checkout.ts";
import { fakeSandbox } from "./fake-sandbox.ts";

/**
 * The bare mirror the repo map and the DRAFT path check are read from.
 *
 * Verified against a real `git clone --bare` before writing this: such a
 * repository has `refs/heads/main` and no `refs/remotes/` at all, and it is
 * created with *no* `remote.origin.fetch` refspec — `--mirror` writes one,
 * `--bare` does not.
 */
const ctxWith = (run: (cmd: string) => { out?: string; code?: number }) => {
  const db = openMemory();
  const sandbox = fakeSandbox(run);
  return { db, bus: new Bus(db), sandbox, config: { language: "中文" } } as unknown as Ctx;
};

test("the mirror is never asked for a ref a bare repository cannot have", async () => {
  // `baseRefFor` builds `origin/main`, which is right for a worktree — there it
  // is the remote-tracking ref. Against the mirror it produced
  //   git ls-tree origin/main exited 128: fatal: Not a valid object name origin/main
  // once a tick, forever, and the repo map never refreshed again.
  const seen: string[] = [];
  const ctx = ctxWith((cmd) => {
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
  const ctx = ctxWith((cmd) => {
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
  const ctx = ctxWith((cmd) => {
    if (cmd.includes("test -d")) return { out: "yes" };
    if (cmd.includes(" fetch ")) return { code: 128, out: "could not resolve host" };
    if (cmd.includes("ls-tree")) return { out: "src/a.ts" };
    return {};
  });
  expect((await listTree(ctx, "git@github.com:o/p.git", "main")).files).toEqual(["src/a.ts"]);
});
