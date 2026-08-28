import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { costReport } from "../../src/mech/ops/cost.ts";
import { event } from "../../src/platform/persistence/schema.ts";
import type { Json } from "../../src/contracts/json.ts";

/**
 * Three numbers that were each recorded somewhere and never in the same row.
 *
 * Duration lived in a span, tokens in this report, and the size of tool output
 * nowhere at all — so the largest claim anyone here has made about what a turn
 * costs, that tool results are 90% of a transcript and every round re-reads them,
 * could be neither confirmed nor contradicted after the day it was measured.
 */
async function turns(rows: Json[]) {
  const db = await openMemory();
  for (const meta of rows) {
    await db.insert(event).values({ author: "engineer", kind: "tool_summary", at: Date.now(), meta_json: meta });
  }
  return (await costReport(db)).turns;
}

test("a turn's wall clock, weight and tool share arrive together", async () => {
  const shape = await turns([
    { usage: { input: 1 }, ms: 30_000, transcript: { bytes: 100_000, toolBytes: 90_000 } },
    { usage: { input: 1 }, ms: 50_000, transcript: { bytes: 300_000, toolBytes: 150_000 } },
  ]);
  expect(shape).toEqual({ counted: 2, medianMs: 40_000, medianBytes: 200_000, medianToolShare: 0.7 });
});

/**
 * Medians, because one turn that read a 4 MB file is exactly the turn a mean
 * would let define the picture.
 */
test("one enormous turn does not become the picture", async () => {
  const shape = await turns([
    { usage: { input: 1 }, ms: 10_000, transcript: { bytes: 10_000, toolBytes: 1_000 } },
    { usage: { input: 1 }, ms: 12_000, transcript: { bytes: 12_000, toolBytes: 1_200 } },
    { usage: { input: 1 }, ms: 600_000, transcript: { bytes: 4_000_000, toolBytes: 3_900_000 } },
  ]);
  expect(shape.medianBytes).toBe(12_000);
  expect(shape.medianMs).toBe(12_000);
});

/** Turns recorded before any of this existed carry none of it, and a report over
 *  them says so rather than answering zero. */
test("a turn from before this was recorded contributes nothing to it", async () => {
  const shape = await turns([{ usage: { input: 1, output: 2 } }, { usage: { input: 3 } }]);
  expect(shape).toEqual({ counted: 2, medianMs: null, medianBytes: null, medianToolShare: null });
});
