import {
  ara,
  ben,
  bul,
  ell,
  eng,
  fas,
  guj,
  heb,
  hin,
  hye,
  jpn,
  kor,
  kur,
  mar,
  mya,
  panGu,
  rus,
  tha,
  ukr,
  urd,
  zho,
} from "stopword";

/**
 * Words worth scoring, in whatever language the writing is in.
 *
 * `Intl.Segmenter` is ICU's word breaker, already in the runtime, and it segments
 * every script this corpus mixes. No locale is passed on purpose: a single note holds
 * more than one language, and ICU's default breaking handles the mix better than any
 * one tag. A one-letter Latin token carries no signal; a one-character Han token is
 * often a whole word, which is why the length rule reads the script rather than the
 * count.
 */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });
const SINGLE_LETTER = /^[\p{Script=Latin}\p{N}_]$/u;

/**
 * Stop words, rented, and merged by script rather than by language.
 *
 * Merging every list collides: German `die`, Spanish `no` and Dutch `hier` would
 * each eat an English word, and two of the casualties — `net` and `hit` — are
 * identifiers in this repository. Non-Latin lists cannot collide with English at
 * all, because the scripts do not overlap, so English plus every non-Latin list is
 * the widest set that costs nothing. It leaves Korean and Thai segmented but
 * unfiltered, which is the honest limit of this arrangement.
 */
const STOP = new Set(
  [eng, zho, jpn, kor, tha, ara, rus, ukr, bul, ell, heb, hin, hye, ben, guj, mar, mya, panGu, fas, urd, kur].flat(),
);

/**
 * A token every character of which is itself a stop word.
 *
 * The rented lists and the rented segmenter do not compose: \`zho\` is 78 entries and
 * **all 78 are single characters**, because it was built for a character-splitting
 * tokeniser, while ICU hands back words. So \`这\` and \`个\` are both filtered and
 * \`这个\` — one token — is not, and the same holds for 那个, 一个, 还是, 就是, 不是, 什么.
 */
/**
 * Latin is excluded, and that is not caution: \`eng\` contains \`a\` and \`i\`, so the rule
 * would eat \`ai\`. English does not compose words out of function words character by
 * character; the scripts written without spaces do.
 *
 * Measured against a list of plausible false positives — 上下, 大小, 多少, 以上, 起来,
 * 一样, 那些, 自己, 如果, 因为, 所以 — this catches none of them. It is deliberately
 * under-inclusive: 可以 and 没有 survive, which is the honest limit of the rented list.
 */
const LATIN = /[\p{Script=Latin}\p{N}]/u;
function allStopCharacters(token: string): boolean {
  if (token.length < 2 || LATIN.test(token)) return false;
  // `for...of` over a string iterates code points, which is the unit these lists are
  // written in; the stop lists hold no emoji, so a grapheme cluster simply misses.
  for (const character of token) if (!STOP.has(character)) return false;
  return true;
}

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const { segment, isWordLike } of SEGMENTER.segment(text.toLowerCase())) {
    if (!isWordLike) continue;
    if (SINGLE_LETTER.test(segment)) continue;
    if (STOP.has(segment)) continue;
    if (allStopCharacters(segment)) continue;
    out.push(segment);
  }
  return out;
}
