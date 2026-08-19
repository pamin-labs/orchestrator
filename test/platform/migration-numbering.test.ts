import { expect, test } from "bun:test";

/**
 * The number in a migration's comment is the version it will be recorded as.
 *
 * `migrate()` stamps the `migration` table with the array index, so the comment
 * beside each entry is the only place a reader learns which version they are
 * looking at. Seventeen of forty had drifted — an entry inserted mid-array
 * renumbers everything below it, and nothing noticed — so `// 036` sat on
 * version 28 and `// 022` appeared twice.
 */

test("every migration's comment number is its array index", async () => {
  const source = await Bun.file("src/platform/persistence/database.ts").text();
  const body = source.slice(source.indexOf("const MIGRATIONS"));
  const numbered = [...body.matchAll(/^ {2}\/\/ (\d{3}) — /gm)].map((m) => m[1]!);
  expect(numbered.length).toBeGreaterThan(30);
  const wrong = numbered
    .map((seen, i) => ({ seen, expected: String(i + 1).padStart(3, "0") }))
    .filter((row) => row.seen !== row.expected);
  expect(wrong).toEqual([]);
});

test("a migration number mentioned in prose points at a migration that exists", async () => {
  // Renumbering the headings is only half of it: the prose cross-references
  // ("dropped by migration 024", "042 put `trace_id` on jobs") are the other half,
  // and they go stale silently — nothing reads them but a person.
  const source = await Bun.file("src/platform/persistence/database.ts").text();
  const body = source.slice(source.indexOf("const MIGRATIONS"));
  const total = [...body.matchAll(/^ {2}\/\/ (\d{3}) — /gm)].length;
  const mentioned = [...body.matchAll(/migration (\d{3})|^ *\/\/ (\d{3}) (?!— )/gm)]
    .map((m) => Number(m[1] ?? m[2]))
    .filter((n) => Number.isFinite(n));
  expect(mentioned.length).toBeGreaterThan(0);
  expect(mentioned.filter((n) => n < 1 || n > total)).toEqual([]);
});
