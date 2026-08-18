import { expect, test } from "bun:test";

/**
 * Every export the browser bundle names has something behind it.
 *
 * This guards a failure mode that neither the compiler nor the linter can see,
 * because it is created by the bundler and only exists in its output.
 *
 * `recharts` resolves an axis scale by *string*: it builds `"scale" + type` and
 * looks it up on the `d3-scale` namespace object, guarded by
 * `typeof J[name] === "function"`. No bundler can follow a lookup like that, so
 * the implementations survive tree-shaking only when something else in the
 * graph imports them statically. For `scalePoint` that something was
 * `recharts/es6/cartesian/Brush.js` — and deleting an unused `<Brush>` from one
 * component therefore removed a function a *used* component needs.
 *
 * The shape it left behind is the thing worth detecting, and it is general
 * rather than specific to that library: the export record kept its entry,
 *
 *     Q7(yF, { ..., scalePoint: () => ij0, ... })
 *
 * while no `var ij0` was emitted anywhere. Reading the property throws
 * `ij0 is not defined`, and the whole view died on mount with a minified name
 * for its only clue. Nothing before this test would have caught it: TypeScript
 * type-checks source, Oxlint lints source, and the render tests import modules
 * directly rather than through the bundle.
 *
 * So the assertion is on the artefact the browser actually loads, and it is
 * about the class rather than the instance — any dangling alias fails it,
 * whichever library and whichever gesture happens to remove the last reference.
 */

/** The same entry point and flags `build:web` uses; anything else tests a different bundle. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: ["web/src/app/main.tsx"],
    target: "browser",
    minify: true,
  });
  expect(built.success).toBe(true);
  const [output] = built.outputs;
  expect(output).toBeDefined();
  return output!.text();
}

/**
 * The scale record, and why the assertion is scoped to it rather than to the bundle.
 *
 * A dangling alias is only a *fault* where something reads the property, and a
 * whole-bundle sweep finds 219 of them: an export record entry nobody touches
 * is exactly what a tree-shaken re-export is supposed to look like. What makes
 * this record different is that `recharts` enumerates it by computed name, so
 * every entry in it is live whether or not any code mentions it — which turns
 * the ordinary case into the failing one.
 *
 * Scoped by finding the object literal that holds `scaleLinear`, since that is
 * the one `d3-scale` namespace the library reaches into.
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
 * The scales this app's charts can actually ask for.
 *
 * A checked list rather than "all of them", and the difference is the point:
 * `d3-scale` exports about thirty and we render two chart types, so demanding
 * the whole record would be demanding that twenty-seven dead scales be bundled
 * to make a test pass. The list is the guard — a new chart type whose axis
 * resolves to a scale that is not here has to add a line, which is the moment
 * somebody notices the resolution is by string and cannot be tree-shaken.
 *
 * `linear` is what both of the trend's axes resolve to, the x axis included:
 * it is `type="number"` over epoch milliseconds rather than a list of printed
 * labels. `PieChart`, the only other chart here, has no axes.
 *
 * `scalePoint` is deliberately *not* on this list. A category x axis would
 * resolve to it, and the reason the trend does not have one is partly this: its
 * implementation reached the bundle only through `recharts`' own Brush module,
 * so the chart worked for as long as an unrelated component happened to import
 * it. If a category axis is ever added, this list is where that dependency has
 * to be made explicit again.
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
