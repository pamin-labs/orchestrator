import { expect, test } from "bun:test";

/**
 * The page's width does not change when a dialog opens.
 *
 * A one-line CSS rule with a bug behind it, which is why it has a test: it looks
 * like decoration and reads like something a tidy-up would remove.
 */
/**
 * Radix locks body scroll while a dialog is open. Without a reserved gutter that
 * takes the scrollbar's column away and hands it to the content, so every element
 * measured by a `ResizeObserver` re-lays out — on `Time` that is both charts at once,
 * which is what 「打开设置闪一下」 was. The charts are not at fault; they are responding
 * to a width that genuinely changed.
 */
test("the scrollbar keeps its column whether or not it is there", async () => {
  const css = await Bun.file("web/style.css").text();
  expect(css).toContain("scrollbar-gutter: stable");
});
