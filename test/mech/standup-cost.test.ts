import { expect, test } from "bun:test";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { runStandup, STALL_MS } from "../../src/mech/flow/standup.ts";
import { costReport, recentCacheRatio } from "../../src/mech/ops/cost.ts";
import * as fx from "../support/factories.ts";

const NOW = 10_000_000;

function seed(): DB {
  const db = openMemory();
  fx.project.insert(db, { name: "p" });
  return db;
}

const grp = (db: DB, name: string, owns: string[], status = "RUNNING") =>
  fx.grp.insert(db, { project_id: 1, name, status, owns_json: JSON.stringify(owns) }).id;

test("boundaries widened after starting are caught", () => {
  const db = seed();
  const a = grp(db, "auth", ["src/auth/**"]);
  const b = grp(db, "authz", ["src/auth/mw.ts"]);
  fx.event.insert(db, { grp_id: a, at: NOW });
  fx.event.insert(db, { grp_id: b, at: NOW });

  const items = runStandup(db, NOW);
  const dup = items.find((i) => i.kind === "duplicate_effort")!;
  // canStart refuses this at the start, so seeing it later means someone widened
  // their glob mid-flight.
  expect(dup).toBeDefined();
  expect(dup.body).toContain("widened");
  expect(dup.grpIds.sort((left, right) => left - right)).toEqual([a, b].sort((left, right) => left - right));
});

test("groups in different projects are not duplicates", () => {
  const db = seed();
  const q = fx.project.insert(db, { name: "q", repo_path: "/tmp/q" });
  grp(db, "a", ["src/**"]);
  fx.runningGrp.insert(db, { project_id: q.id, name: "b", owns_json: JSON.stringify(["src/**"]) });
  expect(runStandup(db, NOW).some((i) => i.kind === "duplicate_effort")).toBe(false);
});

test("silence is the problem, waiting is not", () => {
  const db = seed();
  const quiet = grp(db, "quiet", ["src/a/**"]);
  const blocked = grp(db, "blocked", ["src/b/**"]);
  const old = NOW - STALL_MS - 60_000;
  fx.event.insert(db, { grp_id: quiet, at: old });
  fx.event.insert(db, { grp_id: blocked, at: old });
  // A group waiting on an answer is fine: somebody knows about it.
  fx.escalation.insert(db, { grp_id: blocked, severity: "blocker", chain_state: "boss" });

  const stalled = runStandup(db, NOW).filter((i) => i.kind === "stalled");
  expect(stalled.length).toBe(1);
  expect(stalled[0]!.grpIds).toEqual([quiet]);
});

test("a gate failing across several groups is a project problem", () => {
  const db = seed();
  const a = grp(db, "a", ["src/a/**"]);
  const b = grp(db, "b", ["src/b/**"]);
  fx.resource.insert(db, { name: "test" });
  const failed = (grp_id: number) => fx.lease.insert(db, { resource: "test", grp_id, state: "failed" });
  failed(a);
  failed(b);
  const item = runStandup(db, NOW).find((i) => i.kind === "repeat_failure")!;
  expect(item.body).toContain("likely the project");
});

test("a gate that has since gone green stops being reported", () => {
  const db = seed();
  const a = grp(db, "a", ["src/a/**"]);
  const b = grp(db, "b", ["src/b/**"]);
  fx.resource.insert(db, { name: "test" });
  const lease = (grp_id: number, state: string) => fx.lease.insert(db, { resource: "test", grp_id, state });
  lease(a, "failed");
  lease(b, "failed");
  // Both fixed it. Counting every failed row ever recorded left this on the
  // boss's notification forever, with nothing that could clear it.
  lease(a, "done");
  lease(b, "done");
  expect(runStandup(db, NOW).some((i) => i.kind === "repeat_failure")).toBe(false);
});

test("one group failing its own gate is not a standup item", () => {
  const db = seed();
  const a = grp(db, "a", ["src/a/**"]);
  fx.resource.insert(db, { name: "test" });
  const failed = (grp_id: number) => fx.lease.insert(db, { resource: "test", grp_id, state: "failed" });
  failed(a);
  failed(a);
  expect(runStandup(db, NOW).some((i) => i.kind === "repeat_failure")).toBe(false);
});

// ----------------------------------------------------------------------- cost

test("cost is attributed four ways, because they answer different questions", () => {
  const db = seed();
  fx.runningGrp.insert(db, { project_id: 1, name: "g1", spent_tokens: 5000 });
  fx.agent.insert(db, { project_id: 1, grp_id: 1, total_tokens: 4000 });
  fx.agent.insert(db, { project_id: 1, grp_id: 1, role: "qa", runtime: "codex", total_tokens: 1000 });
  fx.slice.insert(db, { grp_id: 1, seq: 1, title: "S1", difficulty: "trivial", spent_tokens: 1000 });
  fx.slice.insert(db, { grp_id: 1, seq: 2, title: "S2", difficulty: "hard", spent_tokens: 4000 });

  const r = costReport(db, 1);
  expect(r.total.tokens).toBe(5000);
  expect(r.byRole[0]!.label).toBe("engineer");
  // Difficulty is the boss's cost knob, and a knob nobody measures gets turned
  // at random.
  expect(r.byDifficulty[0]!.label).toBe("hard");
  expect(r.byDifficulty[0]!.tokens).toBe(4000);

  // Which subscription paid. Two accounts is the whole reason this axis exists.
  expect(r.byRuntime.map((x) => [x.label, x.tokens])).toEqual([
    ["claude", 4000],
    ["codex", 1000],
  ]);

  expect(r.byRole.map((x) => x.label)).toEqual(["engineer", "qa"]);

  // Per agent, not per role, and carrying the model: the panel nests project ->
  // requirement -> the people in it, and "the engineer took 4M" is half a fact
  // until you know which model it took them on.
  expect(r.agents.map((a) => [a.role, a.model, a.tokens])).toEqual([
    ["engineer", "m", 4000],
    ["qa", "m", 1000],
  ]);
  expect(r.agents.every((a) => a.grpId === 1)).toBe(true);

  // No dollars anywhere in the report. Two subscriptions pay for this, so the
  // figure was notional on the half that reported one and absent on the other.
  expect(JSON.stringify(r)).not.toContain("usd");
});

test("asking for one project's cost leaves the other project out of every axis", () => {
  // Each axis carries the filter itself now — `?1 IS NULL OR project_id = ?1`,
  // bound rather than pasted in. byDifficulty is the one that has been wrong
  // before: it joins through `grp` for the project, so it is the axis where the
  // filter is easiest to drop, and difficulty is the knob the panel exists to
  // inform. Omitting the id has to keep meaning "every project".
  const db = seed();
  fx.project.insert(db, { name: "q", repo_path: "/tmp/q" });
  const group = (project_id: number, name: string, spent_tokens: number) =>
    fx.runningGrp.insert(db, { project_id, name, spent_tokens });
  group(1, "mine", 5000);
  group(2, "theirs", 900);
  const worker = (project_id: number, grp_id: number, role: string, runtime: string, total_tokens: number) =>
    fx.agent.insert(db, { project_id, grp_id, role, runtime, total_tokens });
  worker(1, 1, "engineer", "claude", 5000);
  worker(2, 2, "auditor", "codex", 900);
  const unit = (grp_id: number, difficulty: string, spent_tokens: number) =>
    fx.slice.insert(db, { grp_id, seq: 1, title: "S", difficulty, spent_tokens });
  unit(1, "hard", 5000);
  unit(2, "trivial", 900);

  const mine = costReport(db, 1);
  expect(mine.total.tokens).toBe(5000);
  expect(mine.byGroup.map((g) => g.label)).toEqual(["mine"]);
  expect(mine.agents.map((a) => a.role)).toEqual(["engineer"]);
  expect(mine.byRole.map((r) => r.label)).toEqual(["engineer"]);
  expect(mine.byRuntime.map((r) => r.label)).toEqual(["claude"]);
  expect(mine.byDifficulty.map((d) => [d.label, d.tokens])).toEqual([["hard", 5000]]);

  const everything = costReport(db);
  expect(everything.total.tokens).toBe(5900);
  expect(everything.byGroup.map((g) => g.label)).toEqual(["mine", "theirs"]);
  expect(everything.byDifficulty.map((d) => d.label).sort()).toEqual(["hard", "trivial"]);
});

test("a delivered requirement is counted for its own project only", () => {
  const db = seed();
  fx.project.insert(db, { name: "q", repo_path: "/tmp/q" });
  const dissolved = (project_id: number, name: string, spent_tokens: number) =>
    fx.grp.insert(db, { project_id, name, status: "DISSOLVED", spent_tokens });
  dissolved(1, "mine", 400);
  dissolved(2, "theirs", 700);

  expect(costReport(db, 1).delivered).toEqual({ count: 1, tokens: 400 });
  expect(costReport(db).delivered).toEqual({ count: 2, tokens: 1100 });
});

test("cache ratio is averaged from recorded turns, and absent before any run", () => {
  const db = seed();
  expect(recentCacheRatio(db)).toBeNull();
  const summary = (cacheRatio: number) =>
    fx.event.insert(db, { author: "e", kind: "tool_summary", meta_json: JSON.stringify({ cacheRatio }) });
  summary(0.9);
  summary(0.7);
  // A sudden drop here is the only visible sign that prompt assembly broke: the
  // agents still work and the tests still pass, each turn just costs 3-5x.
  expect(recentCacheRatio(db)).toBeCloseTo(0.8);
});
