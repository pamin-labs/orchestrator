import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESCALATION_STATES, GRP_STATES, JOB_STATES, LEASE_STATES, SLICE_STATES } from "../src/states.ts";
import {
  ESCALATION_INVARIANTS,
  UTIL_INVARIANTS,
  PROJECT_INVARIANTS,
  GRP_INVARIANTS,
  JOB_INVARIANTS,
  SLICE_INVARIANTS,
  uncovered,
} from "../src/mech/ops/invariants.ts";

/**
 * The one check this table exists for.
 *
 * Every rule in the watchdog was bought with an incident, and all of them have the
 * same shape: a transition exactly one code path fires, which then does not fire.
 * Adding a state without saying who pushes it is how the next one gets bought, so
 * that failure happens here instead — at `bun test`, in the commit that adds it.
 */
test("every state says who pushes it out", () => {
  expect(uncovered()).toEqual({
    grp: [],
    slice: [],
    job: [],
    escalation: [],
    util: [],
    project: [],
    server: [],
    lease: [],
  });

  for (const i of [
    ...GRP_INVARIANTS,
    ...SLICE_INVARIANTS,
    ...JOB_INVARIANTS,
    ...ESCALATION_INVARIANTS,
    ...UTIL_INVARIANTS,
    ...PROJECT_INVARIANTS,
  ]) {
    // `driver: null` is a real answer — terminal, or a human is deliberately being
    // waited on. An empty string is the unanswered question.
    expect(i.driver === null || i.driver.length > 10).toBe(true);
    expect(i.must.length).toBeGreaterThan(10);
  }
});

test("a state in the table is a state something actually writes", () => {
  // The alignment check above cannot catch this: `states.ts` and `invariants.ts`
  // are edited together, so a state the database never produces passes green in
  // both. `lease.cancelled` lived here for exactly that reason — every writer of
  // `lease.state` is the INSERT, the executor and `finishLease`, and none of
  // them writes it; what gets cancelled is the job, and the lease row stays
  // `queued`.
  //
  // ponytail: greps for the quoted literal rather than parsing SQL. It cannot
  // see a state written through a variable, and a comment quoting the word
  // would pass it — a smoke check for "nothing writes this at all", not a
  // proof. Parse the statements if it ever misses one that matters.
  const src: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !p.endsWith("states.ts") && !p.endsWith("invariants.ts")) {
        src.push(readFileSync(p, "utf8"));
      }
    }
  };
  walk("src");
  const all = src.join("\n");

  // Stored states only. `project`, `server` and `util` are computed conditions —
  // `repoHeld()` answers a boolean, `serverAction()` decides absent/refusing —
  // so there is no literal to write and nothing here to check.
  const STATES = {
    grp: GRP_STATES,
    slice: SLICE_STATES,
    job: JOB_STATES,
    escalation: ESCALATION_STATES,
    lease: LEASE_STATES,
  };
  for (const [table, states] of Object.entries(STATES)) {
    for (const s of states) {
      expect(`${table}.${s}: ${all.includes(`'${s}'`) || all.includes(`"${s}"`)}`).toBe(`${table}.${s}: true`);
    }
  }
});
