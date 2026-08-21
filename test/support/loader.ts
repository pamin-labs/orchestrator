import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expandMacros } from "../../scripts/lingui-macros.ts";

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
 * Whether the file about to run can reach the panel, decided the way `dom.ts`
 * decides it needs a document: `Bun.Transpiler` over `Bun.main`, synchronously.
 *
 * Registering the plugin unconditionally cost 3s across the suite and expanding
 * a macro cost nothing — 204 processes paid for a transform 58 of them can
 * reach. Direct imports only, same limit `dom.ts` documents: a test reaching
 * `web/src` through a helper of its own should re-export from `support/render`.
 */
const reachesPanel = (spec: string): boolean =>
  spec.endsWith(".tsx") || spec.includes("web/src") || spec.includes("support/render");

export const touchesPanel = ((path: string): boolean => {
  if (!path.includes("test/")) return false;
  try {
    const loader = path.endsWith(".tsx") ? "tsx" : "ts";
    const source = readFileSync(path, "utf8");
    return new Bun.Transpiler({ loader }).scanImports(source).some(({ path: spec }) => reachesPanel(spec));
  } catch {
    // Unreadable is not a panel test; the run says so on its own terms.
    return false;
  }
})(Bun.main);
const load = createRequire(import.meta.url) as <T>(id: string) => T;
const instrument = covering
  ? load<typeof import("./coverage.ts")>("./coverage.ts").instrumented
  : (source: string, _path: string, _map?: string | null) => source;

/**
 * Only `web/src` can hold a macro, so only `web/src` leaves Bun's native load
 * path on the default run. Under coverage the subject is `src/` as well, and
 * the narrower filter would silently drop it from the map.
 */
const filter = covering ? /\.tsx?$/ : /[\\/]web[\\/]src[\\/].+\.tsx?$/;

/** `(code, path, map)`, in the argument order `instrument` takes them. */
const expanded = (source: string, path: string): [string, string, string | null] => {
  const { code, map } = expandMacros(source, path);
  return [code, path, map];
};

if (touchesPanel || covering)
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
