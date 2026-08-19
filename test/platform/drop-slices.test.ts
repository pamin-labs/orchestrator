import { expect, test } from "bun:test";
import { dropSlices, openMemory, SLICE_REFS, type DB } from "../../src/platform/persistence/database.ts";
import * as fx from "../support/factories.ts";

/**
 * Re-approving a DRAFT rewrites the plan, so the old slices go — and four tables
 * point at a slice, not one. Live, approving a card for a group that had already
 * run died on `FOREIGN KEY constraint failed`, which names neither the table nor
 * the row, and the boss's only move was to click again.
 */
function seed(db: DB): number {
  const p = fx.project.insert(db, { id: 1, name: "p" });
  const g = fx.grp.insert(db, { id: 7, project_id: p.id, name: "g" });
  const s = fx.slice.insert(db, { grp_id: g.id, seq: 1, title: "t", accept_spec: "a" });
  const s2 = fx.slice.insert(db, { grp_id: g.id, seq: 2, title: "t2", accept_spec: "a2", depends_on: s.id });
  fx.task.insert(db, { grp_id: g.id, slice_id: s.id, title: "task" });
  fx.job.insert(db, { kind: "gate", grp_id: g.id, slice_id: s.id });
  fx.note.insert(db, { grp_id: g.id, slice_id: s.id, kind: "journal", body: "x" });
  void s2;
  return g.id;
}

test("dropping a group's slices clears every reference to them first", () => {
  const db = openMemory();
  dropSlices(db, seed(db));

  expect(db.query<{ n: number }, []>("SELECT count(*) n FROM slice").get()!.n).toBe(0);
  // The plan goes with the slices.
  expect(db.query<{ n: number }, []>("SELECT count(*) n FROM task").get()!.n).toBe(0);
  // What happened does not: a job and a journal entry survive, pointing at nothing.
  expect(db.query<{ n: number; s: number | null }, []>("SELECT count(*) n, max(slice_id) s FROM job").get()).toEqual({
    n: 1,
    s: null,
  });
  expect(db.query<{ n: number; s: number | null }, []>("SELECT count(*) n, max(slice_id) s FROM note").get()).toEqual({
    n: 1,
    s: null,
  });
});

test("every foreign key onto slice has a policy in SLICE_REFS", () => {
  const db = openMemory();
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);

  const missing: string[] = [];
  for (const t of tables) {
    for (const fk of db.query<{ table: string; from: string }, []>(`PRAGMA foreign_key_list(${t})`).all()) {
      if (fk.table !== "slice") continue;
      if (!SLICE_REFS[t]?.[fk.from]) missing.push(`${t}.${fk.from}`);
    }
  }
  // A new table with a slice_id is exactly how this bug came back the first time.
  expect(missing).toEqual([]);
});
