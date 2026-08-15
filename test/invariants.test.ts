import { expect, test } from "bun:test";
import {
  ESCALATION_INVARIANTS,
  UTIL_INVARIANTS,
  SERVER_INVARIANTS,
  LEASE_INVARIANTS,
  PROJECT_INVARIANTS,
  GRP_INVARIANTS,
  JOB_INVARIANTS,
  SLICE_INVARIANTS,
  uncovered,
} from "../src/mech/invariants.ts";

/**
 * The one check this table exists for.
 *
 * Every rule in the watchdog was bought with an incident, and all of them have the
 * same shape: a transition exactly one code path fires, which then does not fire.
 * Adding a state without saying who pushes it is how the next one gets bought, so
 * that failure happens here instead — at `bun test`, in the commit that adds it.
 */
test("every state says who pushes it out", () => {
  expect(uncovered()).toEqual({ grp: [], slice: [], job: [], escalation: [], util: [], project: [], server: [], lease: [] });

  for (const i of [...GRP_INVARIANTS, ...SLICE_INVARIANTS, ...JOB_INVARIANTS, ...ESCALATION_INVARIANTS, ...UTIL_INVARIANTS, ...PROJECT_INVARIANTS]) {
    // `driver: null` is a real answer — terminal, or a human is deliberately being
    // waited on. An empty string is the unanswered question.
    expect(i.driver === null || i.driver.length > 10).toBe(true);
    expect(i.must.length).toBeGreaterThan(10);
  }
});
