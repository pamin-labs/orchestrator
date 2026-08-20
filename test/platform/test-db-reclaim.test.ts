import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { openMemory, suffixFor } from "../../src/platform/persistence/database.ts";

/**
 * A file collects its own namespaces from older migrations as it makes its new one.
 *
 * The name carries the migrations' hash, so changing them orphans every test
 * namespace at once. Nothing collected them: 197 databases and 1,799 MB before
 * this existed, in a tmpfs, so it was 3 GB of resident memory.
 */

test("an older generation of this file's namespace is dropped, and the current one is not", async () => {
  const isolate = "reclaim-guard";
  const suffix = suffixFor(isolate);
  const stale = `t_deadbeef00_${suffix}`;

  const db = await openMemory();
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${stale}" CASCADE`));
  await db.execute(sql.raw(`CREATE SCHEMA "${stale}"`));

  const generations = async (): Promise<string[]> => {
    const tail = `_${suffix}`;
    const rows = await db
      .select({ nspname: sql<string>`nspname` })
      .from(sql`pg_namespace`)
      .where(sql`starts_with(nspname, 't_') AND right(nspname, ${tail.length}) = ${tail}`);
    return rows.map((r) => r.nspname);
  };
  expect(await generations()).toContain(stale);

  // The first `openMemory` for an isolate is the one that creates and collects.
  await openMemory(undefined, isolate);

  const left = await generations();
  expect(left).not.toContain(stale);
  // And exactly one survives: this schema's, which the call just made.
  expect(left).toHaveLength(1);
}, 60_000);
