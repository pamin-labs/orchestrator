import { expect, test } from "bun:test";
import { appendFrame, groupedRows, type Frame } from "../web/src/lib/api.ts";

/**
 * S1 fixed the key (stable id, no more remount). This locks down the layer
 * above it: the props fed to the memoized event row for rows untouched by an
 * incoming frame must stay reference/value stable — that is what lets
 * React.memo's default shallow comparison bail out instead of re-rendering
 * (and DevTools flagging) the whole list.
 */

test("appending a new persisted frame does not change props of unrelated rows", () => {
  const live = { current: 0 };
  let frames: Frame[] = [];
  frames = appendFrame(frames, { type: "event", seq: 1, kind: "say", author: "boss", body: "hi", at: 1 }, live);
  frames = appendFrame(frames, { type: "event", seq: 2, kind: "note", author: "cos", body: "ack", at: 70_000 }, live);
  const before = groupedRows([...frames].reverse());

  frames = appendFrame(frames, { type: "event", seq: 3, kind: "say", author: "boss", body: "more", at: 140_000 }, live);
  const after = groupedRows([...frames].reverse());

  // The two pre-existing rows must be untouched: same Frame object, same booleans.
  const beforeById = new Map(before.map((r) => [r.f.id, r]));
  for (const row of after) {
    if (row.f.id === "e3") continue;
    const prior = beforeById.get(row.f.id)!;
    expect(row.f).toBe(prior.f);
    expect(row.showHeader).toBe(prior.showHeader);
    expect(row.showDivider).toBe(prior.showDivider);
  }
});

test("a streaming partial frame only changes the row being streamed into", () => {
  const live = { current: 0 };
  let frames: Frame[] = [];
  frames = appendFrame(frames, { type: "event", seq: 1, kind: "say", author: "boss", body: "hi", at: 1 }, live);
  frames = appendFrame(frames, { type: "live", agentId: 9, kind: "text", body: "hel", grpId: 1, at: 2 }, live);
  const before = groupedRows([...frames].reverse());
  const staticRow = before.find((r) => r.f.id === "e1")!;

  frames = appendFrame(frames, { type: "live", agentId: 9, kind: "text", body: "lo", grpId: 1, at: 3 }, live);
  const after = groupedRows([...frames].reverse());
  const staticRowAfter = after.find((r) => r.f.id === "e1")!;
  const streamedRow = after.find((r) => r.f.cls === "partial")!;

  // The row that never changed keeps the exact same Frame reference (memo bails).
  expect(staticRowAfter.f).toBe(staticRow.f);
  // The streaming row is a new object (it must re-render), same id though (no remount).
  expect(streamedRow.f.text).toBe("hello");
});
