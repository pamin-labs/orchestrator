import { expect, test } from "bun:test";
import parseDiff from "parse-diff";
import { rowsOf } from "../web/src/ui/diff.tsx";

/**
 * The side-by-side viewer is what the boss reads before accepting a slice, so a
 * row it invents is a row somebody approves.
 */

const chunks = (body: string) => parseDiff(`--- a/a.txt\n+++ b/a.txt\n${body}`)[0]!.chunks;

test("a file with no trailing newline does not grow a line of source", () => {
  // `parse-diff` carries `\ No newline at end of file` by cloning the change
  // before it — same `type`, same `ln` — so the marker used to arrive as a
  // second del and a second add, equal counts, paired, and rendered as a changed
  // row reading " No newline at end of file" on both sides at line 3.
  const rows = rowsOf(
    chunks(
      "@@ -1,3 +1,3 @@\n one\n two\n-three\n\\ No newline at end of file\n+four\n\\ No newline at end of file\n",
    )[0]!,
  );
  expect(rows.map((r) => [r.left?.text, r.right?.text])).toEqual([
    ["one", "one"],
    ["two", "two"],
    ["three", "four"],
  ]);
});

test("a real edit still pairs, and an unrelated insert still does not", () => {
  const edit = rowsOf(chunks("@@ -1,2 +1,2 @@\n keep\n-old\n+new\n")[0]!);
  expect(edit.at(-1)).toEqual({
    left: { n: 2, text: "old", changed: true },
    right: { n: 2, text: "new", changed: true },
  });

  // Two additions against one deletion is not an edit of that line, so neither
  // side gets word-level marks.
  const insert = rowsOf(chunks("@@ -1,2 +1,3 @@\n keep\n-old\n+a\n+b\n")[0]!);
  expect(insert.at(-1)?.right?.changed).toBe(false);
});
