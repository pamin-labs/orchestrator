import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/ctx.ts";
import { openMemory } from "../src/db.ts";
import { Scheduler } from "../src/scheduler.ts";

export function testContext(overrides: Partial<Ctx> = {}): Ctx {
  const db = overrides.db ?? openMemory();
  return {
    ...overrides,
    db,
    bus: overrides.bus ?? new Bus(db),
    sched: overrides.sched ?? new Scheduler(db, async () => {}),
    waiters: overrides.waiters ?? new Map(),
    config: overrides.config ?? loadConfig(),
  };
}
