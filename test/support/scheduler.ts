import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";

/**
 * Every scheduler a test makes, closed by `setup.ts` before the next one runs.
 *
 * A finished job ticks from a detached `.finally`, so one nobody holds any more
 * keeps dispatching — and the tests in a file share one database, which
 * `openMemory()` empties between them. A stale one claims the next test's job
 * row and runs it against the previous harness's executor, so the assertion
 * reads a `specs` array the turn never reached.
 */
/**
 * Measured before this file existed: 30 schedulers still accepting by the end of
 * `test/mech/review-pipeline.test.ts`, one per test. Two files had written the
 * registry for themselves and twenty had not, which is what a rule every caller
 * has to remember looks like from the outside. `a-test-closes-its-scheduler`
 * is the rule now.
 */
const made: Scheduler[] = [];

export const newScheduler = (...args: ConstructorParameters<typeof Scheduler>): Scheduler =>
  made[made.push(new Scheduler(...args)) - 1]!;

export const stopSchedulers = (): void => {
  for (const s of made.splice(0)) s.quiesce();
};
