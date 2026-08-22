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

/**
 * Quiesced *and* settled: closing the queue does not stop what is already
 * running, and a job in flight keeps writing.
 *
 * Its `bus.emit` lands after `openMemory()` deleted the next test's rows and
 * reset `event.seq` with `setval`, so the sequence is behind the row that
 * arrived — `duplicate key value violates unique constraint "event_pkey"` on an
 * insert whose `seq` is `default`. Seen on CI in a test that touches none of it.
 */
/** `drain` on a closed queue returns as soon as nothing is in flight — it waits
 *  for what is running and nothing can arrive behind it. A wedged job times the
 *  hook out, which is visible; a stale write is not. */
export const stopSchedulers = async (): Promise<void> => {
  const closing = made.splice(0);
  for (const s of closing) s.quiesce();
  await Promise.all(closing.map((s) => s.drain().catch(() => {})));
};
