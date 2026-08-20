import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { z } from "zod";
import { LOCALES } from "../src/contracts/config.ts";

/**
 * Every translation parses as ICU, checked with the function that parses it at
 * runtime.
 *
 * Nothing else checks this. We do not run `lingui compile`, so no build step
 * ever reads a translation — and `compile --strict`, which would, also fails on
 * a missing translation, which is a state this project is deliberately in for
 * eight locales. Plain `compile` prints the error and exits 0.
 */
/**
 * , not : the second one prints the parse
 * error and returns anyway, so a validator built on it reports every catalog
 * clean while printing the failure above its own summary. Measured — the first
 * version of this file did exactly that.
 */
/**
 * The failure it prevents: a translator writing Russian plurals — `one`, `few`,
 * `many`, `other`, which is four sets of braces — gets one wrong, and the panel
 * throws inside a React render, in production, for Russian readers only.
 */

const CatalogSchema = z.record(z.string(), z.object({ translation: z.string().optional() }));

let bad = 0;
for (const locale of LOCALES) {
  const path = `web/src/locales/${locale}.json`;
  for (const [id, message] of Object.entries(CatalogSchema.parse(await Bun.file(path).json()))) {
    const translation = message.translation ?? "";
    if (translation === "") continue;
    try {
      compileMessageOrThrow(translation);
    } catch (error) {
      console.error(`${path}  ${id}\n  ${translation}\n  ${error instanceof Error ? error.message : String(error)}`);
      bad++;
    }
  }
}

if (bad > 0) {
  console.error(`\n${bad} translation(s) will throw when rendered.`);
  process.exit(1);
}
console.log(`ICU ok in ${LOCALES.length} catalogs`);
