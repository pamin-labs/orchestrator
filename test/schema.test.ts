import { expect, test } from "bun:test";
import { migrate, openMemory } from "../src/db.ts";

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
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  const ins = db.prepare(
    "INSERT INTO agent (project_id, role, model, token, created_at) VALUES (1, 'engineer', 'sonnet', ?, 0)",
  );
  ins.run("tok-a");
  expect(() => ins.run("tok-a")).toThrow();
  // Retired agents keep their row with a cleared token; several may coexist.
  ins.run(null);
  ins.run(null);
});

test("foreign keys are enforced", () => {
  const db = openMemory();
  expect(() =>
    db.run("INSERT INTO grp (project_id, name, created_at) VALUES (999, 'x', 0)"),
  ).toThrow();
});

test("event.seq is monotonic — the timeline never reorders", () => {
  const db = openMemory();
  const ins = db.prepare("INSERT INTO event (author, kind, body, at) VALUES (?, ?, ?, ?)");
  for (const b of ["a", "b", "c"]) ins.run("engineer", "say", b, Date.now());
  const seqs = db.query<{ seq: number }, []>("SELECT seq FROM event ORDER BY seq").all();
  expect(seqs.map((r) => r.seq)).toEqual([1, 2, 3]);
});

test("slice seq is unique per group", () => {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, created_at) VALUES (1, 'g', 0)");
  const ins = db.prepare(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (?, ?, ?, ?, 0)",
  );
  ins.run(1, 1, "S1", "tests pass");
  expect(() => ins.run(1, 1, "dup", "x")).toThrow();
});
