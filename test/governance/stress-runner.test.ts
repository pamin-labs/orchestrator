import { expect, test } from "bun:test";
import { stressArgs, stressFiles } from "../../scripts/stress-tests.ts";

test("stress repeats replay-safe suites and leaves stateful live integration to main CI", () => {
  const files = stressFiles();
  expect(files).toContain("test/governance/properties.test.ts");
  expect(files).toContain("test/governance/transaction-boundaries.test.ts");
  expect(files).not.toContain("test/integration/smoke.test.ts");
  expect(files).not.toContain("test/live/sandbox-live.test.ts");
  // The exclusion is the directory, not the two filenames it used to name, so a
  // third live suite is excluded on the day it is written.
  expect(files.filter((file) => file.startsWith("test/live/") || file.startsWith("test/integration/"))).toEqual([]);
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
