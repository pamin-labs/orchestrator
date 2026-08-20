import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { grp } from "../../src/platform/persistence/schema.ts";
import { GRP_STATES } from "../../src/contracts/states.ts";
import * as fx from "../support/factories.ts";

/**
 * A dissolved group stays dissolved, whoever writes to it.
 *
 * `GRP_TERMINAL_STATES` says "nothing may move it", and that was a sentence rather
 * than a property: fourteen statements in `src/` write `grp.status` and eight name
 * only the row, so a group dissolved while a turn is in flight is revived by
 * whatever lands afterwards — a late audit verdict writes `RUNNING`, a merge
 * reconcile writes `PR_OPEN`.
 */
/**
 * The revived group is worse than a wrong label: `RUNNING` is a writing state in
 * `ownership.ts`, so its paths stay claimed with nobody left to release them and
 * the next group needing them never starts.
 *
 * A `BEFORE UPDATE` trigger returning NULL rather than one that raises: it skips
 * the row and returns, which is what `AND status <> 'DISSOLVED'` would have done at
 * each of the fourteen sites. Raising would turn a silently-wrong write into a
 * thrown error inside a turn that has no reason to expect one.
 */
test("no write moves a group out of DISSOLVED", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  const project = await f.project.create({});
  await f.grp.create({ project_id: project.id, status: "DISSOLVED" });

  const status = async () => (await db.select({ status: grp.status }).from(grp).where(eq(grp.id, 1)))[0]?.status;
  for (const state of GRP_STATES) {
    await db.update(grp).set({ status: state }).where(eq(grp.id, 1));
    expect(await status()).toBe("DISSOLVED");
  }
  // The whole-row shape too, since that is what the flow layer writes.
  await db.update(grp).set({ status: "RUNNING", approved_at: null }).where(eq(grp.id, 1));
  expect(await status()).toBe("DISSOLVED");
});

test("a group that is not dissolved still moves freely", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  const project = await f.project.create({});
  await f.runningGrp.create({ project_id: project.id });
  for (const state of GRP_STATES.filter((s) => s !== "DISSOLVED")) {
    await db.update(grp).set({ status: state }).where(eq(grp.id, 1));
    expect((await db.select({ status: grp.status }).from(grp).where(eq(grp.id, 1)))[0]?.status).toBe(state);
  }
});
