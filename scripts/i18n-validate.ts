import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { LOCALES } from "../src/contracts/config.ts";
import { translations } from "./lingui-catalogs.ts";

/**
 * Every message is translated, and every translation still refers to the names
 * its English source did.
 *
 * ICU syntax is checked by the build: `createCompiledCatalog` fails on a message
 * it cannot parse, so a broken Russian plural stops `build:web` rather than
 * throwing inside a React render.
 */
/**
 * What no compiler catches is a translation that parses perfectly and dropped
 * `{count}` on the way through — a sentence missing the one number it was
 * written to carry, silently, and only in that language.
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

/**
 * A missing translation is what *editing English* looks like.
 *
 * The id is a hash of the source text, so rewording one `<Trans>` retires its id
 * and eight catalogs lose that string at once. Nothing stopped that from being
 * merged: `i18n:progress --check` only asks whether the README's table matches
 * the catalogs, so running `bun run i18n:progress` once made the table say 99.9%
 * and the gate go green. The panel then renders English inside a Russian pane,
 * for as long as nobody reads the table.
 */
/**
 * Strict on purpose, with the escape written down rather than built: if a real
 * translator workflow ever lands — a service, a queue, somebody who is not the
 * person writing the English — this becomes a report and the gate moves to
 * "no locale regressed". Today the same person writes both, so "finish it"
 * is the honest rule.
 */
for (const locale of LOCALES) {
  if (locale === "en") continue;
  const { messages, missing: untranslated } = await translations(locale);
  if (untranslated.length > 0) {
    const names = untranslated.map((m) => source[m.id] ?? m.id);
    console.error(
      `${locale}.po is missing ${untranslated.length} translation(s):\n` +
        names
          .slice(0, 5)
          .map((n) => `    ${n.slice(0, 72)}`)
          .join("\n") +
        (names.length > 5 ? `\n    …and ${names.length - 5} more` : "") +
        `\n  Run \`bun run i18n:extract\` and fill in the empty msgstr entries.`,
    );
    bad += untranslated.length;
  }
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
  console.error(`\n${bad} translation(s) missing or rendering the wrong thing.`);
  process.exit(1);
}
console.log(`${LOCALES.length - 1} catalogs complete, placeholders intact`);
