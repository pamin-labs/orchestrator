import { expect, test } from "bun:test";
import { foldQueueItems, queueClusters, type QueueItem } from "../web/src/features/queue/model.ts";
import { replyKeyAction } from "../web/src/views/queue.tsx";

const item = (key: string, grpId: number | null, points: number, about = "other", hard = false): QueueItem => ({
  key,
  kind: "提问",
  what: key,
  where: grpId == null ? "常驻岗" : `需求 ${grpId}`,
  sub: "qa",
  who: "qa",
  hard,
  about,
  grpId,
  points,
  reasons: [],
  flag: null,
  href: null,
  escId: null,
  fyi: false,
});

test("queue clusters use the most urgent item and keep standing questions visible", () => {
  const clusters = queueClusters([item("slow", 1, 10), item("blocked", 1, 100), item("standing", null, 80)]);
  expect(clusters.map(({ grpId, points }) => ({ grpId, points }))).toEqual([
    { grpId: 1, points: 100 },
    { grpId: -1, points: 80 },
  ]);
  expect(clusters[0]!.items.map(({ key }) => key)).toEqual(["blocked", "slow"]);
});

test("same-role questions about one subject fold behind the blocker", () => {
  const folded = foldQueueItems([
    item("one", 1, 10, "env"),
    item("two", 1, 20, "env"),
    item("blocker", 1, 100, "boundary", true),
  ]);
  expect(folded.map(({ item: row, n }) => ({ key: row.key, n }))).toEqual([
    { key: "blocker", n: 1 },
    { key: "one", n: 2 },
  ]);
});

test("reply shortcuts close on Escape and submit only with the platform modifier", () => {
  expect(replyKeyAction("Escape", false, false)).toBe("close");
  expect(replyKeyAction("Enter", true, false)).toBe("send");
  expect(replyKeyAction("Enter", false, true)).toBe("send");
  expect(replyKeyAction("Enter", false, false)).toBeNull();
  expect(replyKeyAction("a", true, false)).toBeNull();
});
