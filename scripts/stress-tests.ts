export const NON_REPLAYABLE = new Set(["test/sandbox-live.test.ts", "test/smoke.test.ts"]);

export function stressFiles(): string[] {
  return [...new Bun.Glob("test/**/*.test.ts").scanSync({ cwd: ".", absolute: false })]
    .filter((file) => !NON_REPLAYABLE.has(file))
    .toSorted();
}

export function stressArgs(env: Readonly<Record<string, string | undefined>>): string[] {
  const rawSeed = env.BUN_TEST_SEED;
  if (rawSeed === undefined) return ["--randomize", "--rerun-each", "10", "--max-concurrency", "4"];
  const seed = Number(rawSeed);
  if (!Number.isSafeInteger(seed)) throw new Error("BUN_TEST_SEED must be a safe integer");
  return ["--randomize", "--seed", String(seed), "--rerun-each", "10", "--max-concurrency", "4"];
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
