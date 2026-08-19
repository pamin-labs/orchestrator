import { expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * No block comment is longer than eight lines.
 *
 * `docs/standards/documentation.md` carries the rule and why it is this rule rather
 * than a percentage: chasing 24% down to 12% meant deleting the traps — which is the
 * category that page exists to keep — while block length is checkable and says
 * something true when it fails.
 */
/**
 * A block over eight lines is one of two things, and both have a better home. It is
 * prose that belongs in a commit or an ADR, where somebody asking "why is this like
 * this" will look; or it is a name the code wants, and splitting it puts each
 * paragraph on the declaration a reader is editing when they need it.
 *
 * Measured while the rule was being applied: 277 blocks were over, in 180 files, and
 * every one came down without losing an invariant.
 */
const LIMIT = 8;

/**
 * Lines between the opener and the closer, or 0 when they are the same line.
 *
 * The `Math.max` is not defensive: a one-line `/* … *\/` closes on the line it
 * opened, which made the naive subtraction −1 and the caller's `i += body` a loop
 * that never advanced.
 */
const bodyLines = (lines: string[], open: number): number => {
  let close = open;
  while (close < lines.length && !lines[close]!.includes("*/")) close++;
  return Math.max(0, close - open - 1);
};

test("no block comment has more than eight lines of body", async () => {
  const long: string[] = [];
  for (const dir of ["src", "web/src", "test", "scripts"]) {
    for await (const rel of new Glob("**/*.{ts,tsx}").scan(dir)) {
      const path = `${dir}/${rel}`;
      const lines = (await Bun.file(path).text()).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.trimStart().startsWith("/*")) continue;
        const body = bodyLines(lines, i);
        // The paths, not a count: the fix is to split or trim exactly these.
        if (body > LIMIT) long.push(`${path}:${i + 1} (${body} lines)`);
        i += body;
      }
    }
  }
  expect(long).toEqual([]);
});
