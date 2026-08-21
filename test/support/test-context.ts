import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";

/**
 * Schedulers this helper made, closed after each test by `setup.ts`.
 *
 * A finished job ticks from a detached `.finally`, so one nobody holds any more
 * keeps dispatching — and the files a worker runs share its database, so what it
 * dispatches lands in whichever test is running by then. That is an ordering
 * flake with a different victim each run, which is the worst kind to chase.
 */
const made: Scheduler[] = [];

export const stopSchedulers = (): void => {
  for (const s of made.splice(0)) s.quiesce();
};

export async function testContext(overrides: Partial<Ctx> = {}): Promise<Ctx> {
  const db = overrides.db ?? (await openMemory());
  const config = overrides.config ?? loadConfig();
  return {
    ...overrides,
    db,
    // With the language, as the server wires it: the bus renders an event's
    // `body` column from the key its emitter named, and a bus built without one
    // writes English into a context whose `output.language` says otherwise.
    bus: overrides.bus ?? new Bus(db, () => config.language),
    sched: overrides.sched ?? made[made.push(new Scheduler(db, async () => {})) - 1]!,
    waiters: overrides.waiters ?? new Map<string, (value: string) => void>(),
    config,
  };
}
