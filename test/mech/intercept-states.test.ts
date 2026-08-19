import { expect, test } from "bun:test";
import { hold, release } from "../../src/mech/flow/intercept.ts";
import { testContext } from "../support/test-context.ts";
import * as fx from "../support/factories.ts";
import type { DB } from "../../src/platform/persistence/database.ts";

/**
 * Which state a group comes back to, and which groups a stop may touch at all.
 *
 * Both writes were unguarded on the `from` side: `hold` moved a group to PAUSED
 * whatever it was doing, and `release` restored RUNNING whatever it had been.
 */

const statusOf = (db: DB, id: number) =>
  db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(id)!.status;

const seeded = () => {
  const ctx = testContext();
  const p = fx.project.insert(ctx.db, { name: "p" });
  const g = fx.grp.insert(ctx.db, { project_id: p.id, name: "g" });
  return { ctx, id: g.id };
};

test("a group paused while its PR was open comes back to PR_OPEN", () => {
  // `mergequeue.queue()` filters on `status = 'PR_OPEN'`, so restoring RUNNING
  // takes audited work with a place in the merge order out of the queue with
  // nothing said. `prReopened` in server.ts is this same bug patched once, for
  // one cause — a rate-limited Scribe turn is another.
  const { ctx, id } = seeded();
  ctx.db.run("UPDATE grp SET status = 'PR_OPEN', merge_seq = 1 WHERE id = ?", [id]);

  hold(ctx.db, id, { reason: "ratelimit", settled: true });
  expect(statusOf(ctx.db, id)).toBe("PAUSED");

  release(ctx, id);
  expect(statusOf(ctx.db, id)).toBe("PR_OPEN");
});

test("a group paused while running still comes back to RUNNING", () => {
  const { ctx, id } = seeded();
  ctx.db.run("UPDATE grp SET status = 'RUNNING' WHERE id = ?", [id]);
  hold(ctx.db, id, { reason: "ratelimit", settled: true });
  release(ctx, id);
  expect(statusOf(ctx.db, id)).toBe("RUNNING");
});

test("a dissolved group is not brought back by a hold", () => {
  // `dropGroup` leaves `budget_tokens` and `spent_tokens` alone, so the budget
  // rule keeps matching. With no `from` guard the group went DISSOLVED → PAUSED,
  // and PAUSED is in `WRITING` — so `canStart` counted its paths as claimed and
  // refused the next group that wanted them, permanently.
  const { ctx, id } = seeded();
  ctx.db.run("UPDATE grp SET status = 'DISSOLVED', budget_tokens = 100, spent_tokens = 200 WHERE id = ?", [id]);
  hold(ctx.db, id, { reason: "budget", settled: true });
  expect(statusOf(ctx.db, id)).toBe("DISSOLVED");
});

test("a slice that never ran cannot be accepted", async () => {
  // `POST /api/v1/slices/:id/decision` with `accept` calls `acceptSlice`, which
  // wrote `accepted` with no guard on where it came from. On a `pending` slice
  // that means: a carry-over handoff note claiming it delivered, `queueNextSlice`
  // moving on, and — if it was the last open slice — branch review and PR_OPEN on
  // work that was never written. Only the panel not rendering the button stopped it.
  const { acceptSlice } = await import("../../src/mech/flow/review.ts");
  const { ctx, id } = seeded();
  const slice = fx.slice.insert(ctx.db, { grp_id: id, seq: 1, title: "add the menu", status: "pending" });

  acceptSlice(ctx, slice.id, "boss");

  const after = ctx.db
    .query<{ status: string }, [number]>("SELECT status FROM slice WHERE id = ?")
    .get(slice.id)!.status;
  expect(after).toBe("pending");
  const handoffs = ctx.db
    .query<{ c: number }, [number]>("SELECT count(*) AS c FROM note WHERE grp_id = ? AND kind = 'handoff'")
    .get(id)!.c;
  expect(handoffs).toBe(0);
});

/**
 * A resume scoped to one cause does not restart what stopped for another.
 *
 * The one bulk resume in the tree runs when a credential changes, and without `only`
 * it matched every PAUSED row: signing into GitHub restarted a group the boss had
 * paused by hand, and one waiting out a rate limit came back with `rl_resets_at`
 * still set. Deleting the scope left the suite green — nothing asserted that a
 * resume leaves anything alone.
 */
test("a bulk resume touches only the groups that stopped for that cause", () => {
  const ctx = testContext();
  const p = fx.project.insert(ctx.db, { name: "p" });
  const byHand = fx.grp.insert(ctx.db, { project_id: p.id, name: "hand" });
  const byAuth = fx.grp.insert(ctx.db, { project_id: p.id, name: "auth" });
  for (const [id, reason] of [
    [byHand.id, "boss"],
    [byAuth.id, "auth:claude"],
  ] as const) {
    ctx.db.run("UPDATE grp SET status = 'PAUSED', paused_from = 'RUNNING', pause_reason = ? WHERE id = ?", [
      reason,
      id,
    ]);
  }

  release(ctx, null, { only: "auth:claude" });

  expect({ hand: statusOf(ctx.db, byHand.id), auth: statusOf(ctx.db, byAuth.id) }).toEqual({
    hand: "PAUSED",
    auth: "RUNNING",
  });
});

/**
 * A targeted resume is scoped by cause too, when it names one.
 *
 * `resume` from the panel names no cause and takes the group back whatever stopped
 * it, which is right — the boss is looking at it. A caller that does name one is
 * saying "only if it stopped for this", and a group that stopped for something else
 * is still stopped for something else.
 */
test("naming a cause on one group does not resume it for another reason", () => {
  const { ctx, id } = seeded();
  ctx.db.run("UPDATE grp SET status = 'PAUSED', paused_from = 'RUNNING', pause_reason = 'boss' WHERE id = ?", [id]);

  release(ctx, id, { only: "auth:claude" });
  expect(statusOf(ctx.db, id)).toBe("PAUSED");

  release(ctx, id, { only: "boss" });
  expect(statusOf(ctx.db, id)).toBe("RUNNING");
});
