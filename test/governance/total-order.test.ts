import { expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * No query is ordered by a clock alone.
 *
 * A millisecond is not an ordering key. Two rows written in the same one — a
 * parent span and the child it opens, a loop that files four lessons, a card
 * and the objection that answers it — compare equal, and which one SQLite
 * returns first is up to the storage engine. The consequences seen on this
 * branch, in one week:
 *
 *   - `lateObjections` used `e.at > max(n.at)` and dropped an objection filed
 *     in the card's own millisecond, which is the exact failure that clause
 *     exists to prevent.
 *   - `checkout-spans` ordered two spans by `started_at` and failed one run in
 *     ten with them transposed, taking a CI job down with it.
 *   - `prwatch` read `rows[0]` from a list ordered by `at` and asserted on it.
 *
 * The first was a product defect and the other two were tests. All three had
 * the same shape, so this guards the shape rather than the three instances: a
 * sort whose last key is a timestamp needs a tiebreak that is a total order —
 * `id`, `seq`, `rowid`, `span_id` — or a stated reason it does not.
 *
 * **Not solved with a fake clock**, deliberately. Freezing time would stop the
 * tests colliding, which is the same as stopping them from finding the product
 * defect: same-millisecond writes happen in production whether or not a test
 * can produce one. The answer is a query that does not care, not a test that
 * cannot notice.
 */

/** Columns that carry a wall-clock reading, and therefore do not order anything on their own. */
const CLOCK = /\b(?:at|started_at|created_at|updated_at|answered_at|last_seen_at|expires_at)$/;

/** What makes an order total: a monotonic identifier, not a second clock. */
const TOTAL = /\b(?:id|seq|rowid|span_id|oid)\b/;

/**
 * The escape hatch, with its reason attached.
 *
 * On the `ORDER BY` line or within three lines above it. Ordering really is
 * arbitrary in
 * some places — a set the caller reduces, a scan whose only job is to visit
 * every row — and saying so is cheaper than inventing a tiebreak nobody reads.
 */
const EXEMPT = /any-order:/;

interface Finding {
  file: string;
  line: number;
  clause: string;
}

function scan(source: string, file: string): Finding[] {
  const lines = source.split("\n");
  const found: Finding[] = [];
  for (const [index, line] of lines.entries()) {
    // Prose first: this rule is discussed in comments, including in this file's
    // own header, and a guard that flags the sentence explaining it is a guard
    // nobody can satisfy.
    if (/^\s*(?:\/\/|\*|--)/.test(line)) continue;
    const match = /ORDER BY\s+([^`"';]*)/i.exec(line);
    if (!match) continue;
    // The marker may sit up to three lines above, because a reason worth
    // writing rarely fits on one and the sort is usually the last line of the
    // clause it belongs to.
    if (lines.slice(Math.max(0, index - 3), index + 1).some((near) => EXEMPT.test(near))) continue;
    // Everything up to the clause that ends the sort: what follows never affects
    // which rows tie.
    const clause = match[1]!.split(/\bLIMIT\b|\bOFFSET\b|\)/i)[0]!.trim();
    if (!clause) continue;
    const keys = clause.split(",").map((key) => key.trim());
    const last = keys.at(-1) ?? "";
    // The last key is the one that breaks ties; earlier ones have already been
    // compared. A clock there means equal timestamps are returned in whatever
    // order the storage engine likes.
    const column = last.replace(/\s+(?:ASC|DESC)$/i, "").trim();
    if (!CLOCK.test(column)) continue;
    if (keys.some((key) => TOTAL.test(key))) continue;
    found.push({ file, line: index + 1, clause });
  }
  return found;
}

test("a sort whose last key is a timestamp carries a tiebreak or a reason", async () => {
  const findings: Finding[] = [];
  for (const dir of ["src", "test", "scripts"]) {
    for (const path of new Glob("**/*.{ts,tsx}").scanSync({ cwd: dir })) {
      const file = `${dir}/${path}`;
      if (file === "test/governance/total-order.test.ts") continue;
      findings.push(...scan(await Bun.file(file).text(), file));
    }
  }
  // Listed rather than counted: the fix is per site, and a number tells whoever
  // hits this nothing about which query to look at.
  expect(findings.map((f) => `${f.file}:${f.line}  ORDER BY ${f.clause}`)).toEqual([]);
});
