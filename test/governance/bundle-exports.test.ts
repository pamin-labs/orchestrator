import { expect, test } from "bun:test";
import { linguiMacros } from "../../scripts/lingui-macros.ts";

/**
 * Every export the browser bundle names has something behind it.
 *
 * A failure neither the compiler nor the linter can see, because the bundler
 * creates it: the export record keeps an entry — `scalePoint: () => ij0` — while no
 * `var ij0` is emitted, so reading the property throws and the view dies on mount
 * with a minified name for its only clue (`096cb8b`).
 */
/**
 * So the assertion is on the artefact the browser loads, and on the class rather
 * than that instance: any dangling alias fails it, whichever library and whichever
 * gesture removed the last reference.
 */

/** The same entry point and flags `build:web` uses; anything else tests a different bundle. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: ["web/src/app/main.tsx"],
    target: "browser",
    minify: true,
    splitting: true,
    plugins: [linguiMacros],
  });
  expect(built.success).toBe(true);
  // Named, not `outputs[0]`: with splitting on, a catalog chunk can come first
  // and this would then assert against a file of Chinese strings.
  const entry = built.outputs.find((o) => o.kind === "entry-point");
  expect(entry).toBeDefined();
  return entry!.text();
}

/**
 * The scale record, and why the assertion is scoped to it rather than to the bundle.
 *
 * A dangling alias is only a *fault* where something reads the property, and a
 * whole-bundle sweep finds 219 of them: an untouched export record entry is exactly
 * what a tree-shaken re-export should look like. What makes this record different is
 * that `recharts` enumerates it by computed name, so every entry is live.
 *
 * Scoped by finding the object literal holding `scaleLinear`.
 */
function scaleRecord(code: string): Record<string, string> {
  const anchor = code.indexOf("scaleLinear:()=>");
  expect(anchor).toBeGreaterThan(-1);
  const open = code.lastIndexOf("{", anchor);
  const close = code.indexOf("}", anchor);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(anchor);
  const entries = [...code.slice(open, close).matchAll(/(scale[A-Za-z]*|tickFormat):\(\)=>([A-Za-z_$][\w$]*)/g)];
  return Object.fromEntries(entries.map((match) => [match[1]!, match[2]!]));
}

/**
 * The scales this app's charts can actually ask for — a checked list, not "all of
 * them".
 *
 * `d3-scale` exports about thirty and we render two chart types, so demanding the
 * whole record would demand that twenty-seven dead scales be bundled to pass a
 * test. The list is the guard: a new chart whose axis resolves to a scale that is
 * not here has to add a line, which is the moment somebody notices the resolution
 * is by string and cannot be tree-shaken.
 */
/**
 * `scalePoint` is deliberately *not* here. A category x axis would resolve to it,
 * and part of why the trend has none is that its implementation reached the
 * bundle only through recharts' own Brush module — so the chart worked for as long
 * as an unrelated component happened to import it. `linear` is what both trend
 * axes resolve to, x included: `type="number"` over epoch milliseconds.
 */
const RESOLVED = ["scaleLinear"] as const;

test("every scale this app's charts resolve by name is still in the bundle", async () => {
  const code = await bundle();
  const record = scaleRecord(code);
  // Sanity: the record is the real one, not a fragment matched by luck.
  expect(Object.keys(record).length).toBeGreaterThan(10);

  const shaken = RESOLVED.filter((name) => {
    const alias = record[name];
    return alias === undefined || !new RegExp(String.raw`(?:var|let|const|function|class)\s+${alias}\b`).test(code);
  });

  // By name, not by count: the alias is minified, so a number would say
  // "something is missing" and leave nothing to search for.
  expect(shaken).toEqual([]);
});
