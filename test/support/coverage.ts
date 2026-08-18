import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { transformSync } from "@babel/core";
import istanbul from "babel-plugin-istanbul";

/**
 * Coverage for `bun test`, by instrumenting the source rather than asking the
 * runtime for it.
 *
 * Bun's own `--coverage` cannot answer the questions we need. Its lcov carries
 * `FNF`/`FNH` totals but no `FN`/`FNDA` records and no `BRDA`, so it cannot say
 * *which* function or branch went untested — and Fallow's CRAP score is
 * cyclomatic complexity against per-function coverage, so without those records
 * every CRAP number in the audit is an estimate. `NODE_V8_COVERAGE` is ignored
 * by Bun, which also rules out the c8 / v8-to-istanbul route.
 *
 * Instrumenting at load time sidesteps the runtime entirely: babel rewrites the
 * source, the counters land in `globalThis.__coverage__`, and what comes out is
 * a standard Istanbul coverage map that Fallow reads directly.
 *
 * Loaded only by `bun run test:coverage`. Instrumentation costs real time, and
 * the default `bun test` is kept fast on purpose.
 */

const COVERAGE_DIR = process.env.COVERAGE_DIR ?? "coverage";
const root = process.cwd();

/**
 * The switch is an environment variable because there is nowhere else to put it.
 *
 * This file is imported as the first line of `test/support/setup.ts`, which is
 * the only position early enough to instrument what the resets there import —
 * a plugin registered after a module has loaded does not reach it. So the
 * question is whether the *loading* can be made conditional instead, and it
 * cannot. Measured against Bun 1.3.14:
 *
 *   - `bunfig.toml`'s `preload` runs **before** a command-line `--preload`, so
 *     `bun test --preload ./test/support/coverage.ts` registers the plugin
 *     after `setup.ts` has already loaded.
 *   - `bun test` has no `--config`/`-c`: passing one is read as a test-file
 *     filter and matches nothing.
 *
 * The preload list is therefore static, and a static list can only be made
 * conditional from inside the thing it loads.
 */
const enabled = process.env.ORCH_COVERAGE === "1";

/** Source we own. Tests, fixtures and dependencies are not the subject. */
function isSubject(path: string): boolean {
  if (!path.startsWith(root)) return false;
  const rest = path.slice(root.length + 1);
  return rest.startsWith("src/") || rest.startsWith("web/src/");
}

/**
 * Babel has to understand the syntax before it can instrument it, but it must
 * not compile it — Bun does that, and a second transpile would change what the
 * test actually runs.
 *
 * `jsx` only for `.tsx`. Enabled for a `.ts` file it reads the generic arrow
 * `const track = <T>(work: Promise<T>) => …` in src/server.ts as an unclosed JSX
 * tag, and the file then loads uninstrumented with a syntax error on the way
 * past — coverage silently missing for whatever it touched.
 */
function instrument(source: string, path: string, jsx: boolean): string {
  const result = transformSync(source, {
    filename: path,
    cwd: root,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    parserOpts: { plugins: jsx ? ["typescript", "jsx"] : ["typescript"] },
    plugins: [[istanbul, { cwd: root, exclude: [] }]],
  });
  // A file babel declines to rewrite still has to load, uninstrumented, rather
  // than disappear from the module graph mid-run.
  return result?.code ?? source;
}

if (enabled) {
  Bun.plugin({
    name: "istanbul-instrument",
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        const jsx = args.path.endsWith(".tsx");
        const loader = jsx ? "tsx" : "ts";
        const source = await Bun.file(args.path).text();
        // `onLoad` has to hand back a module either way — returning nothing is
        // an error rather than "leave this one alone", so anything outside the
        // subject is passed through untouched.
        if (!isSubject(args.path)) return { contents: source, loader };
        return { contents: instrument(source, args.path, jsx), loader };
      });
    },
  });
}

declare global {
  // Where babel-plugin-istanbul accumulates its counters. Declared rather than
  // asserted so reading it is a typed access instead of a cast through the
  // global object.
  var __coverage__: Record<string, unknown> | undefined;
}

/**
 * `afterAll` registered in a preload fires once for the whole run, not once per
 * file — verified against a three-file run, because `bun test` fires neither
 * `process.on("exit")` nor `beforeExit` and the obvious hooks are unavailable.
 *
 * Rendering lcov and HTML from the map is the report script's job, so this
 * writes the map and nothing else.
 */
afterAll(() => {
  const raw = globalThis.__coverage__;
  if (!raw) return;
  mkdirSync(COVERAGE_DIR, { recursive: true });
  writeFileSync(join(COVERAGE_DIR, "coverage-final.json"), JSON.stringify(raw));
});
