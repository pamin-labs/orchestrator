import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { newScheduler } from "./scheduler.ts";

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
    sched: overrides.sched ?? newScheduler(db, async () => {}),
    waiters: overrides.waiters ?? new Map<string, (value: string) => void>(),
    config,
  };
}
