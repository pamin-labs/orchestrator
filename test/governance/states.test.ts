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

/**
 * The states that appear twice, and the ones that appear where they may not.
 *
 * Both used to answer `boolean`, which made every failure here `expected true,
 * received false` against a list of eight — true, and no help at all. They name
 * the offending state instead, so the diff is the finding.
 */
const duplicates = (values: readonly string[]): string[] => values.filter((value, at) => values.indexOf(value) !== at);
const outside = <T>(subset: readonly T[], all: readonly T[]): T[] => {
  const allowed = new Set<T>(all);
  return subset.filter((value) => !allowed.has(value));
};

test("canonical states and semantic subsets are unique and aligned", () => {
  const repeated = Object.fromEntries(
    Object.entries({
      GRP_STATES,
      SLICE_STATES,
      JOB_STATES,
      LEASE_STATES,
      ESCALATION_STATES,
      UTIL_STATES,
      PROJECT_STATES,
      SERVER_STATES,
      ACTIVE_JOB_STATES,
      DISPATCHABLE_GRP_STATES,
      ESCALATION_OPEN_STATES,
      ESCALATION_TERMINAL_STATES,
    }).map(([name, states]) => [name, duplicates(states)]),
  );
  expect(repeated).toEqual({
    GRP_STATES: [],
    SLICE_STATES: [],
    JOB_STATES: [],
    LEASE_STATES: [],
    ESCALATION_STATES: [],
    UTIL_STATES: [],
    PROJECT_STATES: [],
    SERVER_STATES: [],
    ACTIVE_JOB_STATES: [],
    DISPATCHABLE_GRP_STATES: [],
    ESCALATION_OPEN_STATES: [],
    ESCALATION_TERMINAL_STATES: [],
  });

  // A subset naming a state its parent does not have is the drift this catches,
  // and the state it named is what the reader needs.
  expect({
    ACTIVE_JOB_STATES: outside(ACTIVE_JOB_STATES, JOB_STATES),
    DISPATCHABLE_GRP_STATES: outside(DISPATCHABLE_GRP_STATES, GRP_STATES),
    ESCALATION_OPEN_STATES: outside(ESCALATION_OPEN_STATES, ESCALATION_STATES),
    ESCALATION_TERMINAL_STATES: outside(ESCALATION_TERMINAL_STATES, ESCALATION_STATES),
  }).toEqual({
    ACTIVE_JOB_STATES: [],
    DISPATCHABLE_GRP_STATES: [],
    ESCALATION_OPEN_STATES: [],
    ESCALATION_TERMINAL_STATES: [],
  });
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
