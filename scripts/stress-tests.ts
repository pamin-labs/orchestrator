/**
 * Suites that carry state across a run, so repeating them proves nothing.
 *
 * This used to be a list of two filenames, which meant the next non-replayable
 * suite was replayed until somebody remembered the list existed. The two
 * directories are the property: `live` talks to a real OpenSandbox server and
 * `integration` boots a real server on a real port.
 */
const NON_REPLAYABLE = /^test\/(live|integration)\//;

export function stressFiles(): string[] {
  return [...new Bun.Glob("test/**/*.test.ts").scanSync({ cwd: ".", absolute: false })]
    .filter((file) => !NON_REPLAYABLE.test(file))
    .toSorted();
}

/**
 * Serial and randomised, deliberately, where `bun run test` is `--parallel`.
 *
 * `--parallel` implies `--isolate`, which gives every file a fresh global — and
 * cross-file order dependence is exactly what this job exists to find. Running
 * the stress pass the same way as CI would test the configuration that cannot
 * have the bug. One shared process, shuffled, ten times over is the harder case.
 *
 * Concurrency is Bun's default rather than the `--max-concurrency 4` this used to
 * pass, which had no recorded reason and was backwards for the job: interleaving
 * is what a stress pass hunts, so capping it at a fifth of the default narrowed
 * the space being searched.
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
