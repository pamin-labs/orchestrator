import { expect, test } from "bun:test";
import { discriminate, isTestPath } from "../../src/mech/flow/discriminate.ts";
import type { GitRunner } from "../../src/mech/git/gitops.ts";

/**
 * A repository as this check sees one: what git answers, and what the tests do.
 *
 * No container and no filesystem — the subject is which commands are issued and
 * what is concluded from their exit codes, and both are decidable from here.
 */
function fake(opts: { dirty?: boolean; atBase?: string[]; testExit?: number; onTest?: () => void }) {
  const issued: string[][] = [];
  const git: GitRunner = async (argv) => {
    issued.push(argv);
    if (argv[0] === "status") return { code: 0, out: opts.dirty ? "M x.ts\0" : "" };
    if (argv[0] === "ls-tree") return { code: 0, out: (opts.atBase ?? []).join("\0") };
    return { code: 0, out: "" };
  };
  const runTest = async () => {
    opts.onTest?.();
    issued.push(["<test gate>"]);
    return opts.testExit ?? 1;
  };
  return { git, runTest, issued, wrote: () => issued.filter((a) => ["checkout", "rm"].includes(a[0] ?? "")) };
}

const base = "aaaa";

test("the paths that hold tests, in the languages this has to work in", () => {
  for (const p of [
    "test/x.ts",
    "tests/x.py",
    "spec/models/user_spec.rb",
    "src/__tests__/a.tsx",
    "src/test/java/AppTest.java",
    "internal/server_test.go",
    "tests/test_parser.py",
    "lib/AuthTests.cs",
    "web/src/x.spec.ts",
  ])
    expect({ path: p, test: isTestPath(p) }).toEqual({ path: p, test: true });
  for (const p of ["src/x.ts", "lib/protest.go", "src/contest.py", "docs/testing.md"])
    expect({ path: p, test: isTestPath(p) }).toEqual({ path: p, test: false });
});

test("a slice that changed no test, or no source, is not a question this can answer", async () => {
  const only = fake({});
  expect(await discriminate({ ...only, worktree: "/work", baseSha: base, changed: ["src/a.ts", "src/b.ts"] })).toEqual({
    ran: false,
    why: "no test file changed",
  });
  expect(await discriminate({ ...only, worktree: "/work", baseSha: base, changed: ["test/a.test.ts"] })).toEqual({
    ran: false,
    why: "no source file changed",
  });
  // Neither case reached git at all, so neither could have touched the worktree.
  expect(only.wrote()).toEqual([]);
});

/**
 * The one line that must not be wrong. Every step restores from a git object, so
 * work that is not in one is work this would destroy.
 */
test("uncommitted work stops the check before it writes anything", async () => {
  const f = fake({ dirty: true });
  expect(
    await discriminate({ ...f, worktree: "/work", baseSha: base, changed: ["src/a.ts", "test/a.test.ts"] }),
  ).toEqual({ ran: false, why: "uncommitted work in the worktree" });
  expect(f.wrote()).toEqual([]);
});

test("tests that fail without the slice's source are tests that discriminate", async () => {
  const f = fake({ atBase: ["src/a.ts"], testExit: 1 });
  expect(
    await discriminate({ ...f, worktree: "/work", baseSha: base, changed: ["src/a.ts", "test/a.test.ts"] }),
  ).toEqual({ ran: true, discriminates: true });
});

test("tests that still pass without it distinguish nothing", async () => {
  const f = fake({ atBase: ["src/a.ts"], testExit: 0 });
  expect(
    await discriminate({ ...f, worktree: "/work", baseSha: base, changed: ["src/a.ts", "test/a.test.ts"] }),
  ).toEqual({ ran: true, discriminates: false });
});

/**
 * A slice that adds a module cannot be undone by `git checkout <base>` — the file
 * is not in that tree. Leave it and the tests written for it still pass, so the
 * check reports "distinguishes nothing" about a slice that distinguishes fine.
 */
test("a file this slice added is removed, not left standing", async () => {
  const f = fake({ atBase: ["src/old.ts"], testExit: 0 });
  await discriminate({
    ...f,
    worktree: "/work",
    baseSha: base,
    changed: ["src/old.ts", "src/new.ts", "test/new.test.ts"],
  });
  expect(f.issued).toContainEqual(["checkout", base, "--", "src/old.ts"]);
  expect(f.issued).toContainEqual(["rm", "-f", "-q", "--", "src/new.ts"]);
  // And both come back from HEAD, which writes the index and the worktree — the
  // removed file included.
  expect(f.issued.at(-1)).toEqual(["checkout", "HEAD", "--", "src/old.ts", "src/new.ts"]);
});

test("the worktree is restored even when the gate throws", async () => {
  const f = fake({
    atBase: ["src/a.ts"],
    onTest: () => {
      throw new Error("the sandbox died");
    },
  });
  expect(
    await discriminate({ ...f, worktree: "/work", baseSha: base, changed: ["src/a.ts", "test/a.test.ts"] }),
  ).toEqual({ ran: false, why: "the sandbox died" });
  expect(f.issued.at(-1)).toEqual(["checkout", "HEAD", "--", "src/a.ts"]);
});
