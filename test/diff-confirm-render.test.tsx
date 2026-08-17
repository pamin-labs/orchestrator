import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Dialog from "@radix-ui/react-dialog";
import { markSpans, sideTone } from "../web/src/features/diff/model.ts";
import { DiffView } from "../web/src/ui/diff.tsx";
import { AskCard } from "../web/src/ui/confirm.tsx";

/**
 * The two surfaces the boss uses to accept work: the diff they read, and the
 * dialog they answer. Neither had a render test, so a cell that showed the wrong
 * text and a button that carried the wrong consequence both looked fine.
 */

const unified = (body: string) => `--- a/one.txt\n+++ b/one.txt\n${body}`;

test("an edited line renders the old text left and the new text right", () => {
  // The word diff runs old to new. Reading it in cell order made the right pane
  // diff new against old, drop the added words and keep the removed ones, so an
  // edit rendered "foo baz" on both sides — the change the reader is accepting
  // was never on screen.
  const html = renderToStaticMarkup(<DiffView diff={unified("@@ -1,2 +1,2 @@\n keep\n-foo baz\n+foo bar\n")} />);
  const cells = [...html.matchAll(/<td class="whitespace-pre-wrap[^"]*"[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!);
  expect(cells).toEqual([
    "keep",
    "keep",
    '<span class="">foo </span><span class="bg-bad-mark">baz</span>',
    '<span class="">foo </span><span class="bg-ok-mark">bar</span>',
  ]);
});

test("a deletion tints only its own side and leaves the other a hole", () => {
  const html = renderToStaticMarkup(<DiffView diff={unified("@@ -1,2 +1,1 @@\n keep\n-gone\n")} />);
  expect(html).toContain(">gone</td>");
  // The empty half of an orphan row is sunk, not tinted green.
  expect(html).toContain("bg-bad-soft");
  expect(html).not.toContain("bg-ok-soft");
  // The rail counts the change and names the file.
  expect(html).toContain("one.txt");
  expect(html).toContain("−1");
});

test("a diff of nothing renders nothing, and a truncated one says so", () => {
  expect(renderToStaticMarkup(<DiffView diff="" />)).toBe("");
  expect(renderToStaticMarkup(<DiffView diff={unified("@@ -1 +1 @@\n-a\n+b\n")} truncated />)).toContain(
    "改动超过 400k 字符",
  );
});

test("a cell earns a wash only for the side that changed", () => {
  const old = { n: 1, text: "old", changed: true };
  const now = { n: 1, text: "new", changed: true };
  expect(sideTone("left", old, now)).toBe("left");
  expect(sideTone("right", now, old)).toBe("right");
  // An orphan is tinted on its own side; the facing hole is empty, not "same".
  expect(sideTone("left", old, undefined)).toBe("left");
  expect(sideTone("right", undefined, old)).toBe("empty");
  // An untouched pair gets no wash at all.
  expect(sideTone("left", { n: 2, text: "x" }, { n: 2, text: "x" })).toBe("same");
});

test("only the words that moved are marked, and whitespace survives", () => {
  expect(markSpans("  a b", "  a c", "left")).toEqual([
    { key: "0:  a ", text: "  a ", marked: false },
    { key: "4:b", text: "b", marked: true },
  ]);
  expect(markSpans("  a c", "  a b", "right")).toEqual([
    { key: "0:  a ", text: "  a ", marked: false },
    { key: "4:c", text: "c", marked: true },
  ]);
});

const card = (spec: Parameters<typeof AskCard>[0]["spec"]) =>
  renderToStaticMarkup(
    <Dialog.Root open>
      <AskCard spec={spec} text="写好的理由" onText={() => {}} onDone={() => {}} />
    </Dialog.Root>,
  );

test("a plain confirmation shows both ways out and defaults to the safe wording", () => {
  const html = card({ title: "确定要作废吗", body: "作废之后不能撤销" });
  expect(html).toContain("确定要作废吗");
  expect(html).toContain("作废之后不能撤销");
  // Cancel is always present: the dialog is never a one-button dead end.
  expect(html).toContain("取消");
  expect(html).toContain("确定");
});

test("a destructive confirmation still asks, and says what it will do", () => {
  const html = card({ title: "删除项目", yes: "删除", danger: true });
  expect(html).toContain("删除项目");
  expect(html).toContain("取消");
  expect(html).toContain("删除");
  // Danger is carried by the confirm button, not by removing a step: cancel is
  // still rendered first, and only the button after it wears the danger skin.
  expect(html).toMatch(/取消[\s\S]*border-bad bg-bad[\s\S]*删除/);
});

test("a question with a field carries the typed answer, not a bare yes", () => {
  const html = card({ title: "为什么要打回", field: "写一句理由" });
  expect(html).toContain("写一句理由");
  expect(html).toContain("写好的理由");
  expect(html).toContain("<textarea");
});
