import { expect, test } from "bun:test";
import { cosine, crossesLanguages } from "../../scripts/embedding-check.ts";

/**
 * ADR 031's condition, checked without a model.
 *
 * The decision it gates is "is the cross-language gap closed", and the sentence
 * is easy to get backwards: comparing the relevant passage against the *wrong
 * one in the other language* is the comparison that always passes, and it would
 * report the refusal as met. The numbers below are the ADR's own — a question in
 * Chinese, the right Chinese passage first, the wrong Chinese passage second, and
 * the right English passage third, which is the failure it recorded.
 */
const scored = [
  { id: "中-沙盒", lang: "zh", topic: "sandbox", score: 0.899 },
  { id: "中-迁移", lang: "zh", topic: "migration", score: 0.845 },
  { id: "英-沙盒", lang: "en", topic: "sandbox", score: 0.764 },
];

test("the recorded failure is read as a failure", () => {
  // 英-沙盒 (0.764) against 中-迁移 (0.845): the relevant other-language passage
  // loses to the irrelevant same-language one, which is what ADR 031 measured.
  expect(crossesLanguages(scored, { lang: "zh", topic: "sandbox" })).toBe(false);
});

test("a model that closes the gap is read as closing it", () => {
  const better = scored.map((p) => (p.id === "英-沙盒" ? { ...p, score: 0.91 } : p));
  expect(crossesLanguages(better, { lang: "zh", topic: "sandbox" })).toBe(true);
});

test("a question with no other-language pair to compare gives no verdict", () => {
  // Not `false`: counting an unanswerable question as a failure would make the
  // condition impossible to meet by adding passages, and counting it as a pass
  // would meet it by removing them.
  const onlyChinese = scored.filter((p) => p.lang === "zh");
  expect(crossesLanguages(onlyChinese, { lang: "zh", topic: "sandbox" })).toBeNull();
});

test("cosine is the cosine", () => {
  expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 10);
  expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  // Magnitude must not matter, which is the whole reason it is cosine and not a
  // dot product: an unnormalised model would otherwise rank by passage length.
  expect(cosine([3, 4], [30, 40])).toBeCloseTo(1, 10);
});
