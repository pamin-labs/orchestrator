import { expect, test } from "bun:test";
import { dropSlices, openMemory, SLICE_REFS, type DB } from "../src/db.ts";

/**
 * Re-approving a DRAFT rewrites the plan, so the old slices go — and four tables
 * point at a slice, not one. Live, approving a card for a group that had already
 * run died on `FOREIGN KEY constraint failed`, which names neither the table nor
 * the row, and the boss's only move was to click again.
 */
function seed(db: DB): number {
  db.run("INSERT INTO project (id, name, repo_path, created_at) VALUES (1, 'p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (id, project_id, name, status, created_at) VALUES (7, 1, 'g', 'DRAFT', 0)");
  const s = db
    .query<{ id: number }, []>(
      `INSERT INTO slice (grp_id, seq, title, accept_spec, created_at)
       VALUES (7, 1, 't', 'a', 0) RETURNING id`,
    )
    .get()!;
  const s2 = db
    .query<{ id: number }, [number]>(
      `INSERT INTO slice (grp_id, seq, title, accept_spec, depends_on, created_at)
       VALUES (7, 2, 't2', 'a2', ?, 0) RETURNING id`,
    )
    .get(s.id)!;
  db.run("INSERT INTO task (grp_id, slice_id, title, created_at) VALUES (7, ?, 'task', 0)", [s.id]);
  db.run("INSERT INTO job (kind, grp_id, slice_id, enqueued_at) VALUES ('gate', 7, ?, 0)", [s.id]);
  db.run("INSERT INTO note (grp_id, slice_id, kind, body, at) VALUES (7, ?, 'journal', 'x', 0)", [s.id]);
  void s2;
  return 7;
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
