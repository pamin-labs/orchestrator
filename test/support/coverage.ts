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
 * and what comes out is a standard Istanbul map. `test/support/loader.ts` owns
 * the plugin and requires this file only under `ORCH_COVERAGE=1`, so loading it
 * at all is the switch: instrumentation costs real time and the default
 * `bun test` is kept fast on purpose.
 */
/**
 * Bun does not chain `onLoad` handlers — the first registered for a path wins
 * and the rest are never called, and returning nothing is a `TypeError` rather
 * than "leave this one alone". Both measured against 1.3.14. So this file
 * cannot register its own plugin beside the macro expander; it exports a
 * transform and `loader.ts` composes the two.
 */

const COVERAGE_DIR = process.env.COVERAGE_DIR ?? "coverage";
const root = process.cwd();

/** Source we own. Tests, fixtures and dependencies are not the subject. */
function isSubject(path: string): boolean {
  if (!path.startsWith(root)) return false;
  const rest = path.slice(root.length + 1);
  return rest.startsWith("src/") || rest.startsWith("web/src/");
}

/**
 * `require`, not `await import`. Measured against Bun 1.3.14: a preload's top-level
 * `await` does not hold back the module it was preloading for, so under `--parallel`
 * the plugin would register after the source it exists to instrument had already
 * loaded. `require` keeps registration on the synchronous path, where the ordering
 * the preload buys still holds.
 */
const load = createRequire(import.meta.url) as <T>(id: string) => T;
const oxcInstrument: typeof oxcInstrumentFn =
  load<typeof import("oxc-coverage-instrument")>("oxc-coverage-instrument").instrument;

/**
 * Instrumented if it is ours, handed back untouched if it is not.
 *
 * `inputSourceMap` is how a file that something else already rewrote still gets
 * counters against its own lines: `composeInputSourceMap` folds the map in
 * during instrumentation, so the emitted `statementMap` carries original-source
 * positions keyed by the original path. Macro expansion runs first and hands
 * its map here — without it the panel's coverage would describe generated code,
 * and `fallow audit` reads that map to decide which function it is looking at.
 */
export function instrumented(source: string, path: string, inputSourceMap?: string | null): string {
  return instrumentedWithMap(source, path, inputSourceMap).code;
}

/**
 * The same call, with the map `instrumented` throws away.
 *
 * `oxc` returns the Istanbul map beside the code, so a caller that needs to know
 * *what* it instrumented does not have to go back and find it in the emitted
 * source. `loader-transforms-compose.test.ts` did, by counting braces from
 * `coverageData = {` and `JSON.parse`-ing the slice — a second hand-written
 * bracket matcher in a repo that had just deleted one.
 */
export function instrumentedWithMap(
  source: string,
  path: string,
  inputSourceMap?: string | null,
): { code: string; coverageMap: string | null } {
  if (!isSubject(path)) return { code: source, coverageMap: null };
  const options = inputSourceMap ? { inputSourceMap, composeInputSourceMap: true } : undefined;
  const out = oxcInstrument(source, path, options);
  return { code: out.code, coverageMap: out.coverageMap };
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
