import { expect, test } from "bun:test";
import { stressArgs, stressFiles } from "../../scripts/stress-tests.ts";
import { needsDom } from "../../scripts/needs-dom.ts";

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

/**
 * The compensation for the flag this run does not carry.
 *
 * `preload-scope` holds every `package.json` script containing `bun test` to
 * `--parallel` or `--isolate`; this run spawns `bun test` from a script, so that
 * check never saw it, and it is deliberately not isolated — cross-file order
 * dependence is the whole point. So `dom.ts`'s gate reads a `Bun.main` that names
 * the first file only, and every browser test after it got `HTMLElement is not
 * defined`: 195 failures on the 2026-08-22 nightly, 20 of the 21 distinct ones
 * this. They run under `bun run test`, which gives each its own process.
 */
test("stress leaves out the files that need a document, because it cannot give them one", () => {
  expect(stressFiles().filter(needsDom)).toEqual([]);
  // And it is not excluding everything: the pass still has something to stress.
  expect(stressFiles().length).toBeGreaterThan(100);
});

test("stress replay forwards Bun's failing seed", () => {
  expect(stressArgs({ BUN_TEST_SEED: "1234" })).toEqual(["--randomize", "--seed", "1234", "--rerun-each", "10"]);
  // Bun's default concurrency, not a cap. Interleaving is what this job hunts, so
  // narrowing it to a fifth of the default searched less for no recorded reason.
  expect(stressArgs({})).not.toContain("--max-concurrency");
  expect(() => stressArgs({ BUN_TEST_SEED: "not-a-seed" })).toThrow("BUN_TEST_SEED must be a safe integer");
});
