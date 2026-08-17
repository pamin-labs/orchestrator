import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../../src/platform/persistence/database.ts";
import * as fx from "../support/factories.ts";
import {
  ACTIVE_JOB_STATES,
  DISPATCHABLE_GRP_STATES,
  ESCALATION_OPEN_STATES,
  ESCALATION_STATES,
  ESCALATION_TERMINAL_STATES,
  GRP_STATES,
  isDispatchableGrpState,
  isTerminalEscalationState,
  JOB_STATES,
  type JobState,
  LEASE_STATES,
  PROJECT_STATES,
  SERVER_STATES,
  SLICE_STATES,
  stateParam,
  UTIL_STATES,
} from "../../src/contracts/states.ts";

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const inside = <T>(subset: readonly T[], all: readonly T[]): boolean => {
  const allowed = new Set<T>(all);
  return subset.every((value) => allowed.has(value));
};

test("canonical states and semantic subsets are unique and aligned", () => {
  for (const states of [
    GRP_STATES,
    SLICE_STATES,
    JOB_STATES,
    LEASE_STATES,
    ESCALATION_STATES,
    UTIL_STATES,
    PROJECT_STATES,
    SERVER_STATES,
  ]) {
    expect(unique(states)).toBe(true);
  }

  expect(unique(ACTIVE_JOB_STATES)).toBe(true);
  expect(unique(DISPATCHABLE_GRP_STATES)).toBe(true);
  expect(unique(ESCALATION_OPEN_STATES)).toBe(true);
  expect(unique(ESCALATION_TERMINAL_STATES)).toBe(true);
  expect(inside(ACTIVE_JOB_STATES, JOB_STATES)).toBe(true);
  expect(inside(DISPATCHABLE_GRP_STATES, GRP_STATES)).toBe(true);
  expect(inside(ESCALATION_OPEN_STATES, ESCALATION_STATES)).toBe(true);
  expect(inside(ESCALATION_TERMINAL_STATES, ESCALATION_STATES)).toBe(true);
  expect([...ESCALATION_OPEN_STATES, ...ESCALATION_TERMINAL_STATES]).toEqual([...ESCALATION_STATES]);

  const activeJobStates: ReadonlySet<JobState> = new Set(ACTIVE_JOB_STATES);
  expect(JOB_STATES.filter((state) => !activeJobStates.has(state))).toEqual(["done", "failed", "cancelled"]);
  expect(GRP_STATES.filter(isDispatchableGrpState)).toEqual([...DISPATCHABLE_GRP_STATES]);
  expect(ESCALATION_STATES.filter(isTerminalEscalationState)).toEqual([...ESCALATION_TERMINAL_STATES]);
});

test("state subsets cross the SQL boundary as data, not syntax", () => {
  const db = openMemory();
  for (const state of ["pending", "done"]) fx.job.insert(db, { kind: "notify", state });

  const count = (param: string) =>
    db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM job WHERE state IN (SELECT value FROM json_each(?))")
      .get(param)!.n;

  expect(count(stateParam(ACTIVE_JOB_STATES))).toBe(1);
  expect(count(JSON.stringify(["pending') OR 1=1 --"]))).toBe(0);
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM job").get()!.n).toBe(2);
});

test("shared state policies are not restated by consumers", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && path !== join("src", "contracts", "states.ts")) files.push(path);
    }
  };
  walk("src");

  const policies = new Set(
    [ACTIVE_JOB_STATES, DISPATCHABLE_GRP_STATES, ESCALATION_OPEN_STATES, ESCALATION_TERMINAL_STATES].map((states) =>
      [...states].sort().join("\0"),
    ),
  );
  const restatements: string[] = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/\[[\s\S]{0,160}?\]|(?:NOT\s+)?IN\s*\([\s\S]{0,160}?\)/g)) {
      const values = [...match[0].matchAll(/["']([A-Za-z_]+)["']/g)].map((item) => item[1]!);
      if (policies.has([...new Set(values)].sort().join("\0"))) restatements.push(path);
    }
  }

  expect([...new Set(restatements)]).toEqual([]);
});
