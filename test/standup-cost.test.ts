import { expect, test } from "bun:test";
import { openMemory, type DB } from "../src/db.ts";
import { runStandup, STALL_MS } from "../src/mech/standup.ts";
import { costReport, recentCacheRatio } from "../src/mech/cost.ts";

const NOW = 10_000_000;

function seed(): DB {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  return db;
}

const grp = (db: DB, name: string, owns: string[], status = "RUNNING") =>
  db
    .query<{ id: number }, [string, string, string]>(
      "INSERT INTO grp (project_id, name, status, owns_json, created_at) VALUES (1, ?, ?, ?, 0) RETURNING id",
    )
    .get(name, status, JSON.stringify(owns))!.id;

test("boundaries widened after starting are caught", () => {
  const db = seed();
  const a = grp(db, "auth", ["src/auth/**"]);
  const b = grp(db, "authz", ["src/auth/mw.ts"]);
  db.run("INSERT INTO event (grp_id, author, kind, at) VALUES (?, 'x', 'say', ?)", [a, NOW]);
  db.run("INSERT INTO event (grp_id, author, kind, at) VALUES (?, 'x', 'say', ?)", [b, NOW]);

  const items = runStandup(db, NOW);
  const dup = items.find((i) => i.kind === "duplicate_effort")!;
  // canStart refuses this at the start, so seeing it later means someone widened
  // their glob mid-flight.
  expect(dup).toBeDefined();
  expect(dup.body).toContain("widened");
  expect(dup.grpIds.sort()).toEqual([a, b].sort());
});

test("groups in different projects are not duplicates", () => {
  const db = seed();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('q', '/tmp/q', 0)");
  grp(db, "a", ["src/**"]);
  db.run("INSERT INTO grp (project_id, name, status, owns_json, created_at) VALUES (2, 'b', 'RUNNING', ?, 0)", [
    JSON.stringify(["src/**"]),
  ]);
  expect(runStandup(db, NOW).some((i) => i.kind === "duplicate_effort")).toBe(false);
});

test("silence is the problem, waiting is not", () => {
  const db = seed();
  const quiet = grp(db, "quiet", ["src/a/**"]);
  const blocked = grp(db, "blocked", ["src/b/**"]);
  const old = NOW - STALL_MS - 60_000;
  db.run("INSERT INTO event (grp_id, author, kind, at) VALUES (?, 'x', 'say', ?)", [quiet, old]);
  db.run("INSERT INTO event (grp_id, author, kind, at) VALUES (?, 'x', 'say', ?)", [blocked, old]);
  // A group waiting on an answer is fine: somebody knows about it.
  db.run(
    "INSERT INTO escalation (grp_id, severity, question, chain_state, created_at) VALUES (?, 'blocker', 'q', 'boss', 0)",
    [blocked],
  );

  const stalled = runStandup(db, NOW).filter((i) => i.kind === "stalled");
  expect(stalled.length).toBe(1);
  expect(stalled[0]!.grpIds).toEqual([quiet]);
});

test("a gate failing across several groups is a project problem", () => {
  const db = seed();
  const a = grp(db, "a", ["src/a/**"]);
  const b = grp(db, "b", ["src/b/**"]);
  db.run("INSERT INTO resource (name, template) VALUES ('test', 'true')");
  const ins = db.prepare("INSERT INTO lease (resource, grp_id, state, enqueued_at) VALUES ('test', ?, 'failed', 0)");
  ins.run(a);
  ins.run(b);
  const item = runStandup(db, NOW).find((i) => i.kind === "repeat_failure")!;
  expect(item.body).toContain("likely the project");
});

test("a gate that has since gone green stops being reported", () => {
  const db = seed();
  const a = grp(db, "a", ["src/a/**"]);
  const b = grp(db, "b", ["src/b/**"]);
  db.run("INSERT INTO resource (name, template) VALUES ('test', 'true')");
  const ins = db.prepare("INSERT INTO lease (resource, grp_id, state, enqueued_at) VALUES ('test', ?, ?, 0)");
  ins.run(a, "failed");
  ins.run(b, "failed");
  // Both fixed it. Counting every failed row ever recorded left this on the
  // boss's notification forever, with nothing that could clear it.
  ins.run(a, "done");
  ins.run(b, "done");
  expect(runStandup(db, NOW).some((i) => i.kind === "repeat_failure")).toBe(false);
});

test("one group failing its own gate is not a standup item", () => {
  const db = seed();
  const a = grp(db, "a", ["src/a/**"]);
  db.run("INSERT INTO resource (name, template) VALUES ('test', 'true')");
  const ins = db.prepare("INSERT INTO lease (resource, grp_id, state, enqueued_at) VALUES ('test', ?, 'failed', 0)");
  ins.run(a);
  ins.run(a);
  expect(runStandup(db, NOW).some((i) => i.kind === "repeat_failure")).toBe(false);
});

// ----------------------------------------------------------------------- cost

test("cost is attributed three ways, because they answer different questions", () => {
  const db = seed();
  db.run(
    "INSERT INTO grp (project_id, name, status, spent_tokens, spent_usd, created_at) VALUES (1, 'g1', 'RUNNING', 5000, 1.25, 0)",
  );
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, total_tokens, total_usd, created_at) VALUES (1, 1, 'engineer', 'm', 4000, 1.0, 0)",
  );
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, total_tokens, total_usd, created_at) VALUES (1, 1, 'qa', 'm', 1000, 0.25, 0)",
  );
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, spent_tokens, spent_usd, created_at) VALUES (1, 1, 'S1', 'x', 'trivial', 1000, 0.05, 0)",
  );
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, spent_tokens, spent_usd, created_at) VALUES (1, 2, 'S2', 'x', 'hard', 4000, 1.2, 0)",
  );

  const r = costReport(db, 1);
  expect(r.total.usd).toBeCloseTo(1.25);
  expect(r.byRole[0]!.label).toBe("engineer");
  // Difficulty is the boss's cost knob, and a knob nobody measures gets turned
  // at random.
  expect(r.byDifficulty[0]!.label).toBe("hard");
  expect(r.byDifficulty[0]!.usd).toBeCloseTo(1.2);
});

test("cache ratio is averaged from recorded turns, and absent before any run", () => {
  const db = seed();
  expect(recentCacheRatio(db)).toBeNull();
  const ins = db.prepare("INSERT INTO event (author, kind, meta_json, at) VALUES ('e', 'tool_summary', ?, 0)");
  ins.run(JSON.stringify({ cacheRatio: 0.9 }));
  ins.run(JSON.stringify({ cacheRatio: 0.7 }));
  // A sudden drop here is the only visible sign that prompt assembly broke: the
  // agents still work and the tests still pass, each turn just costs 3-5x.
  expect(recentCacheRatio(db)).toBeCloseTo(0.8);
});
