import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { LOCALES } from "../src/contracts/config.ts";
import { translations } from "./lingui-catalogs.ts";

/**
 * Every translation still refers to the names its English source did.
 *
 * ICU syntax is checked by the build: `createCompiledCatalog` in
 * `lingui-catalogs.ts` fails on a message it cannot parse, so a broken Russian
 * plural stops `build:web` rather than throwing inside a React render. What no
 * compiler can catch is a translation that parses perfectly and dropped
 * `{count}` on the way through, rendering a sentence missing the one number it
 * was written to carry — silently, and only in that language.
 */
/**
 * Walked rather than pattern-matched: `compileMessageOrThrow` already returns
 * the tokens, and a regex over the raw string has to re-derive which braces are
 * a reference, which are a plural category and which are inside a branch.
 */

/**
 * Every name a compiled message refers to, plus every `<0>` slot.
 *
 * A token is either a literal string or `[name, type?, options?]`; a plural's
 * branches hang off `options` and hold tokens of their own. The tags are not
 * tokens at all — they stay in the literals, so they are read from there.
 */
/** A placeholder token's nested token lists: a plural's branches, a select's cases. */
function branchesOf(token: readonly unknown[]): readonly unknown[][] {
  const options: unknown = token[2];
  if (!options || typeof options !== "object" || Array.isArray(options)) return [];
  return Object.values(options).filter((branch): branch is unknown[] => Array.isArray(branch));
}

/** Every name one token refers to. A literal carries no names, only `<0>` slots. */
function namesIn(token: unknown): string[] {
  if (typeof token === "string") return [...token.matchAll(/<(\d+)>/g)].map(([, slot]) => `<${slot}>`);
  if (!Array.isArray(token)) return [];
  const self = typeof token[0] === "string" ? [token[0]] : [];
  return [...self, ...branchesOf(token).flatMap((branch) => branch.flatMap(namesIn))];
}

/**
 * A token is either a literal string or `[name, type?, options?]`; a plural's
 * branches hang off `options` and hold tokens of their own. The tags are not
 * tokens at all — they stay in the literals, so they are read from there.
 */
const referenced = (tokens: readonly unknown[]): Set<string> => new Set(tokens.flatMap(namesIn));

const missing = (want: Set<string>, got: Set<string>): string[] => [...want].filter((name) => !got.has(name));

let bad = 0;
// The source catalog says which names each message is supposed to carry.
const source = (await translations("en")).messages;

for (const locale of LOCALES) {
  if (locale === "en") continue;
  const { messages } = await translations(locale);
  for (const [id, translation] of Object.entries(messages)) {
    const english = source[id];
    if (!translation || !english || translation === english) continue;
    const want = referenced(compileMessageOrThrow(english));
    const gone = missing(want, referenced(compileMessageOrThrow(translation)));
    const extra = missing(referenced(compileMessageOrThrow(translation)), want);
    if (gone.length === 0 && extra.length === 0) continue;
    const what = [
      gone.length > 0 && `dropped ${gone.join(", ")}`,
      extra.length > 0 && `invented ${extra.join(", ")}`,
    ].filter(Boolean);
    console.error(`${locale}.po  ${id}\n  en: ${english}\n  ${locale}: ${translation}\n  ${what.join("; ")}`);
    bad++;
  }
}

if (bad > 0) {
  console.error(`\n${bad} translation(s) will render the wrong thing.`);
  process.exit(1);
}
console.log(`placeholders ok in ${LOCALES.length - 1} translated catalogs`);
