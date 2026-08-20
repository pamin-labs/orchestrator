import { expect, test } from "bun:test";
import type { ResourceExec } from "../../src/mech/lease.ts";

/** These check ordering and reporting, never a real command. */
const noExec: ResourceExec = async () => ({ code: 0, out: "" });
import { eq, sql } from "drizzle-orm";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { project } from "../../src/platform/persistence/schema.ts";
import { gateState, gatesFor, recordGate, runGates, type RunGatesOptions } from "../../src/mech/gate.ts";
import { projectConfig } from "../../src/mech/util/rows.ts";
import { digestOutput } from "../../src/mech/lease.ts";
import type { Json } from "../../src/contracts/json.ts";
import * as fx from "../support/factories.ts";
import { tempDir } from "../support/temp.ts";

async function seed(gates: Json | undefined): Promise<DB> {
  const db = await openMemory();
  const f = fx.on(db);
  const p = await f.project.create({ name: "p", config_json: { gates } });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  await f.slice.create({ grp_id: g.id, seq: 1, title: "S1", accept_spec: "tests pass" });
  return db;
}

function resource(db: DB, name: string, errorRegex = "^(error|FAIL)") {
  return fx.on(db).resource.create({ name, error_regex: errorRegex });
}

/** Fake runner so the tests do not depend on any real toolchain. */
const fakeRun = (script: Record<string, { code: number; out: string }>) =>
  (async (def, _args, opts) => {
    const r = script[def.name] ?? { code: 0, out: "" };
    return {
      exitCode: r.code,
      digest: digestOutput(r.code, r.out, def.errorRegex, opts?.logPath),
      ...(opts?.logPath ? { logPath: opts.logPath } : {}),
    };
  }) satisfies NonNullable<RunGatesOptions["run"]>;

const dataDir = () => tempDir("orch-gate-");

test("gates come from project config, not from anything an agent can set", async () => {
  expect(await gatesFor(await seed(["test", "lint"]), 1)).toEqual(["test", "lint"]);
  expect(await gatesFor(await seed("test"), 1)).toEqual([]);
  expect(await gatesFor(await seed(["lint@ci"]), 1)).toEqual([]);
  expect(await gatesFor(await seed(undefined), 1)).toEqual([]);
});

test("no configured gates is a failure, not a free pass", async () => {
  const db = await seed([]);
  const out = await runGates({ db, projectId: 1, cwd: "/tmp", dataDir: dataDir(), sliceId: 1, exec: noExec });
  // A project with nothing deterministic to check has no floor under its LLM
  // reviewers, and silently passing would hide that.
  expect(out.pass).toBe(false);
  expect(out.feedback).toContain("no gates are configured");
});

test("all gates passing is a pass", async () => {
  const db = await seed(["test", "lint"]);
  await resource(db, "test");
  await resource(db, "lint");
  const out = await runGates({
    db,
    projectId: 1,
    cwd: "/tmp",
    dataDir: dataDir(),
    sliceId: 1,
    exec: noExec,
    run: fakeRun({ test: { code: 0, out: "2 pass" }, lint: { code: 0, out: "" } }),
  });
  expect(out.pass).toBe(true);
  expect(out.results.map((r) => r.name)).toEqual(["test", "lint"]);
});

test("the first failure stops the run — later output would be noise", async () => {
  const db = await seed(["typecheck", "test", "lint"]);
  for (const n of ["typecheck", "test", "lint"]) await resource(db, n);
  const out = await runGates({
    db,
    projectId: 1,
    cwd: "/tmp",
    dataDir: dataDir(),
    sliceId: 1,
    exec: noExec,
    run: fakeRun({
      typecheck: { code: 2, out: "error TS2345: wrong type\nsomething else" },
      test: { code: 0, out: "would be misleading" },
    }),
  });
  expect(out.pass).toBe(false);
  expect(out.results.length).toBe(1);
  expect(out.feedback).toContain("error TS2345");
});

test("feedback carries the failing lines, never the whole log", async () => {
  const db = await seed(["test"]);
  await resource(db, "test");
  const noise = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const out = await runGates({
    db,
    projectId: 1,
    cwd: "/tmp",
    dataDir: dataDir(),
    sliceId: 1,
    exec: noExec,
    run: fakeRun({ test: { code: 1, out: `${noise}\nFAIL test/mw.test.ts` } }),
  });
  expect(out.pass).toBe(false);
  expect(out.feedback).toContain("FAIL test/mw.test.ts");
  // The rejection delta must stay small: a 5000-line log would eat the context
  // the retry needs to actually fix the failure.
  expect(out.feedback.length).toBeLessThan(2000);
  // And it says where the rest is without naming a path: the log is on the
  // orchestrator's disk, this text is read inside a container, and a host path
  // there is an ENOENT the agent spends a round on.
  expect(out.feedback).toContain("full log");
  expect(out.feedback).not.toMatch(/\(?\/[\w.-]+\/.*\.log/);
});

test("an unknown gate resource fails loudly instead of being skipped", async () => {
  const db = await seed(["nope"]);
  const out = await runGates({ db, projectId: 1, cwd: "/tmp", dataDir: dataDir(), sliceId: 1, exec: noExec });
  expect(out.pass).toBe(false);
  expect(out.feedback).toContain("unknown gate resource nope");
});

test("gate verdicts merge into gates_json without clobbering other layers", async () => {
  const db = await seed(["test"]);
  await recordGate(db, 1, "self", "pass");
  await recordGate(db, 1, "gate", "fail");
  await recordGate(db, 1, "gate", "pass");
  expect(await gateState(db, 1)).toEqual({ self: "pass", gate: "pass" });
});

test("a project whose config is the wrong shape runs on defaults, not on nothing", async () => {
  // Six readers each wrote out their own SELECT, `?? "{}"`, try and catch — and
  // the catch is the load-bearing part: config_json is edited by the panel and by
  // agents, so a broken value must cost this project its overrides and not its
  // gates, its excludes, its shared paths and its sandbox all at once.
  const db = await openMemory();
  await fx.on(db).project.create({ name: "p" });

  // The half-written brace this was built around no longer reaches the row:
  // `jsonb` parses on the way in, so that half of the guard is the column's now.
  const halfWritten = Promise.resolve(db.execute(sql`UPDATE project SET config_json = '{"gates":["test"'`));
  // oxlint-disable-next-line typescript/await-thenable -- Bun's async matcher is awaitable, but Matchers is not declared Thenable
  await expect(halfWritten).rejects.toThrow();

  // A JSON value that is not an object is the same answer: `[1,2]` has no keys
  // to read and `.gates` on it would be undefined either way, but a caller that
  // spreads the result must not get an array.
  await db
    .update(project)
    .set({ config_json: [1, 2] })
    .where(eq(project.id, 1));
  expect(await projectConfig(db, 1)).toEqual({});

  await db
    .update(project)
    .set({ config_json: { gates: ["test", "lint", 7] } })
    .where(eq(project.id, 1));
  expect((await projectConfig(db, 1)).gates).toBeUndefined();
  expect(await gatesFor(db, 1)).toEqual([]);

  // No project, no row, no config — never a throw, because every one of the six
  // is called from a path that has only a nullable project id.
  expect(await projectConfig(db, null)).toEqual({});
  expect(await projectConfig(db, 999)).toEqual({});
});

test("the rejection delta is the extracted errors, capped — not the tail of the log", async () => {
  // A real failing typecheck prints its errors first and then a hundred lines of
  // progress. Reading the tail instead sends the agent "ok 99" and never the
  // compiler error, and it retries blind; sending every extracted line instead
  // spends the retry's context on forty variations of one fact.
  const db = await seed(["test"]);
  await resource(db, "test");
  const errors = Array.from({ length: 40 }, (_, i) => `error TS2345: dup${String(i).padStart(2, "0")}`);
  const noise = Array.from({ length: 100 }, (_, i) => `  ok ${i}`);
  const out = await runGates({
    db,
    projectId: 1,
    cwd: "/tmp",
    dataDir: dataDir(),
    sliceId: 1,
    exec: noExec,
    run: fakeRun({ test: { code: 2, out: [...errors, ...noise].join("\n") } }),
  });
  expect(out.feedback).toContain("dup00");
  expect(out.feedback).toContain("dup19");
  expect(out.feedback).not.toContain("dup20");
  expect(out.feedback).not.toContain("ok 99");
});
