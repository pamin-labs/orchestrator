import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { openMemory, suffixFor } from "../../src/platform/persistence/database.ts";

/**
 * A file collects its own databases from older schemas as it makes its new one.
 *
 * The name carries the schema's hash, so changing the schema orphans every test
 * database at once. Nothing collected them: 197 databases and 1,799 MB on this
 * branch, 858 MB of it schemas no longer in the tree — and the data directory is
 * a tmpfs, so it was 3 GB of resident memory.
 */

test("an older generation of this file's database is dropped, and the current one is not", async () => {
  const isolate = "reclaim-guard";
  const suffix = suffixFor(isolate);
  const stale = `orch_test_deadbeef00_${suffix}`;

  // `pg_database` is a shared catalogue, so any connection can see and make them.
  const db = await openMemory();
  await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${stale}" WITH (FORCE)`));
  await db.execute(sql.raw(`CREATE DATABASE "${stale}"`));

  const generations = async (): Promise<string[]> => {
    const tail = `_${suffix}`;
    const rows = await db
      .select({ datname: sql<string>`datname` })
      .from(sql`pg_database`)
      .where(sql`starts_with(datname, 'orch_test_') AND right(datname, ${tail.length}) = ${tail}`);
    return rows.map((r) => r.datname);
  };
  expect(await generations()).toContain(stale);

  // The first `openMemory` for an isolate is the one that creates and collects.
  await openMemory(undefined, isolate);

  const left = await generations();
  expect(left).not.toContain(stale);
  // And exactly one survives: this schema's, which the call just made.
  expect(left).toHaveLength(1);
}, 60_000);
