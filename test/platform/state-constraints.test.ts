import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { grp } from "../../src/platform/persistence/schema.ts";
import {
  ESCALATION_STATES,
  GRP_STATES,
  JOB_STATES,
  LEASE_STATES,
  SLICE_STATES,
  TASK_STATES,
} from "../../src/contracts/states.ts";
import * as fx from "../support/factories.ts";

/**
 * A state column holds a state, and the database is what says so.
 *
 * `states.ts` is the lifecycle vocabulary and the type system enforces it, everywhere
 * the type is present. It is absent at the boundary that matters: a string reaching
 * raw SQL is a string, and the four transition bugs this branch fixed were all a
 * legal-*looking* value written where the machine had no edge.
 *
 * Generated from the same constants the types come from.
 */
const COLUMNS = [
  ["grp", "status", GRP_STATES],
  ["slice", "status", SLICE_STATES],
  ["task", "status", TASK_STATES],
  ["job", "state", JOB_STATES],
  ["lease", "state", LEASE_STATES],
  ["escalation", "chain_state", ESCALATION_STATES],
] as const;

test("every state column refuses a value that is not one of its states", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  await f.project.create({});
  await f.runningGrp.create({ project_id: 1 });
  await f.slice.create({ grp_id: 1 });
  await f.task.create({});
  await f.agent.create({ project_id: 1, grp_id: 1 });
  await f.job.create({ grp_id: 1, agent_id: 1 });
  await f.resource.create({ name: "r" });
  await f.lease.create({ grp_id: 1, resource: "r" });
  await f.escalation.create({ grp_id: 1 });

  // Raw, and it has to be: the typed builder rejects these at compile time, which
  // is the half already covered. What is under test is the database's own refusal
  // of a string that never passed through the type — a CHECK built from the same
  // constants, where SQLite needed a trigger.
  for (const [table, column] of COLUMNS) {
    // Caught rather than `.rejects`: bun types that as returning `void`, so the
    // assertion cannot be awaited and a rejection would escape the test.
    const refused = async (value: string) => {
      try {
        await db.execute(sql.raw(`UPDATE ${table} SET ${column} = '${value}' WHERE id = 1`));
        return false;
      } catch {
        return true;
      }
    };
    expect(await refused("PARTIALLY_ALIVE")).toBe(true);
    expect(await refused("")).toBe(true);
  }
});

test("every legal state is still writable, so the constraint is the vocabulary and not a subset", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  await f.project.create({});
  await f.runningGrp.create({ project_id: 1 });
  for (const state of GRP_STATES) {
    await db.update(grp).set({ status: state }).where(eq(grp.id, 1));
    expect((await db.select({ status: grp.status }).from(grp).where(eq(grp.id, 1)))[0]?.status).toBe(state);
  }
});
