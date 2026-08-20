import { expect, test } from "bun:test";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { runStandup, STALL_MS } from "../../src/mech/flow/standup.ts";
import { costReport, recentCacheRatio } from "../../src/mech/ops/cost.ts";
import type { GrpState, LeaseState } from "../../src/contracts/states.ts";
import * as fx from "../support/factories.ts";

const NOW = 10_000_000;

async function seed(): Promise<DB> {
  const db = await openMemory();
  await fx.on(db).project.create({ name: "p" });
  return db;
}

const grp = async (db: DB, name: string, owns: string[], status: GrpState = "RUNNING") =>
  (await fx.on(db).grp.create({ project_id: 1, name, status, owns_json: owns })).id;

test("boundaries widened after starting are caught", async () => {
  const db = await seed();
  const a = await grp(db, "auth", ["src/auth/**"]);
  const b = await grp(db, "authz", ["src/auth/mw.ts"]);
  await fx.on(db).event.create({ grp_id: a, at: NOW });
  await fx.on(db).event.create({ grp_id: b, at: NOW });

  const items = await runStandup(db, NOW);
  const dup = items.find((i) => i.kind === "duplicate_effort")!;
  // canStart refuses this at the start, so seeing it later means someone widened
  // their glob mid-flight.
  expect(dup).toBeDefined();
  expect(dup.body).toContain("widened");
  expect(dup.grpIds.sort((left, right) => left - right)).toEqual([a, b].sort((left, right) => left - right));
});

test("groups in different projects are not duplicates", async () => {
  const db = await seed();
  const q = await fx.on(db).project.create({ name: "q", repo_path: "/tmp/q" });
  await grp(db, "a", ["src/**"]);
  await fx.on(db).runningGrp.create({ project_id: q.id, name: "b", owns_json: ["src/**"] });
  expect((await runStandup(db, NOW)).filter((i) => i.kind === "duplicate_effort")).toEqual([]);
});

test("silence is the problem, waiting is not", async () => {
  const db = await seed();
  const quiet = await grp(db, "quiet", ["src/a/**"]);
  const blocked = await grp(db, "blocked", ["src/b/**"]);
  const old = NOW - STALL_MS - 60_000;
  await fx.on(db).event.create({ grp_id: quiet, at: old });
  await fx.on(db).event.create({ grp_id: blocked, at: old });
  // A group waiting on an answer is fine: somebody knows about it.
  await fx.on(db).escalation.create({ grp_id: blocked, severity: "blocker", chain_state: "boss" });

  const stalled = (await runStandup(db, NOW)).filter((i) => i.kind === "stalled");
  expect(stalled.length).toBe(1);
  expect(stalled[0]!.grpIds).toEqual([quiet]);
});

test("a gate failing across several groups is a project problem", async () => {
  const db = await seed();
  const a = await grp(db, "a", ["src/a/**"]);
  const b = await grp(db, "b", ["src/b/**"]);
  await fx.on(db).resource.create({ name: "test" });
  const failed = (grp_id: number) => fx.on(db).lease.create({ resource: "test", grp_id, state: "failed" });
  await failed(a);
  await failed(b);
  const item = (await runStandup(db, NOW)).find((i) => i.kind === "repeat_failure")!;
  expect(item.body).toContain("likely the project");
});

test("a gate that has since gone green stops being reported", async () => {
  const db = await seed();
  const a = await grp(db, "a", ["src/a/**"]);
  const b = await grp(db, "b", ["src/b/**"]);
  await fx.on(db).resource.create({ name: "test" });
  const lease = (grp_id: number, state: LeaseState) => fx.on(db).lease.create({ resource: "test", grp_id, state });
  await lease(a, "failed");
  await lease(b, "failed");
  // Both fixed it. Counting every failed row ever recorded left this on the
  // boss's notification forever, with nothing that could clear it.
  await lease(a, "done");
  await lease(b, "done");
  expect((await runStandup(db, NOW)).filter((i) => i.kind === "repeat_failure")).toEqual([]);
});

test("one group failing its own gate is not a standup item", async () => {
  const db = await seed();
  const a = await grp(db, "a", ["src/a/**"]);
  await fx.on(db).resource.create({ name: "test" });
  const failed = (grp_id: number) => fx.on(db).lease.create({ resource: "test", grp_id, state: "failed" });
  await failed(a);
  await failed(a);
  expect((await runStandup(db, NOW)).filter((i) => i.kind === "repeat_failure")).toEqual([]);
});

// ----------------------------------------------------------------------- cost

test("cost is attributed four ways, because they answer different questions", async () => {
  const db = await seed();
  const f = fx.on(db);
  await f.runningGrp.create({ project_id: 1, name: "g1", spent_tokens: 5000 });
  await f.agent.create({ project_id: 1, grp_id: 1, total_tokens: 4000 });
  await f.agent.create({ project_id: 1, grp_id: 1, role: "qa", runtime: "codex", total_tokens: 1000 });
  await f.slice.create({ grp_id: 1, seq: 1, title: "S1", difficulty: "trivial", spent_tokens: 1000 });
  await f.slice.create({ grp_id: 1, seq: 2, title: "S2", difficulty: "hard", spent_tokens: 4000 });

  const r = await costReport(db, 1);
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
  expect(r.agents.filter((a) => a.grpId !== 1)).toEqual([]);

  // No dollars anywhere in the report. Two subscriptions pay for this, so the
  // figure was notional on the half that reported one and absent on the other.
  expect(JSON.stringify(r)).not.toContain("usd");
});

test("asking for one project's cost leaves the other project out of every axis", async () => {
  // Each axis carries the filter itself now — `?1 IS NULL OR project_id = ?1`,
  // bound rather than pasted in. byDifficulty is the one that has been wrong
  // before: it joins through `grp` for the project, so it is the axis where the
  // filter is easiest to drop, and difficulty is the knob the panel exists to
  // inform. Omitting the id has to keep meaning "every project".
  const db = await seed();
  const f = fx.on(db);
  await f.project.create({ name: "q", repo_path: "/tmp/q" });
  const group = (project_id: number, name: string, spent_tokens: number) =>
    f.runningGrp.create({ project_id, name, spent_tokens });
  await group(1, "mine", 5000);
  await group(2, "theirs", 900);
  const worker = (project_id: number, grp_id: number, role: string, runtime: string, total_tokens: number) =>
    f.agent.create({ project_id, grp_id, role, runtime, total_tokens });
  await worker(1, 1, "engineer", "claude", 5000);
  await worker(2, 2, "auditor", "codex", 900);
  const unit = (grp_id: number, difficulty: string, spent_tokens: number) =>
    f.slice.create({ grp_id, seq: 1, title: "S", difficulty, spent_tokens });
  await unit(1, "hard", 5000);
  await unit(2, "trivial", 900);

  const mine = await costReport(db, 1);
  expect(mine.total.tokens).toBe(5000);
  expect(mine.byGroup.map((g) => g.label)).toEqual(["mine"]);
  expect(mine.agents.map((a) => a.role)).toEqual(["engineer"]);
  expect(mine.byRole.map((r) => r.label)).toEqual(["engineer"]);
  expect(mine.byRuntime.map((r) => r.label)).toEqual(["claude"]);
  expect(mine.byDifficulty.map((d) => [d.label, d.tokens])).toEqual([["hard", 5000]]);

  const everything = await costReport(db);
  expect(everything.total.tokens).toBe(5900);
  expect(everything.byGroup.map((g) => g.label)).toEqual(["mine", "theirs"]);
  expect(everything.byDifficulty.map((d) => d.label).sort()).toEqual(["hard", "trivial"]);
});

test("a delivered requirement is counted for its own project only", async () => {
  const db = await seed();
  const f = fx.on(db);
  await f.project.create({ name: "q", repo_path: "/tmp/q" });
  const dissolved = (project_id: number, name: string, spent_tokens: number) =>
    f.grp.create({ project_id, name, status: "DISSOLVED", spent_tokens });
  await dissolved(1, "mine", 400);
  await dissolved(2, "theirs", 700);

  expect((await costReport(db, 1)).delivered).toEqual({ count: 1, tokens: 400 });
  expect((await costReport(db)).delivered).toEqual({ count: 2, tokens: 1100 });
});

test("cache ratio is averaged from recorded turns, and absent before any run", async () => {
  const db = await seed();
  expect(await recentCacheRatio(db)).toBeNull();
  const summary = (cacheRatio: number) =>
    fx.on(db).event.create({ author: "e", kind: "tool_summary", meta_json: { cacheRatio } });
  await summary(0.9);
  await summary(0.7);
  // A sudden drop here is the only visible sign that prompt assembly broke: the
  // agents still work and the tests still pass, each turn just costs 3-5x.
  expect(await recentCacheRatio(db)).toBeCloseTo(0.8);
});
