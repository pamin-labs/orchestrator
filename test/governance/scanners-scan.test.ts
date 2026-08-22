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
 * Three spellings, because this tree has three. `new Glob(` was the only one it
 * knew; the nine guards PR #9 added all write `new Bun.Glob(`, so five of ten
 * literal patterns were invisible and `toBeGreaterThan(3)` passed on the other
 * five. `scan(` is `test/support/ast.ts`'s helper, which is where seven of those
 * guards keep their pattern now — a guard whose pattern only ever appears as its
 * argument would be invisible again.
 */
test("no guard scans with a pattern that matches nothing", () => {
  const patterns = new Set<string>();
  for (const path of new Glob("test/**/*.ts").scanSync(".")) {
    if (path.endsWith("scanners-scan.test.ts")) continue;
    for (const hit of readFileSync(path, "utf8").matchAll(/(?:new (?:Bun\.)?Glob|\bscan)\((["'`])([^"'`]+)\1/g)) {
      // Only the literal ones. A pattern built from a variable is the caller's.
      if (hit[2]) patterns.add(hit[2]);
    }
  }
  expect(patterns.size).toBeGreaterThan(8);
  const empty = [...patterns].filter((p) => [...new Glob(p).scanSync(".")].length === 0);
  expect(empty).toEqual([]);
});
