import { parseSync } from "@babel/core";

/**
 * A file parsed for a governance guard, and nothing else.
 *
 * Four of them parse `src` or `web/src` and walk what comes back, and each had
 * written out the same four options — including `configFile: false`, which is
 * what keeps a stray `babel.config.js` from changing what a guard sees, and the
 * `jsx` plugin, which must be off for `.ts` or a generic arrow reads as an
 * unclosed tag.
 */
export const parse = (file: string, source: string) =>
  parseSync(source, {
    filename: file,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
  });

/**
 * Han, kana, hangul and the fullwidth forms — one class, because the guards
 * that use it disagreed about kana and hangul for no reason either could state.
 * `chain.ts` carries a Japanese escalation pattern and `editors.tsx` the
 * endonyms, so both scripts have to be visible; what makes those legal is an
 * exemption, not a blind spot.
 */
export const CJK = /[一-鿿ぁ-ヿ가-힯　-〿＀-￯]/;
