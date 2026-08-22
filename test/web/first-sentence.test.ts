import { expect, test } from "bun:test";
import { brief } from "../../web/src/shared/prose.ts";
import { firstSentence } from "../../src/contracts/sentence.ts";

/**
 * The queue row's whole job is naming which question to open.
 *
 * Both sides derived it by cutting at `[\n。.!?！？]` — every full stop, so a
 * version number and an abbreviation each ended it. The server's copy was fixed
 * and the panel's was not, which is why there is one function now: the panel
 * draws this for every escalation stored before the `brief` column existed, and
 * those are the rows in the queue today.
 */
test("a version and an abbreviation are not the end of a sentence", () => {
  expect(brief("playwright 1.62.1 is missing from the sandbox image")).toBe(
    "playwright 1.62.1 is missing from the sandb…",
  );
  expect(brief("e.g. the gate is red, what now?")).toBe("e.g. the gate is red, what now");
  expect(brief("Node v22.3.0 vs 20.11.1 mismatch")).toBe("Node v22.3.0 vs 20.11.1 mismatch");
});

test("the breaks it did get right still break", () => {
  expect(brief("予算を上げますか。残りは後で")).toBe("予算を上げますか");
  expect(brief("budget?\nthe rest can wait")).toBe("budget");
});

/**
 * `slice` counts UTF-16 code units, so a cut landing inside an astral character
 * ends the string on a lone surrogate — which renders as `�` in the one row a
 * reader is scanning. `Intl.Segmenter` at grapheme granularity cuts where a
 * reader would.
 */
test("a cut never lands inside a character", () => {
  // 42 filler characters, so the cut at 43 lands *inside* the emoji: `slice`
  // returned `…a\ud83d…` and the row showed a replacement character. Measured
  // against the old expression, which does not survive a UTF-8 round trip.
  const cut = firstSentence(`${"a".repeat(42)}👍 and more`, 44);
  expect(cut).toEndWith("…");
  // A round trip through UTF-8 is what makes a lone surrogate visible: it has no
  // encoding, so it comes back as U+FFFD. Asserting on the characters directly
  // would mean spreading the string, which is the same mistake one layer up.
  const encoded = new TextDecoder().decode(new TextEncoder().encode(cut));
  expect(encoded).toBe(cut);
});
