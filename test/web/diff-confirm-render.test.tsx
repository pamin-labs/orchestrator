import { afterEach, expect, test } from "bun:test";
import { cleanup, render, valueOf } from "../support/render.tsx";
import * as Dialog from "@radix-ui/react-dialog";
import { markSpans, sideTone } from "../../web/src/features/diff/model.ts";
import { DiffView } from "../../web/src/features/diff/view.tsx";
import { AskCard } from "../../web/src/ui/confirm.tsx";

/**
 * testing-library's own `afterEach(cleanup)` is registered when its module is
 * evaluated, and `bun test` scopes the lifecycle globals per file — so that hook
 * belongs to whichever file imported it first, and every later file kept the
 * previous one's nodes in `document.body`. Each file registers its own.
 */
afterEach(cleanup);

/**
 * The two surfaces the boss uses to accept work: the diff they read, and the
 * dialog they answer. Neither had a render test, so a cell that showed the wrong
 * text and a button that carried the wrong consequence both looked fine.
 */

const unified = (body: string) => `--- a/one.txt\n+++ b/one.txt\n${body}`;

/** The text of every prose cell, in reading order: old side, new side, per row. */
const cellText = (root: HTMLElement) =>
  [...root.querySelectorAll("td.whitespace-pre-wrap")].map((td) => td.textContent);

test("an edited line renders the old text left and the new text right", () => {
  // The word diff runs old to new. Reading it in cell order made the right pane
  // diff new against old, drop the added words and keep the removed ones, so an
  // edit rendered "foo baz" on both sides — the change the reader is accepting
  // was never on screen.
  const { container } = render(<DiffView diff={unified("@@ -1,2 +1,2 @@\n keep\n-foo baz\n+foo bar\n")} />);
  expect(cellText(container)).toEqual(["keep", "keep", "foo baz", "foo bar"]);
  // Which words moved is `markSpans`, asserted on its own below; the pane each
  // one lands in is what this test is for.
});

test("a deletion tints only its own side and leaves the other a hole", () => {
  const { container, getAllByText } = render(<DiffView diff={unified("@@ -1,2 +1,1 @@\n keep\n-gone\n")} />);
  // The removed line is on the old side and the facing cell is empty, not a
  // repeat of the line above it.
  expect(cellText(container)).toEqual(["keep", "keep", "gone", ""]);
  // The wash is the only thing telling the two apart, so it is checked on the
  // two cells themselves rather than anywhere in the document: the empty half of
  // an orphan row is sunk, not tinted green.
  const cells = [...container.querySelectorAll("td.whitespace-pre-wrap")].map((td) => td.className);
  expect(cells[2]).toContain("bg-bad-soft");
  expect(cells[3]).not.toContain("bg-ok-soft");
  // The rail counts the change and names the file — once in the file list it
  // scrolls, and once on the file's own header.
  expect(getAllByText("one.txt")).toHaveLength(2);
  expect(getAllByText("−1")).toHaveLength(2);
});

test("a diff of nothing renders nothing, and a truncated one says so", () => {
  expect(render(<DiffView diff="" />).container.innerHTML).toBe("");
  const cut = render(<DiffView diff={unified("@@ -1 +1 @@\n-a\n+b\n")} truncated />);
  cut.getByText(/改动超过 400k 字符/);
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
  render(
    <Dialog.Root open>
      <AskCard spec={spec} text="写好的理由" onText={() => {}} onDone={() => {}} />
    </Dialog.Root>,
  );

test("a plain confirmation shows both ways out and defaults to the safe wording", () => {
  const { getByRole, getByText } = card({ title: "确定要作废吗", body: "作废之后不能撤销" });
  // A dialog, announced as one, named by its own title — none of which a server
  // render could show, because Radix mounts the whole card through a portal.
  const dialog = getByRole("dialog");
  getByRole("heading", { name: "确定要作废吗" });
  expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  getByText("作废之后不能撤销");
  // Cancel is always present: the dialog is never a one-button dead end.
  getByRole("button", { name: "取消" });
  getByRole("button", { name: "确定" });
});

test("a destructive confirmation still asks, and says what it will do", () => {
  const { getAllByRole, getByRole } = card({ title: "删除项目", yes: "删除", danger: true });
  getByRole("heading", { name: "删除项目" });
  // Danger is carried by the confirm button, not by removing a step: cancel is
  // still there, still first, and only the button after it wears the danger skin.
  const buttons = getAllByRole("button").filter((b) => ["取消", "删除"].includes(b.textContent ?? ""));
  expect(buttons.map((b) => b.textContent)).toEqual(["取消", "删除"]);
  expect(buttons[1]?.className).toContain("bg-bad");
  expect(buttons[0]?.className).not.toContain("bg-bad");
});

test("a question with a field carries the typed answer, not a bare yes", () => {
  const { getByRole } = card({ title: "为什么要打回", field: "写一句理由" });
  const box = getByRole("textbox");
  expect(box.getAttribute("placeholder")).toBe("写一句理由");
  expect(valueOf(box)).toBe("写好的理由");
});
