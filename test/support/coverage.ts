import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { createRequire } from "node:module";
import type { instrument as oxcInstrumentFn } from "oxc-coverage-instrument";

/**
 * Coverage for `bun test`, by instrumenting the source rather than asking the
 * runtime for it. Why not Bun's own `--coverage`, and why `oxc-coverage-instrument`
 * rather than babel — with the numbers — is ADR 015.
 */
/**
 * The rewrite happens at load time, so counters land in `globalThis.__coverage__`
 * and what comes out is a standard Istanbul map. Loaded only by
 * `bun run test:coverage`: instrumentation costs real time and the default
 * `bun test` is kept fast on purpose.
 */

const COVERAGE_DIR = process.env.COVERAGE_DIR ?? "coverage";
const root = process.cwd();

/**
 * The switch is an environment variable because there is nowhere else to put it.
 *
 * This file is imported as the first line of `setup.ts`, the only position early
 * enough to instrument what the resets there import — a plugin registered after a
 * module has loaded does not reach it. So the question is whether the *loading*
 * can be conditional instead, and it cannot.
 */
/**
 * Measured against Bun 1.3.14: `bunfig.toml`'s `preload` runs **before** a
 * command-line `--preload`, so `bun test --preload ./test/support/coverage.ts`
 * registers the plugin after `setup.ts` has loaded; and `bun test` has no
 * `--config`, which is read as a test-file filter and matches nothing.
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
function instrument(source: string, path: string, _jsx: boolean): string {
  return oxcInstrument(source, path).code;
}

/**
 * The rewriter itself, loaded only when it is going to be used.
 *
 * A static `import` here is paid by every one of the 149 test files — twice over
 * under `--parallel`, which implies `--isolate` and re-evaluates the module graph
 * per file — for a plugin the default run never registers.
 */
/**
 * `require`, not `await import`. Measured against Bun 1.3.14: a preload's top-level
 * `await` does not hold back the module it was preloading for, so under `--parallel`
 * the plugin would register after the source it exists to instrument had already
 * loaded. `require` keeps registration on the synchronous path, where the ordering
 * the preload buys still holds.
 */
let oxcInstrument: typeof oxcInstrumentFn;

if (enabled) {
  // Typed by the caller: `createRequire` returns `any`, and the module named
  // here is a literal, so the generic is just saying what it already is.
  const load = createRequire(import.meta.url) as <T>(id: string) => T;
  oxcInstrument = load<typeof import("oxc-coverage-instrument")>("oxc-coverage-instrument").instrument;
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
  // Where the instrumented code accumulates its counters. Declared rather than
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
  // One shard per *file*, merged by the report script.
  //
  // Writing `coverage-final.json` directly meant the last writer overwrote the
  // rest, which is why the coverage run was single-process — and single-process
  // was most of its cost. Sharding fixes that, but the shard cannot be keyed on
  // the process: `--parallel` implies `--isolate`, so every test file gets a
  // fresh global and `__coverage__` starts empty again. Keyed on the pid, ten
  // workers wrote ten shards holding only whatever each had loaded last, and
  // the merged total came out at 18% instead of 79%.
  //
  // A uuid per shard is the smallest thing that survives both: the pid keeps
  // the names readable, the uuid keeps them distinct.
  const parts = join(COVERAGE_DIR, "parts");
  mkdirSync(parts, { recursive: true });
  writeFileSync(join(parts, `${process.pid}-${crypto.randomUUID()}.json`), JSON.stringify(raw));
});
