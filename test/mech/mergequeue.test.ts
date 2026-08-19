import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { grp } from "../../src/platform/persistence/schema.ts";
import type { GrpState } from "../../src/contracts/states.ts";
import { head, joinQueue, landed, position, queue } from "../../src/mech/flow/mergequeue.ts";
import * as fx from "../support/factories.ts";

async function seed(statuses: GrpState[]): Promise<DB> {
  const db = await openMemory();
  const f = fx.on(db);
  const p = await f.project.create({ name: "p" });
  for (const [i, status] of statuses.entries()) {
    await f.grp.create({ project_id: p.id, name: `g${i + 1}`, status, branch: `orch/g${i + 1}` });
  }
  return db;
}

test("a queued branch that leaves PR_OPEN also leaves the queue", async () => {
  // `merge_seq` survives a status change, so a group paused, escalated or
  // reopened mid-queue keeps its slot on the column. The boss's card disappears
  // from the panel while the queue still offers it as the branch to merge next
  // — a merge instruction for work whose PR is not open.
  const db = await seed(["PR_OPEN", "PR_OPEN"]);
  await joinQueue(db, 1);
  await joinQueue(db, 2);
  await db.update(grp).set({ status: "RUNNING" }).where(eq(grp.id, 1));

  expect((await queue(db, 1)).map((e) => e.grpId)).toEqual([2]);
  expect((await head(db, 1))!.grpId).toBe(2);
  expect(await position(db, 1)).toBeNull();
  expect(await position(db, 2)).toEqual({ position: 1, total: 1 });
});

test("landing tells only open PRs to rebase, not every group that ever queued", async () => {
  // The return value is the rebase instruction list. A group that dropped out of
  // PR_OPEN gets told its base is stale for a branch nobody is merging, and the
  // agent spends a turn rebasing work that is not in line.
  const db = await seed(["PR_OPEN", "PR_OPEN", "PR_OPEN"]);
  for (const id of [1, 2, 3]) await joinQueue(db, id);
  await db.update(grp).set({ status: "PAUSED" }).where(eq(grp.id, 2));

  expect(await landed(db, 1)).toEqual([3]);
});
