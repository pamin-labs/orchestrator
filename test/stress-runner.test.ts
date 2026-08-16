import { expect, test } from "bun:test";
import { stressFiles } from "../scripts/stress-tests.ts";

test("stress repeats replay-safe suites and leaves stateful live integration to main CI", () => {
  const files = stressFiles();
  expect(files).toContain("test/properties.test.ts");
  expect(files).toContain("test/transaction-boundaries.test.ts");
  expect(files).not.toContain("test/smoke.test.ts");
  expect(files).not.toContain("test/sandbox-live.test.ts");
});
