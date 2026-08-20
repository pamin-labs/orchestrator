import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { BunPlugin } from "bun";

/**
 * Lingui macros, expanded at load time, for the only two things that read
 * `web/src`: `Bun.build` in `build-web.ts`, and the loader plugin in
 * `test/support/loader.ts`. One file, because a second copy of this would be a
 * second answer to what the browser actually ran.
 */
/**
 * `bun build` the CLI cannot take a plugin — no `--plugin` flag, and
 * `bunfig.toml` has no bundler key — which is why `build:web` is a script now.
 * A plugin registered globally through `Bun.plugin` does not reach an
 * in-process `Bun.build` either, so every caller passes this explicitly.
 */

const load = createRequire(import.meta.url) as <T>(id: string) => T;
const CONFIG = new URL("./lingui.config.js", import.meta.url).pathname;
const ROOT = new URL("../", import.meta.url).pathname;

/**
 * Babel is resolved on first use, not at import. This module is imported by the
 * test preload in every one of the 193 test processes, and all but the browser
 * ones never reach a macro — paying for babel's module graph there is the cost
 * ADR 015 measured and refused.
 */
let expand: ((source: string, path: string) => string) | undefined;

function boot(): (source: string, path: string) => string {
  const { transformSync } = load<typeof import("@babel/core")>("@babel/core");
  const macro = load<{ default: unknown }>("@lingui/babel-plugin-lingui-macro").default;
  // Resolved once. The plugin otherwise calls `@lingui/conf`'s `getConfig()`
  // per file, which searches upward from `process.cwd()` — and `browse.ts`
  // runs `build:web` with the cwd set to a worktree.
  const linguiConfig = load<typeof import("@lingui/conf")>("@lingui/conf").getConfig({ configPath: CONFIG });
  return (source, path) => {
    /**
     * `jsx` only for `.tsx`. Enabled for a `.ts` it reads the generic arrow
     * `const f = <T>(x: T) => x` as an unclosed tag, and the file then loads
     * with a syntax error on the way past — the trap `coverage.ts` records.
     */
    const plugins = path.endsWith(".tsx") ? (["typescript", "jsx"] as const) : (["typescript"] as const);
    // Babel has to understand the syntax before it can rewrite it, but it must
    // not compile it: Bun does that, and a second transpile would change what
    // the browser and the test actually run.
    const out = transformSync(source, {
      filename: path,
      configFile: false,
      babelrc: false,
      browserslistConfigFile: false,
      sourceMaps: false,
      parserOpts: { plugins: [...plugins] },
      plugins: [[macro, { linguiConfig }]],
    });
    if (out?.code == null) throw new Error(`lingui: babel returned no code for ${path}`);
    return out.code;
  };
}

/**
 * Content-addressed, because `--parallel` implies `--isolate`: every test file
 * re-evaluates the module graph it imports, so one panel module is expanded once
 * per test process that reaches it — 49 of them, for the same bytes. Measured
 * without it: +22% CPU across the suite. The key is the source and the plugin
 * version, so an edit or an upgrade misses and nothing has to be cleared.
 */
const CACHE = `${ROOT}.cache/lingui`;
const VERSION = "6.6.0";

/** The substring scan is the whole gate: no macro import, no parse. */
export function expandMacros(source: string, path: string): string {
  if (!source.includes("@lingui/")) return source;
  const key = `${CACHE}/${Bun.hash(`${VERSION}:${path}:${source}`).toString(36)}.txt`;
  try {
    return readFileSync(key, "utf8");
  } catch {
    // A miss is the normal path on the first run and after any edit.
  }
  expand ??= boot();
  const out = expand(source, path);
  try {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(key, out);
  } catch {
    // An unwritable cache is a slow build, not a broken one.
  }
  return out;
}

export const linguiMacros: BunPlugin = {
  name: "lingui-macros",
  setup(build) {
    build.onLoad({ filter: /[\\/]web[\\/]src[\\/].+\.tsx?$/, namespace: "file" }, async ({ path }) => ({
      contents: expandMacros(await Bun.file(path).text(), path),
      loader: path.endsWith(".tsx") ? "tsx" : "ts",
    }));
  },
};
