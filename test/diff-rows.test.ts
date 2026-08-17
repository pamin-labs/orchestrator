import { expect, test } from "bun:test";
import parseDiff from "parse-diff";
import { rowsOf, gapLabel, gutterProps, sideProps } from "../web/src/ui/diff.tsx";

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

test("each side of a row earns its own gutter, tone and cell", () => {
  // The row used to compute these inline, four conditional spreads a side; the
  // logic is pure, so it lives next to rowsOf and is tested the same way.
  const edited = { left: { n: 1, text: "old", changed: true }, right: { n: 1, text: "new", changed: true } };
  expect(gutterProps(edited, "left")).toEqual({ n: 1, tone: "bad" });
  expect(gutterProps(edited, "right")).toEqual({ n: 1, tone: "ok" });
  expect(sideProps(edited, "left")).toEqual({ cell: edited.left, other: edited.right });

  // An orphan line is toned on its own side and silent on the other: a deletion
  // marks the left gutter but leaves the right one blank, not red.
  const deleted = { left: { n: 2, text: "gone" } };
  expect(gutterProps(deleted, "left")).toEqual({ n: 2, tone: "bad" });
  expect(gutterProps(deleted, "right")).toEqual({});
  expect(sideProps(deleted, "right")).toEqual({ other: deleted.left });

  // An untouched pair gets line numbers and no wash.
  const same = { left: { n: 3, text: "x" }, right: { n: 3, text: "x" } };
  expect(gutterProps(same, "left")).toEqual({ n: 3 });
  expect(gutterProps(same, "right")).toEqual({ n: 3 });
});

test("a hunk boundary reads as its context, or as an ellipsis", () => {
  expect(gapLabel("@@ -1,3 +1,4 @@ function x(")).toBe("function x(");
  expect(gapLabel("@@ -5,2 +5,2 @@")).toBe("…");
});
