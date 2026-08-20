import { expect, test } from "bun:test";
import { byRequirement, rank, REASONS } from "../../web/src/features/queue/rank.ts";

/**
 * Why one thing on the boss's list outranks another.
 *
 * Every weight here could be changed to any other number without a single test
 * noticing — measured by mutation — and this is the order of the list the boss opens
 * first. The weights are ordinary judgement, so what is pinned is the *ordering they
 * were chosen to produce*, not the numbers.
 */
test("an agent hanging on an answer outranks everything else that is one reason", () => {
  const order = [
    REASONS.blocked("engineer"),
    REASONS.suspended(),
    REASONS.halted(),
    REASONS.unstarted(),
    REASONS.waited(24 * 3_600_000),
    REASONS.sunk(100e6),
  ].map((r) => r.points);
  // Descending, and strictly: two reasons that tie are two rows the boss cannot
  // order, which is the thing a score exists to prevent.
  expect(order).toEqual([...order].sort((a, b) => b - a));
  expect(new Set(order).size).toBe(order.length);
});

/**
 * The two open-ended reasons are capped, and the cap is what keeps them from
 * swamping the rest.
 *
 * Waiting and sunk cost grow without bound — a requirement left over a weekend, a
 * run that burned 400M tokens. Uncapped, either would sort above an agent that is
 * literally blocked, which is the one thing the list exists to surface.
 */
test("time and money are capped below the reasons that mean somebody is stuck", () => {
  const blocked = REASONS.blocked("pm").points;
  expect(REASONS.waited(1000 * 3_600_000).points).toBeLessThan(blocked);
  expect(REASONS.sunk(10_000e6).points).toBeLessThan(blocked);
  // And they still order among themselves: a cap that clamps early makes every
  // waiting row identical.
  expect(REASONS.waited(2 * 3_600_000).points).toBeGreaterThan(REASONS.waited(1 * 3_600_000).points);
  expect(REASONS.sunk(2e6).points).toBeGreaterThan(REASONS.sunk(1e6).points);
});

/**
 * A queue head grows with what is behind it, because that is what it costs.
 *
 * One item blocked behind a head is a nuisance; ten is the whole requirement stopped.
 * It is the only reason whose weight is a function of scale rather than a constant.
 */
test("blocking a queue costs more the longer the queue is", () => {
  expect(REASONS.blocking(10).points).toBeGreaterThan(REASONS.blocking(1).points);
  expect(REASONS.blocking(10).points).toBeGreaterThan(REASONS.blocked("x").points);
});

/**
 * A row's score is every reason it has, and the row says the strongest one first.
 *
 * Summing is what makes two mild reasons outrank one mild reason — the row that is
 * both stopped *and* expensive is the one to open. Falsy entries are dropped so a
 * caller can write `cond && REASONS.x()` inline.
 */
test("reasons add up, and the row leads with the strongest", () => {
  const ranked = rank([REASONS.halted(), null, REASONS.unstarted(), false, undefined]);
  expect(ranked.points).toBe(REASONS.halted().points + REASONS.unstarted().points);
  expect(ranked.reasons.map((r) => r.why)).toEqual([REASONS.halted().why, REASONS.unstarted().why]);
});

/**
 * Rows on one requirement cluster, and a cluster ranks by its strongest row.
 *
 * Three items on one requirement is one trip rather than three context switches, and
 * a cluster that ranked by its *average* would bury a blocked agent behind two quiet
 * rows sitting beside it.
 */
test("a requirement clusters, and ranks by the worst thing in it", () => {
  const { clustered, loose } = byRequirement([
    { grpId: 1, points: 10, id: "a" },
    { grpId: 2, points: 60, id: "b" },
    { grpId: 1, points: 90, id: "c" },
    { grpId: null, points: 70, id: "d" },
  ]);
  expect(clustered.map((c) => c.grpId)).toEqual([1, 2]);
  expect(clustered[0]?.items.map((i) => i.id)).toEqual(["c", "a"]);
  // Belonging to no requirement is not a cluster of one: it stays in its own list.
  expect(loose.map((i) => i.id)).toEqual(["d"]);
});
