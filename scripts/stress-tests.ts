export const NON_REPLAYABLE = new Set(["test/sandbox-live.test.ts", "test/smoke.test.ts"]);

export function stressFiles(): string[] {
  return [...new Bun.Glob("test/**/*.test.ts").scanSync({ cwd: ".", absolute: false })]
    .filter((file) => !NON_REPLAYABLE.has(file))
    .toSorted();
}

if (import.meta.main) {
  const child = Bun.spawn(
    ["bun", "test", ...stressFiles(), "--randomize", "--rerun-each", "10", "--max-concurrency", "4"],
    {
      env: { ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "1000" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exitCode = await child.exited;
}
