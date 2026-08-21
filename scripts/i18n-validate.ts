import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { z } from "zod";
import { LOCALES } from "../src/contracts/config.ts";

/**
 * Every translation parses as ICU, checked with the function that parses it at
 * runtime.
 *
 * Nothing else checks this. We do not run `lingui compile`, so no build step
 * ever reads a translation, and plain `compile` prints a parse error and exits
 * 0 anyway.
 */
/**
 * `compileMessageOrThrow`, not `compileMessage`: the second one prints the parse
 * error and returns anyway, so a validator built on it reports every catalog
 * clean while printing the failure above its own summary. Measured — the first
 * version of this file did exactly that.
 */
/**
 * The failure it prevents: a translator writing Russian plurals — `one`, `few`,
 * `many`, `other`, which is four sets of braces — gets one wrong, and the panel
 * throws inside a React render, in production, for Russian readers only.
 */
/**
 * Parsing is not the whole check. A translation can be flawless ICU and still
 * have dropped `{count}`, rendering a sentence missing the one number it was
 * written to carry — silently, and only in that language. So the compiled form
 * is walked for the names it references and compared against the source's.
 */
/**
 * Walked rather than pattern-matched: `compileMessageOrThrow` already returns
 * the tokens, and a regex over the raw string has to re-derive which braces are
 * a reference, which are a plural category and which are inside a branch.
 */

const CatalogSchema = z.record(
  z.string(),
  z.object({ message: z.string().optional(), translation: z.string().optional() }),
);

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
for (const locale of LOCALES) {
  const path = `web/src/locales/${locale}.json`;
  for (const [id, message] of Object.entries(CatalogSchema.parse(await Bun.file(path).json()))) {
    const translation = message.translation ?? "";
    if (translation === "") continue;
    let compiled;
    try {
      compiled = compileMessageOrThrow(translation);
    } catch (error) {
      console.error(`${path}  ${id}\n  ${translation}\n  ${error instanceof Error ? error.message : String(error)}`);
      bad++;
      continue;
    }
    // The source is what the macro hashed, so it is the only thing that says
    // which names this message is supposed to carry.
    const source = message.message ?? "";
    if (source === "") continue;
    const want = referenced(compileMessageOrThrow(source));
    const gone = missing(want, referenced(compiled));
    const extra = missing(referenced(compiled), want);
    if (gone.length === 0 && extra.length === 0) continue;
    const what = [
      gone.length > 0 && `dropped ${gone.join(", ")}`,
      extra.length > 0 && `invented ${extra.join(", ")}`,
    ].filter(Boolean);
    console.error(`${path}  ${id}\n  en: ${source}\n  ${locale}: ${translation}\n  ${what.join("; ")}`);
    bad++;
  }
}

if (bad > 0) {
  console.error(`\n${bad} translation(s) will throw or render the wrong thing.`);
  process.exit(1);
}
console.log(`ICU and placeholders ok in ${LOCALES.length} catalogs`);
