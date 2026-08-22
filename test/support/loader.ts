import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { linguiCatalogs } from "../../scripts/lingui-catalogs.ts";
import { expandMacros, OURS } from "../../scripts/lingui-macros.ts";

/**
 * The one `onLoad` this process gets.
 *
 * Bun does not chain them: the first handler registered for a path wins and the
 * rest are never called, and returning nothing is a `TypeError` rather than
 * "leave this one alone" — both measured against 1.3.14. So macro expansion and
 * coverage instrumentation cannot be two plugins. They are two transforms
 * behind one, and this file is where they meet.
 */
/**
 * `require`, not `await import`. A preload's top-level `await` does not hold
 * back the test module under `--parallel`, so anything installed after one is
 * installed after the file it was supposed to precede — which is why this is
 * the first entry in `bunfig.toml`'s preload list.
 */

const covering = process.env.ORCH_COVERAGE === "1";

/**
 * Registered for every test process, not only the ones that reach the panel.
 *
 * This used to scan `Bun.main`'s imports and skip the transform unless the file
 * could reach `web/src`, which the note in `bunfig.toml` recorded as 3s across
 * the suite. The server holds `msg` now, so the honest answer to "can this file
 * reach a macro" is yes — and an unexpanded macro is a runtime `throw`, not a
 * compile error, so guessing wrong is a red suite that names the wrong thing.
 * Re-measured after removing it: inside the noise, because expansion is cached.
 */
const load = createRequire(import.meta.url) as <T>(id: string) => T;
// Required once, still on the synchronous path. `.code` here rather than a
// second export over there: the map beside it is what
// `loader-transforms-compose.test.ts` reads, and this loader has no use for it.
const coverage = covering ? load<typeof import("./coverage.ts")>("./coverage.ts") : null;
const instrument = coverage
  ? (source: string, path: string, map?: string | null) => coverage.instrumented(source, path, map).code
  : (source: string, _path: string, _map?: string | null) => source;

/**
 * `src` and `web/src`, the two directories that can hold a macro. Under coverage
 * the subject is every file, and the narrower filter would silently drop the
 * rest from the map.
 */
const filter = covering ? /\.tsx?$/ : OURS;

/** `(code, path, map)`, in the argument order `instrument` takes them. */
const expanded = (source: string, path: string): [string, string, string | null] => {
  const { code, map } = expandMacros(source, path);
  return [code, path, map];
};

// The catalogs, on the same terms the bundler gets them: compiled by
// `@lingui/cli/api` rather than parsed in the browser. A separate plugin because
// its filter does not overlap this one's — `.po` is not a `.tsx`.
//
// Ungated, unlike the transform below: `setup.ts` imports the Chinese catalog
// unconditionally, so a process without this handler cannot resolve `.po` at
// all. Registering an `onLoad` costs nothing; running one is what costs, and
// only the files this filter matches ever run it.
void Bun.plugin(linguiCatalogs);

Bun.plugin({
  name: "source-loader",
  setup(build) {
    // Synchronous, and not for speed: measured either way the suite is the
    // same to within noise. An `async` handler makes every module it
    // intercepts an async module, and a preload cannot `require` one of
    // those — "require() async module … is unsupported", which is what a
    // preload trying to reach a panel module gets today. Nothing needs that
    // yet, so this is not a fix; it is the version of the same handler that
    // forecloses less, at no cost. `coverage.ts` already reads its input
    // with `readFileSync`.
    build.onLoad({ filter, namespace: "file" }, ({ path }) => ({
      // Expanded first, then instrumented over the map it produced.
      //
      // The other order does not survive contact: oxc rewrites the initialiser
      // of `const { t } = useLingui()` into a sequence expression, and the
      // macro then refuses the file — "`useLingui` macro must be used in
      // variable declaration", in all 21 panel files that call it, but only
      // under `ORCH_COVERAGE=1`, so a green `bun run test` says nothing about
      // it. The statement map still has to describe the file on disk; that is
      // what `inputSourceMap` is for, and oxc composes it during
      // instrumentation rather than after.
      contents: instrument(...expanded(readFileSync(path, "utf8"), path)),
      loader: path.endsWith(".tsx") ? "tsx" : "ts",
    }));
  },
});
