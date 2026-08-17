import { expect, test } from "bun:test";
import { migrate, openMemory } from "../../src/platform/persistence/database.ts";
import * as fx from "../support/factories.ts";

test("migrate creates the four first-class tables plus support tables", () => {
  const db = openMemory();
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);

  for (const t of ["job", "event", "note", "task", "slice"]) expect(names).toContain(t);
  for (const t of ["project", "grp", "agent", "channel", "member", "cursor"]) {
    expect(names).toContain(t);
  }
  for (const t of ["resource", "lease", "escalation"]) expect(names).toContain(t);

  // Deliberately absent: mail folded into `event`; facts/journal/decision/retro
  // folded into `note`. Re-adding them means the abstraction drifted.
  expect(names).not.toContain("mail");
  expect(names).not.toContain("journal");
});

test("migrate is idempotent", () => {
  const db = openMemory();
  const count = () => db.query<{ c: number }, []>("SELECT count(*) AS c FROM migration").get()!.c;
  const applied = count();
  expect(applied).toBeGreaterThan(0);
  migrate(db);
  migrate(db);
  expect(count()).toBe(applied);
});

test("agent tokens are unique, and NULL is not a duplicate", () => {
  const db = openMemory();
  fx.project.insert(db, { name: "p" });
  const hire = (token: string | null) => fx.agent.insert(db, { project_id: 1, model: "sonnet", token });
  hire("tok-a");
  expect(() => hire("tok-a")).toThrow();
  // Retired agents keep their row with a cleared token; several may coexist.
  hire(null);
  hire(null);
});

test("foreign keys are enforced", () => {
  const db = openMemory();
  expect(() => fx.grp.insert(db, { project_id: 999, name: "x" })).toThrow();
});

test("two in-memory databases do not share rows", () => {
  // openMemory() restores a snapshot of the migrated schema instead of replaying
  // every migration, which is most of a test run's time back. The snapshot is
  // process-wide, so the thing worth guarding is that it stays a template: a row
  // written by one test's database must not be visible to the next one's.
  const first = openMemory();
  fx.event.insert(first, { author: "engineer", body: "leak" });
  const second = openMemory();
  expect(second.query<{ c: number }, []>("SELECT count(*) AS c FROM event").get()!.c).toBe(0);
});

test("event.seq is monotonic — the timeline never reorders", () => {
  const db = openMemory();
  for (const body of ["a", "b", "c"]) fx.event.insert(db, { author: "engineer", body, at: Date.now() });
  const seqs = db.query<{ seq: number }, []>("SELECT seq FROM event ORDER BY seq").all();
  expect(seqs.map((r) => r.seq)).toEqual([1, 2, 3]);
});

test("slice seq is unique per group", () => {
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  const g = fx.grp.insert(db, { project_id: p.id, name: "g" });
  const cut = (title: string, accept_spec: string) => fx.slice.insert(db, { grp_id: g.id, seq: 1, title, accept_spec });
  cut("S1", "tests pass");
  expect(() => cut("dup", "x")).toThrow();
});
