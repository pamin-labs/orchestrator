import { claim, TIMEOUT } from "./test.ts";

/**
 * Suites that carry state across a run, so repeating them proves nothing.
 *
 * This used to be a list of two filenames, which meant the next non-replayable
 * suite was replayed until somebody remembered the list existed. Two of the
 * three are the property: `live` talks to a real OpenSandbox server and
 * `integration` boots a real server on a real port.
 */
/**
 * The third is a file, because the property is inside it and no path can carry
 * it: `test-db-reclaim` asserts what the *first* `openMemory` for a namespace
 * does, and `ready` is a module-scope Map — the second call in a process is a
 * cache hit that reclaims nothing. It failed 9 of 10 reruns, which is the shape.
 */
const NON_REPLAYABLE = /^test\/(live|integration)\/|^test\/platform\/test-db-reclaim\.test\.ts$/;

/**
 * No document exclusion any more, and the reason it existed is gone.
 *
 * `dom.ts` used to register happy-dom for one file, decided from `Bun.main`,
 * which names one file only when each gets its own process. This run is
 * deliberately *not* `--isolate`, so every browser test after the first got
 * `HTMLElement is not defined`: 195 failures on the 2026-08-22 nightly, 20 of 21
 * distinct ones this. The preload registers once per worker now, which is what
 * lets `bun run test` drop `--isolate` too.
 */
/**
 * `{ts,tsx}`, and the extension is the whole finding.
 *
 * The exclusion above was removed and the glob was not, so `*.test.ts` kept
 * every one of the 38 `test/web/*.test.tsx` files out — this job hunts
 * cross-file order dependence and had never once run a browser test. What
 * reached CI instead was a `RangeError: Maximum call stack size exceeded` across
 * the web suite, happy-dom's focus/blur bouncing off `@radix-ui/react-focus-scope`,
 * in the one configuration nothing local reproduces.
 */
export function stressFiles(): string[] {
  return [...new Bun.Glob("test/**/*.test.{ts,tsx}").scanSync({ cwd: ".", absolute: false })]
    .filter((file) => !NON_REPLAYABLE.test(file))
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
  if (rawSeed === undefined) return [TIMEOUT, "--randomize", "--rerun-each", "10"];
  const seed = Number(rawSeed);
  if (!Number.isSafeInteger(seed)) throw new Error("BUN_TEST_SEED must be a safe integer");
  return [TIMEOUT, "--randomize", "--seed", String(seed), "--rerun-each", "10"];
}

if (import.meta.main) {
  // `process.on("exit")` and not also an explicit call at the end: the handler is
  // the one that runs when the spawn throws, and it already runs on the ordinary
  // path.
  process.on("exit", claim());
  const child = Bun.spawn(["bun", "test", ...stressFiles(), ...stressArgs(process.env)], {
    env: { ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "1000" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
