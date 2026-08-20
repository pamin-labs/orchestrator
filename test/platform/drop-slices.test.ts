import { expect, test } from "bun:test";
import { count, getTableName, sql } from "drizzle-orm";
import { z } from "zod";
import { valueOr } from "../../src/contracts/json.ts";
import { dropSlices, openMemory, SLICE_REFS, type DB } from "../../src/platform/persistence/database.ts";
import { job, note, slice, task } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";

/**
 * Re-approving a DRAFT rewrites the plan, so the old slices go — and four tables
 * point at a slice, not one. Live, approving a card for a group that had already
 * run died on `FOREIGN KEY constraint failed`, which names neither the table nor
 * the row, and the boss's only move was to click again.
 */
async function seed(db: DB): Promise<number> {
  const f = fx.on(db);
  const p = await f.project.create({ id: 1, name: "p" });
  const g = await f.grp.create({ id: 7, project_id: p.id, name: "g" });
  const s = await f.slice.create({ grp_id: g.id, seq: 1, title: "t", accept_spec: "a" });
  const s2 = await f.slice.create({ grp_id: g.id, seq: 2, title: "t2", accept_spec: "a2", depends_on: s.id });
  await f.task.create({ grp_id: g.id, slice_id: s.id, title: "task" });
  await f.job.create({ kind: "gate", grp_id: g.id, slice_id: s.id });
  await f.note.create({ grp_id: g.id, slice_id: s.id, kind: "journal", body: "x" });
  void s2;
  return g.id;
}

test("dropping a group's slices clears every reference to them first", async () => {
  const db = await openMemory();
  await dropSlices(db, await seed(db));

  const rows = async (table: typeof slice | typeof task) => (await db.select({ n: count() }).from(table))[0]?.n;
  expect(await rows(slice)).toBe(0);
  // The plan goes with the slices.
  expect(await rows(task)).toBe(0);
  // What happened does not: a job and a journal entry survive, pointing at nothing.
  expect(await db.select({ n: count(), s: count(job.slice_id) }).from(job)).toEqual([{ n: 1, s: 0 }]);
  expect(await db.select({ n: count(), s: count(note.slice_id) }).from(note)).toEqual([{ n: 1, s: 0 }]);
});

/** Postgres has no `PRAGMA foreign_key_list`; the catalog says the same thing. */
const ForeignKeys = z.array(z.object({ tbl: z.string(), col: z.string() }));

test("every foreign key onto slice has a policy in SLICE_REFS", async () => {
  const db = await openMemory();
  // `pg_catalog`, not `information_schema`: those views join across every relation
  // in the database, and the suite now shares one database across 193 namespaces —
  // 6,534 relations, where this took over five seconds and timed the test out.
  const result = await db.execute(sql`
    SELECT c.relname AS tbl, a.attname AS col
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_class f ON f.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.contype = 'f' AND n.nspname = current_schema() AND f.relname = 'slice'`);
  const found = valueOr(result, ForeignKeys, []);
  expect(found.length).toBeGreaterThan(0);

  const covered = new Set(SLICE_REFS.map((ref) => `${getTableName(ref.table)}.${ref.column.name}`));
  // A new table with a slice_id is exactly how this bug came back the first time.
  expect(found.map((fk) => `${fk.tbl}.${fk.col}`).filter((ref) => !covered.has(ref))).toEqual([]);
});
