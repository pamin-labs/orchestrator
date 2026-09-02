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

  // Every browser file, and by comparison with the disk rather than a number.
  //
  // The document exclusion was removed and the glob was not: `*.test.ts` does not
  // match `*.test.tsx`, so all 38 of them stayed out of the job that exists to
  // find cross-file order dependence, under a comment saying they no longer were.
  // A count would pass again the moment one file was added and the glob was not.
  const browser = [...new Bun.Glob("test/**/*.test.tsx").scanSync({ cwd: ".", absolute: false })].toSorted();
  expect(browser.length).toBeGreaterThan(0);
  expect(files.filter((file) => file.endsWith(".tsx"))).toEqual(browser);
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
