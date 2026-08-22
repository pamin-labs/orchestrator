import { needsDom } from "./needs-dom.ts";

/**
 * Suites that carry state across a run, so repeating them proves nothing.
 *
 * This used to be a list of two filenames, which meant the next non-replayable
 * suite was replayed until somebody remembered the list existed. The two
 * directories are the property: `live` talks to a real OpenSandbox server and
 * `integration` boots a real server on a real port.
 */
const NON_REPLAYABLE = /^test\/(live|integration)\//;

/**
 * A file that wants a document cannot be in this run, and that is a property of
 * the run rather than a list.
 *
 * `test/support/dom.ts` registers happy-dom for one file, decided from
 * `Bun.main`, which only names one file when each gets its own process. This run
 * is deliberately *not* `--isolate` — cross-file order dependence is what it
 * exists to find — so the preload is evaluated once and every browser test after
 * the first got `HTMLElement is not defined`. Measured on the 2026-08-22 nightly:
 * 195 failures, and 20 of the 21 distinct ones were this. They are covered by
 * `bun run test`, which is `--parallel` and gives them their process.
 *
 * `needsDom` rather than a `.tsx` glob, so this asks the same question the
 * preload asks and cannot answer it differently.
 */
export function stressFiles(): string[] {
  return [...new Bun.Glob("test/**/*.test.ts").scanSync({ cwd: ".", absolute: false })]
    .filter((file) => !NON_REPLAYABLE.test(file) && !needsDom(file))
    .toSorted();
}

/**
 * Serial and randomised, deliberately, where `bun run test` is `--parallel`.
 *
 * `--parallel` implies `--isolate`, which gives every file a fresh global — and
 * cross-file order dependence is what this job exists to find. Running it the way CI
 * runs would test the configuration that cannot have the bug.
 *
 * Concurrency is Bun's default rather than `--max-concurrency 4`, which was
 * backwards: interleaving is what a stress pass hunts.
 */
export function stressArgs(env: Readonly<Record<string, string | undefined>>): string[] {
  const rawSeed = env.BUN_TEST_SEED;
  if (rawSeed === undefined) return ["--randomize", "--rerun-each", "10"];
  const seed = Number(rawSeed);
  if (!Number.isSafeInteger(seed)) throw new Error("BUN_TEST_SEED must be a safe integer");
  return ["--randomize", "--seed", String(seed), "--rerun-each", "10"];
}

if (import.meta.main) {
  const child = Bun.spawn(["bun", "test", ...stressFiles(), ...stressArgs(process.env)], {
    env: { ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "1000" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
