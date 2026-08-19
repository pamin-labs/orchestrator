import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { GRP_STATES } from "../../src/contracts/states.ts";
import * as fx from "../support/factories.ts";

/**
 * A dissolved group stays dissolved, whoever writes to it.
 *
 * `GRP_TERMINAL_STATES` says "nothing may move it", and until now that was a
 * sentence rather than a property: fourteen statements in `src/` write
 * `grp.status`, and eight of them name only the row. A group dissolved while a
 * turn was in flight is revived by whatever lands afterwards — a late audit
 * verdict writes `RUNNING`, a merge-queue reconcile writes `PR_OPEN`.
 *
 * The revived group is worse than a wrong label. `PAUSED` and `RUNNING` are both
 * writing states in `ownership.ts`, so its paths stay claimed with nobody left to
 * release them, and the next group that needs those paths never starts. The
 * symptom is a group that does not begin, several steps from the cause.
 *
 * The guard is `RAISE(IGNORE)` rather than `ABORT`: it skips the row and returns,
 * which is exactly what `AND status <> 'DISSOLVED'` would have done at each of the
 * fourteen sites. An abort would turn a silently-wrong write into a thrown error
 * inside a turn that has no reason to expect one.
 */
test("no write moves a group out of DISSOLVED", () => {
  const db = openMemory();
  fx.project.insert(db, {});
  fx.grp.insert(db, { project_id: 1, status: "DISSOLVED" });

  const status = () => db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()?.status;
  for (const state of GRP_STATES) {
    db.run("UPDATE grp SET status = ? WHERE id = 1", [state]);
    expect(status()).toBe("DISSOLVED");
  }
  // The whole-row shape too, since that is what the flow layer writes.
  db.run("UPDATE grp SET status = 'RUNNING', approved_at = NULL WHERE id = 1");
  expect(status()).toBe("DISSOLVED");
});

test("a group that is not dissolved still moves freely", () => {
  const db = openMemory();
  fx.project.insert(db, {});
  fx.runningGrp.insert(db, { project_id: 1 });
  for (const state of GRP_STATES.filter((s) => s !== "DISSOLVED")) {
    db.run("UPDATE grp SET status = ? WHERE id = 1", [state]);
    expect(db.query<{ status: string }, []>("SELECT status FROM grp WHERE id = 1").get()?.status).toBe(state);
  }
});
