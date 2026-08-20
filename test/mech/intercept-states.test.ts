import { expect, test } from "bun:test";
import { hold, release } from "../../src/mech/flow/intercept.ts";
import { testContext } from "../support/test-context.ts";
import * as fx from "../support/factories.ts";
import { and, count, eq } from "drizzle-orm";
import type { DB } from "../../src/platform/persistence/database.ts";
import { grp, note, slice } from "../../src/platform/persistence/schema.ts";

/**
 * Which state a group comes back to, and which groups a stop may touch at all.
 *
 * Both writes were unguarded on the `from` side: `hold` moved a group to PAUSED
 * whatever it was doing, and `release` restored RUNNING whatever it had been.
 */

const statusOf = async (db: DB, id: number) =>
  (await db.select({ status: grp.status }).from(grp).where(eq(grp.id, id)))[0]!.status;

const seeded = async () => {
  const ctx = await testContext();
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  const g = await f.grp.create({ project_id: p.id, name: "g" });
  return { ctx, f, id: g.id };
};

test("a group paused while its PR was open comes back to PR_OPEN", async () => {
  // `mergequeue.queue()` filters on `status = 'PR_OPEN'`, so restoring RUNNING
  // takes audited work with a place in the merge order out of the queue with
  // nothing said. `prReopened` in server.ts is this same bug patched once, for
  // one cause — a rate-limited Scribe turn is another.
  const { ctx, id } = await seeded();
  await ctx.db.update(grp).set({ status: "PR_OPEN", merge_seq: 1 }).where(eq(grp.id, id));

  await hold(ctx.db, id, { reason: "ratelimit", settled: true });
  expect(await statusOf(ctx.db, id)).toBe("PAUSED");

  await release(ctx, id);
  expect(await statusOf(ctx.db, id)).toBe("PR_OPEN");
});

test("a group paused while running still comes back to RUNNING", async () => {
  const { ctx, id } = await seeded();
  await ctx.db.update(grp).set({ status: "RUNNING" }).where(eq(grp.id, id));
  await hold(ctx.db, id, { reason: "ratelimit", settled: true });
  await release(ctx, id);
  expect(await statusOf(ctx.db, id)).toBe("RUNNING");
});

test("a dissolved group is not brought back by a hold", async () => {
  // `dropGroup` leaves `budget_tokens` and `spent_tokens` alone, so the budget
  // rule keeps matching. With no `from` guard the group went DISSOLVED → PAUSED,
  // and PAUSED is in `WRITING` — so `canStart` counted its paths as claimed and
  // refused the next group that wanted them, permanently.
  const { ctx, id } = await seeded();
  await ctx.db.update(grp).set({ status: "DISSOLVED", budget_tokens: 100, spent_tokens: 200 }).where(eq(grp.id, id));
  await hold(ctx.db, id, { reason: "budget", settled: true });
  expect(await statusOf(ctx.db, id)).toBe("DISSOLVED");
});

test("a slice that never ran cannot be accepted", async () => {
  // `POST /api/v1/slices/:id/decision` with `accept` calls `acceptSlice`, which
  // wrote `accepted` with no guard on where it came from. On a `pending` slice
  // that means: a carry-over handoff note claiming it delivered, `queueNextSlice`
  // moving on, and — if it was the last open slice — branch review and PR_OPEN on
  // work that was never written. Only the panel not rendering the button stopped it.
  const { acceptSlice } = await import("../../src/mech/flow/review.ts");
  const { ctx, f, id } = await seeded();
  const card = await f.slice.create({ grp_id: id, seq: 1, title: "add the menu", status: "pending" });

  await acceptSlice(ctx, card.id, "boss");

  const [after] = await ctx.db.select({ status: slice.status }).from(slice).where(eq(slice.id, card.id));
  expect(after!.status).toBe("pending");
  const [handoffs] = await ctx.db
    .select({ c: count() })
    .from(note)
    .where(and(eq(note.grp_id, id), eq(note.kind, "handoff")));
  expect(handoffs!.c).toBe(0);
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
test("a bulk resume touches only the groups that stopped for that cause", async () => {
  const ctx = await testContext();
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  const byHand = await f.grp.create({ project_id: p.id, name: "hand" });
  const byAuth = await f.grp.create({ project_id: p.id, name: "auth" });
  for (const [id, reason] of [
    [byHand.id, "boss"],
    [byAuth.id, "auth:claude"],
  ] as const) {
    await ctx.db
      .update(grp)
      .set({ status: "PAUSED", paused_from: "RUNNING", pause_reason: reason })
      .where(eq(grp.id, id));
  }

  await release(ctx, null, { only: "auth:claude" });

  expect({ hand: await statusOf(ctx.db, byHand.id), auth: await statusOf(ctx.db, byAuth.id) }).toEqual({
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
test("naming a cause on one group does not resume it for another reason", async () => {
  const { ctx, id } = await seeded();
  await ctx.db
    .update(grp)
    .set({ status: "PAUSED", paused_from: "RUNNING", pause_reason: "boss" })
    .where(eq(grp.id, id));

  await release(ctx, id, { only: "auth:claude" });
  expect(await statusOf(ctx.db, id)).toBe("PAUSED");

  await release(ctx, id, { only: "boss" });
  expect(await statusOf(ctx.db, id)).toBe("RUNNING");
});
