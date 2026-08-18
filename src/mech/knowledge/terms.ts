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
 * every script this corpus mixes. No locale is passed on purpose: a single note
 * holds more than one language, and ICU's default breaking handles the mix better
 * than any one tag. A one-letter Latin token carries no signal; a one-character
 * Han token is often a whole word, which is why the length rule reads the script
 * rather than the count.
 *
 * Its own file because three callers need it — the Orama tokenizer, the repo map,
 * and the query itself — and `ctx.ts` already imports `repomap.ts`.
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

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const { segment, isWordLike } of SEGMENTER.segment(text.toLowerCase())) {
    if (!isWordLike) continue;
    if (SINGLE_LETTER.test(segment)) continue;
    if (STOP.has(segment)) continue;
    out.push(segment);
  }
  return out;
}
