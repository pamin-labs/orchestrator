import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
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
 * `states.ts` is the lifecycle vocabulary and the type system enforces it —
 * everywhere the type is present. It is absent at exactly the boundary that
 * matters: a string reaching a `db.run` is a string, and the four transition bugs
 * this branch fixed were all a legal-looking value written where the state machine
 * had no edge. Those were found by reading; nothing would have stopped them.
 *
 * The constraint is generated from the same constants the types come from, so a
 * new state is admitted by adding it there and nowhere else.
 */
const COLUMNS = [
  ["grp", "status", GRP_STATES],
  ["slice", "status", SLICE_STATES],
  ["task", "status", TASK_STATES],
  ["job", "state", JOB_STATES],
  ["lease", "state", LEASE_STATES],
  ["escalation", "chain_state", ESCALATION_STATES],
] as const;

test("every state column refuses a value that is not one of its states", () => {
  const db = openMemory();
  fx.project.insert(db, {});
  fx.runningGrp.insert(db, { project_id: 1 });
  fx.slice.insert(db, { grp_id: 1 });
  fx.task.insert(db, {});
  fx.agent.insert(db, { project_id: 1, grp_id: 1 });
  fx.job.insert(db, { grp_id: 1, agent_id: 1 });
  fx.resource.insert(db, { name: "r" });
  fx.lease.insert(db, { grp_id: 1, resource: "r" });
  fx.escalation.insert(db, { grp_id: 1 });

  for (const [table, column] of COLUMNS) {
    expect(() => db.run(`UPDATE ${table} SET ${column} = 'PARTIALLY_ALIVE' WHERE id = 1`)).toThrow();
    expect(() => db.run(`UPDATE ${table} SET ${column} = '' WHERE id = 1`)).toThrow();
  }
});

test("every legal state is still writable, so the constraint is the vocabulary and not a subset", () => {
  const db = openMemory();
  fx.project.insert(db, {});
  fx.runningGrp.insert(db, { project_id: 1 });
  for (const state of GRP_STATES) {
    db.run("UPDATE grp SET status = ? WHERE id = 1", [state]);
    expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()?.status).toBe(state);
  }
});
