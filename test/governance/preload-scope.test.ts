import { expect, test } from "bun:test";
import { z } from "zod";
import { needsDom } from "../support/dom.ts";

/**
 * A test that reaches the browser is on the list that gets a document.
 *
 * `test/support/dom.ts` registers happy-dom only for the files that need it,
 * because the preload runs for all 149 and the registration is most of the
 * ~119ms the DOM preloads add. The gate is an explicit list, and an explicit
 * list drifts: someone imports a `web/src` module from a test outside
 * `test/web/`, and the document is simply not there.
 *
 * Nothing about the resulting failure names the cause. Radix reads
 * `globalThis?.document` once when its module is evaluated and decides then
 * whether `useLayoutEffect` is React's or a no-op, so without a document every
 * portal, dialog and popover in that file stays unmounted for the whole run —
 * the test reads "unable to find an element with the role dialog", which is what
 * a genuinely broken dialog reads like too.
 *
 * So the drift is caught here instead, against `needsDom` itself rather than a
 * second copy of it: a copy would agree with a wrong original.
 *
 * Direct imports only. A transitive scan would need the module graph, and the
 * import that gets forgotten is the one somebody typed.
 */

const ROOT = new URL("../../", import.meta.url).pathname;

/**
 * `Bun.Transpiler`, not a regex over the source.
 *
 * The regex this replaces read a specifier out of one of the doc comments above
 * and reported this very file as a browser test. `scanImports` parses, so it
 * sees import statements and dynamic imports and nothing that merely looks like
 * one — and it is the runtime's own parser, which is the one whose opinion about
 * what an import is actually matters.
 *
 * A transpiler each, because the loader is not interchangeable: `tsx` reads the
 * generic arrow `const gh = <T,>(…) =>` in `test/support/factories.ts` as an
 * unclosed JSX tag and throws. `test/support/coverage.ts` has the same note
 * against the same shape in `src/server.ts`.
 */
/**
 * What "reaches the browser" means, and why it is not just `web/src`.
 *
 * `test/mech/auth.test.ts` imports `waitFor` from `@testing-library/dom` — under
 * a comment claiming "`waitFor` itself touches no DOM", which is not true:
 * `waitFor` calls `getDocument()`, and that throws `Could not find default
 * container` the moment `window` is undefined. It is a `test/mech` file that
 * mentions neither `web/src` nor `support/render`, so a scan for those two
 * misses it, and it was the one file the first cut of this gate broke.
 *
 * So the signal is the dependency, not the directory: anything that pulls in a
 * browser library needs the document, however server-side the test around it
 * looks.
 */
const reachesDom = (spec: string) =>
  spec.includes("web/src/") ||
  spec.includes("support/render") ||
  spec.startsWith("@testing-library/") ||
  spec.includes("happy-dom");

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

test("every test that imports the browser is in dom.ts's list", async () => {
  const missing: string[] = [];
  for (const rel of new Bun.Glob("test/**/*.test.{ts,tsx}").scanSync({ cwd: ROOT })) {
    const source = await Bun.file(ROOT + rel).text();
    const browser = transpilers[rel.endsWith(".tsx") ? "tsx" : "ts"]
      .scanImports(source)
      .some(({ path }) => reachesDom(path));
    if (browser && !needsDom(rel)) missing.push(rel);
  }
  // The paths, not a count: the fix is to add exactly these to `DOM_TESTS`.
  expect(missing).toEqual([]);
});

/**
 * The gate's precondition, checked on the command that has to carry it.
 *
 * `dom.ts` decides from `Bun.main`, which names the file only when each file
 * gets its own process. `--parallel` implies `--isolate` and buys exactly that;
 * without it Bun runs the whole suite in one process, evaluates the preload
 * once, and every file after the first is classified by the first file's path.
 *
 * Nothing else catches this. The mode is invisible from inside the preload —
 * `process.argv` is rewritten to the current test file either way, a `--parallel`
 * worker carries no IPC handle to spot, and `[test] parallel`/`[test] isolate`
 * in `bunfig.toml` are silently ignored (all three measured against Bun 1.3.14).
 * So if the flag ever leaves this script, the suite does not fail here — it goes
 * green while classifying 149 files from one path, until some later run trips
 * over `HTMLElement is not defined` in a file that looks nothing like a DOM test.
 */
test("the test script isolates files, which is what dom.ts's gate reads Bun.main for", async () => {
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(await Bun.file(ROOT + "package.json").json());
  const isolating = (script: string) => script.includes("--parallel") || script.includes("--isolate");
  const offenders = Object.entries(scripts)
    .filter(([, script]) => script.includes("bun test"))
    .filter(([, script]) => !isolating(script))
    .map(([name]) => name);
  expect(offenders).toEqual([]);
});
