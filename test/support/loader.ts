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
 * a macro cost nothing — 193 processes paid for a transform ~50 of them can
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
  : (source: string, _path: string) => source;

/**
 * Only `web/src` can hold a macro, so only `web/src` leaves Bun's native load
 * path on the default run. Under coverage the subject is `src/` as well, and
 * the narrower filter would silently drop it from the map.
 */
const filter = covering ? /\.tsx?$/ : /[\\/]web[\\/]src[\\/].+\.tsx?$/;

if (touchesPanel || covering)
  Bun.plugin({
    name: "source-loader",
    setup(build) {
      build.onLoad({ filter, namespace: "file" }, async ({ path }) => ({
        // Instrumented first. The statement map has to describe the file on
        // disk, and babel reprints whatever it is handed — expanding first
        // would leave every line number in the map pointing at a generated one.
        contents: expandMacros(instrument(await Bun.file(path).text(), path), path),
        loader: path.endsWith(".tsx") ? "tsx" : "ts",
      }));
    },
  });
