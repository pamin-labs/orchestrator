import { expect, test } from "bun:test";
import { appendFrame, type Frame } from "../web/src/lib/api.ts";

/**
 * The flicker's root cause was index keys: a new frame prepended in the
 * timeline shifts every existing frame's array position, so React remounts
 * the whole list and replays fade-in on rows that never changed. This locks
 * down the fix at the id-assignment layer, one level below rendering.
 */

test("appending a new event frame does not change ids already assigned", () => {
  const live = { current: 0 };
  let frames: Frame[] = [];
  frames = appendFrame(frames, { type: "event", seq: 1, kind: "say", author: "boss", body: "hi", at: 1 }, live);
  frames = appendFrame(frames, { type: "event", seq: 2, kind: "say", author: "cos", body: "ack", at: 2 }, live);
  const idsBefore = frames.map((f) => f.id);

  frames = appendFrame(frames, { type: "event", seq: 3, kind: "say", author: "boss", body: "more", at: 3 }, live);

  expect(frames.slice(0, 2).map((f) => f.id)).toEqual(idsBefore);
  expect(frames.map((f) => f.id)).toEqual(["e1", "e2", "e3"]);
});

test("a reconnect replay (same seq) is deduped, not appended as a second row", () => {
  const live = { current: 0 };
  let frames: Frame[] = [];
  frames = appendFrame(frames, { type: "event", seq: 5, kind: "say", author: "boss", body: "hi", at: 1 }, live);
  const before = frames[0]!.id;

  // /api/stream?since=0 never advances, so a reconnect resends the same seq
  // through the same path. It must not become a second row with a duplicate key.
  frames = appendFrame(frames, { type: "event", seq: 5, kind: "say", author: "boss", body: "hi", at: 1 }, live);
  expect(frames.length).toBe(1);
  expect(frames[0]!.id).toBe(before);
});

test("a streaming partial frame merges into the last live entry, keeping its id", () => {
  const live = { current: 0 };
  let frames: Frame[] = [];
  frames = appendFrame(frames, { type: "live", agentId: 9, kind: "text", body: "hel", grpId: 1 }, live);
  const id = frames[0]!.id;
  expect(frames[0]!.cls).toBe("partial");

  frames = appendFrame(frames, { type: "live", agentId: 9, kind: "text", body: "lo", grpId: 1 }, live);
  expect(frames.length).toBe(1);
  expect(frames[0]!.id).toBe(id);
  expect(frames[0]!.text).toBe("hello");
});

test("a full-history reconnect replay never leaves the frame array with duplicate ids", () => {
  const live = { current: 0 };
  let frames: Frame[] = [];
  for (let seq = 1; seq <= 3; seq++) {
    frames = appendFrame(frames, { type: "event", seq, kind: "say", author: "boss", body: `m${seq}`, at: seq }, live);
  }
  // /api/stream?since=0 replays from the start on every reconnect, so seq 1-3
  // come back through the exact same path they arrived on the first time.
  for (let seq = 1; seq <= 3; seq++) {
    frames = appendFrame(frames, { type: "event", seq, kind: "say", author: "boss", body: `m${seq}`, at: seq }, live);
  }
  const ids = frames.map((f) => f.id);
  expect(ids).toEqual(["e1", "e2", "e3"]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("live and persisted ids live in separate domains and never collide", () => {
  const live = { current: 0 };
  let frames: Frame[] = [];
  frames = appendFrame(frames, { type: "live", agentId: 1, kind: "tool", body: "grep", grpId: 1 }, live);
  frames = appendFrame(frames, { type: "event", seq: 1, kind: "say", author: "boss", body: "hi", at: 1 }, live);
  const ids = frames.map((f) => f.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids[0]).toBe("l1");
  expect(ids[1]).toBe("e1");
});
