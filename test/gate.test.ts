import { expect, test } from "bun:test";
import type { ResourceExec } from "../src/mech/lease.ts";

/** These check ordering and reporting, never a real command. */
const noExec: ResourceExec = async () => ({ code: 0, out: "" });
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type DB } from "../src/db.ts";
import { gateState, gatesFor, recordGate, runGates } from "../src/mech/gate.ts";
import { digestOutput, type ResourceDef } from "../src/mech/lease.ts";

function seed(gates: unknown): DB {
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, config_json, created_at) VALUES ('p', '/tmp/p', ?, 0)", [
    JSON.stringify({ gates }),
  ]);
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run("INSERT INTO slice (grp_id, seq, title, accept_spec, created_at) VALUES (1, 1, 'S1', 'tests pass', 0)");
  return db;
}

function resource(db: DB, name: string, errorRegex = "^(error|FAIL)") {
  db.run("INSERT INTO resource (name, template, arg_schema_json, error_regex) VALUES (?, 'true', '{}', ?)", [
    name,
    errorRegex,
  ]);
}

/** Fake runner so the tests do not depend on any real toolchain. */
const fakeRun = (script: Record<string, { code: number; out: string }>) =>
  (async (def: ResourceDef, _args: any, opts: any) => {
    const r = script[def.name] ?? { code: 0, out: "" };
    return { exitCode: r.code, digest: digestOutput(r.code, r.out, def.errorRegex, opts?.logPath), logPath: opts?.logPath };
  }) as any;

const dataDir = () => mkdtempSync(join(tmpdir(), "orch-gate-"));

test("gates come from project config, not from anything an agent can set", () => {
  expect(gatesFor(seed(["test", "lint"]), 1)).toEqual(["test", "lint"]);
  expect(gatesFor(seed("test"), 1)).toEqual([]);
  expect(gatesFor(seed(undefined), 1)).toEqual([]);
});

test("no configured gates is a failure, not a free pass", async () => {
  const db = seed([]);
  const out = await runGates({ db, projectId: 1, cwd: "/tmp", dataDir: dataDir(), sliceId: 1, exec: noExec });
  // A project with nothing deterministic to check has no floor under its LLM
  // reviewers, and silently passing would hide that.
  expect(out.pass).toBe(false);
  expect(out.feedback).toContain("no gates are configured");
});

test("all gates passing is a pass", async () => {
  const db = seed(["test", "lint"]);
  resource(db, "test");
  resource(db, "lint");
  const out = await runGates({
    db,
    projectId: 1,
    cwd: "/tmp",
    dataDir: dataDir(),
    sliceId: 1, exec: noExec,
    run: fakeRun({ test: { code: 0, out: "2 pass" }, lint: { code: 0, out: "" } }),
  });
  expect(out.pass).toBe(true);
  expect(out.results.map((r) => r.name)).toEqual(["test", "lint"]);
});

test("the first failure stops the run — later output would be noise", async () => {
  const db = seed(["typecheck", "test", "lint"]);
  for (const n of ["typecheck", "test", "lint"]) resource(db, n);
  const out = await runGates({
    db,
    projectId: 1,
    cwd: "/tmp",
    dataDir: dataDir(),
    sliceId: 1, exec: noExec,
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
  const db = seed(["test"]);
  resource(db, "test");
  const noise = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const out = await runGates({
    db,
    projectId: 1,
    cwd: "/tmp",
    dataDir: dataDir(),
    sliceId: 1, exec: noExec,
    run: fakeRun({ test: { code: 1, out: `${noise}\nFAIL test/mw.test.ts` } }),
  });
  expect(out.pass).toBe(false);
  expect(out.feedback).toContain("FAIL test/mw.test.ts");
  // The rejection delta must stay small: a 5000-line log would eat the context
  // the retry needs to actually fix the failure.
  expect(out.feedback.length).toBeLessThan(2000);
  expect(out.feedback).toContain("full log:");
});

test("an unknown gate resource fails loudly instead of being skipped", async () => {
  const db = seed(["nope"]);
  const out = await runGates({ db, projectId: 1, cwd: "/tmp", dataDir: dataDir(), sliceId: 1, exec: noExec });
  expect(out.pass).toBe(false);
  expect(out.feedback).toContain("unknown gate resource nope");
});

test("gate verdicts merge into gates_json without clobbering other layers", () => {
  const db = seed(["test"]);
  recordGate(db, 1, "self", "pass");
  recordGate(db, 1, "gate", "fail");
  recordGate(db, 1, "gate", "pass");
  expect(gateState(db, 1)).toEqual({ self: "pass", gate: "pass" });
});

