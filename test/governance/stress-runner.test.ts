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
  // And the one whose property is inside the file: it asserts what the *first*
  // `openMemory` for a namespace does, and the cache that makes it first is
  // module-scope. It failed 9 of 10 reruns.
  expect(files).not.toContain("test/platform/test-db-reclaim.test.ts");
});

test("stress replay forwards Bun's failing seed, and carries the hang threshold", () => {
  expect(stressArgs({ BUN_TEST_SEED: "1234" })).toEqual([
    "--timeout=20000",
    "--randomize",
    "--seed",
    "1234",
    "--rerun-each",
    "10",
  ]);
  // Bun's default concurrency, not a cap. Interleaving is what this job hunts, so
  // narrowing it to a fifth of the default searched less for no recorded reason.
  expect(stressArgs({})).not.toContain("--max-concurrency");
  expect(() => stressArgs({ BUN_TEST_SEED: "not-a-seed" })).toThrow("BUN_TEST_SEED must be a safe integer");
});
