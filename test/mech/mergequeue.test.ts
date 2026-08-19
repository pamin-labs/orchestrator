import { expect, test } from "bun:test";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { head, joinQueue, landed, position, queue } from "../../src/mech/flow/mergequeue.ts";
import * as fx from "../support/factories.ts";

function seed(statuses: string[]): DB {
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  statuses.forEach((status, i) =>
    fx.grp.insert(db, { project_id: p.id, name: `g${i + 1}`, status, branch: `orch/g${i + 1}` }),
  );
  return db;
}

test("a queued branch that leaves PR_OPEN also leaves the queue", () => {
  // `merge_seq` survives a status change, so a group paused, escalated or
  // reopened mid-queue keeps its slot on the column. The boss's card disappears
  // from the panel while the queue still offers it as the branch to merge next
  // — a merge instruction for work whose PR is not open.
  const db = seed(["PR_OPEN", "PR_OPEN"]);
  joinQueue(db, 1);
  joinQueue(db, 2);
  db.run("UPDATE grp SET status = 'RUNNING' WHERE id = 1");

  expect(queue(db, 1).map((e) => e.grpId)).toEqual([2]);
  expect(head(db, 1)!.grpId).toBe(2);
  expect(position(db, 1)).toBeNull();
  expect(position(db, 2)).toEqual({ position: 1, total: 1 });
});

test("landing tells only open PRs to rebase, not every group that ever queued", () => {
  // The return value is the rebase instruction list. A group that dropped out of
  // PR_OPEN gets told its base is stale for a branch nobody is merging, and the
  // agent spends a turn rebasing work that is not in line.
  const db = seed(["PR_OPEN", "PR_OPEN", "PR_OPEN"]);
  for (const id of [1, 2, 3]) joinQueue(db, id);
  db.run("UPDATE grp SET status = 'PAUSED' WHERE id = 2");

  expect(landed(db, 1)).toEqual([3]);
});
