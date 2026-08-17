import { expect, test } from "bun:test";
import { stressArgs, stressFiles } from "../scripts/stress-tests.ts";

test("stress repeats replay-safe suites and leaves stateful live integration to main CI", () => {
  const files = stressFiles();
  expect(files).toContain("test/properties.test.ts");
  expect(files).toContain("test/transaction-boundaries.test.ts");
  expect(files).not.toContain("test/smoke.test.ts");
  expect(files).not.toContain("test/sandbox-live.test.ts");
});

test("stress replay forwards Bun's failing seed", () => {
  expect(stressArgs({ BUN_TEST_SEED: "1234" })).toEqual([
    "--randomize",
    "--seed",
    "1234",
    "--rerun-each",
    "10",
    "--max-concurrency",
    "4",
  ]);
  expect(() => stressArgs({ BUN_TEST_SEED: "not-a-seed" })).toThrow("BUN_TEST_SEED must be a safe integer");
});
