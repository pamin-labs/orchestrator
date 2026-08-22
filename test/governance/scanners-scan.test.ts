import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/**
 * Every pattern a guard scans with matches something.
 *
 * `{src,test}/**\/*.{ts,tsx}` matches nothing in Bun — brace expansion in the
 * directory and the extension at once silently yields an empty list — and a
 * scanner over no files is a test that passes for ever while guarding nothing.
 * One of ours was already doing it. This checks the patterns themselves, so the
 * failure mode cannot come back through a different guard.
 */
/**
 * `new Bun.Glob(` as well as `new Glob(`. Both spellings are in this tree — 14
 * files import `Glob` from `bun`, 18 reach it through the global — and the
 * pattern only knew the first. The nine guards PR #9 added all use the second,
 * so the one test whose job is "no guard scans nothing" could see none of them:
 * five of ten literal patterns were invisible, and `toBeGreaterThan(3)` passed
 * on the other five.
 */
test("no guard scans with a pattern that matches nothing", () => {
  const patterns = new Set<string>();
  for (const path of new Glob("test/**/*.ts").scanSync(".")) {
    if (path.endsWith("scanners-scan.test.ts")) continue;
    for (const hit of readFileSync(path, "utf8").matchAll(/new (?:Bun\.)?Glob\((["'`])([^"'`]+)\1\)/g)) {
      // Only the literal ones. A pattern built from a variable is the caller's.
      if (hit[2]) patterns.add(hit[2]);
    }
  }
  expect(patterns.size).toBeGreaterThan(8);
  const empty = [...patterns].filter((p) => [...new Glob(p).scanSync(".")].length === 0);
  expect(empty).toEqual([]);
});
