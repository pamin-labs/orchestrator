import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

/**
 * No comment cites a migration by number, because nothing carries one.
 *
 * This file used to check that each entry in the hand-written `MIGRATIONS` array
 * was numbered by its own index — seventeen of forty had drifted, because an
 * entry inserted mid-array renumbers everything below it. Drizzle owns migrations
 * now and names them by folder, so the numbers are gone and the six comments that
 * still cited one ("migration 039 moved the row across") pointed at nothing a
 * reader could look up. The stale-pointer class survives; its shape changed.
 */
const sources = () => [
  ...new Glob("src/**/*.ts").scanSync("."),
  ...new Glob("test/**/*.ts").scanSync("."),
  ...new Glob("web/src/**/*.tsx").scanSync("."),
];

test("no comment points at a migration number that nobody can look up", () => {
  // Two globs, not one with braces in both halves: `{src,test}/**/*.{ts,tsx}`
  // silently matches nothing in Bun, and a scanner over no files is a test that
  // passes for ever. The count below is what says it looked.
  const scanned = sources();
  expect(scanned.length).toBeGreaterThan(200);
  const cited = scanned.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        /migration \d{3}\b/i.test(line) && !path.endsWith("migration-numbering.test.ts")
          ? [`${path}:${i + 1}  ${line.trim().slice(0, 70)}`]
          : [],
      ),
  );
  expect(cited).toEqual([]);
});
