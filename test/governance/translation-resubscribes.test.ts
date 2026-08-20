import { expect, test } from "bun:test";

/**
 * A translated string only updates on a locale change if something in its tree
 * is subscribed to the catalog.
 *
 * `I18nProvider` re-renders on `i18n.activate`, but its `children` is the same
 * element reference the parent rendered last time, so React bails out of the
 * subtree. What actually re-renders is a context consumer: `<Trans>`, or a
 * component calling `useLingui()`. The global `t` from `@lingui/core/macro`
 * compiles to `i18n._()` against the module singleton and consumes nothing.
 */
/**
 * `App` holds the root subscription, so one `activate` re-renders the panel —
 * except through a `React.memo`, which is the one thing that stops a parent's
 * re-render from reaching a child. A memoised component that translates must
 * therefore subscribe on its own.
 */

const SUBSCRIBES = /useLingui\(|<Trans\b|<Plural\b|<Select\b|<SelectOrdinal\b/;
const TRANSLATES = /\bt`|\bt\(\{|i18n\._\(/;

/** The body of each `memo(...)` call, by matching its parentheses. */
function memoBodies(source: string): string[] {
  const out: string[] = [];
  for (let at = source.indexOf("memo("); at !== -1; at = source.indexOf("memo(", at + 1)) {
    if (/[\w$]/.test(source[at - 1] ?? "")) continue; // useMemo, and anything else ending in "memo"
    let depth = 0;
    let i = at + 4;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    out.push(source.slice(at, i));
  }
  return out;
}

test("App subscribes, so one activate re-renders the panel", async () => {
  const app = await Bun.file("web/src/app/app.tsx").text();
  expect(SUBSCRIBES.test(app)).toBe(true);
});

test("a memoised component that translates subscribes on its own", async () => {
  const offenders: string[] = [];
  for (const file of new Bun.Glob("web/src/**/*.tsx").scanSync(".")) {
    const source = await Bun.file(file).text();
    for (const body of memoBodies(source)) {
      if (TRANSLATES.test(body) && !SUBSCRIBES.test(body)) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
