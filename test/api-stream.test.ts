import { expect, test } from "bun:test";
import { makeApp } from "../src/api.ts";
import type { Ctx } from "../src/mech/ctx.ts";
import type { Frame } from "../src/contracts/events.ts";
import { Bus } from "../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../src/platform/config/load.ts";
import { openMemory } from "../src/platform/persistence/database.ts";
import { Scheduler } from "../src/platform/scheduling/scheduler.ts";
import { flushPending } from "../src/api/panel/stream.ts";

/**
 * Replay from a cursor, and the buffer that keeps a reconnect from seeing double.
 *
 * A browser that reconnects has to catch up on what it missed, so the stream
 * replays. Events persisted while that catch-up is running are buffered and then
 * deduped against the cursor the replay finished on — without that, the first
 * frames after a reconnect are the last frames before it, again.
 */

const event = (seq: number): Frame => ({
  type: "event",
  seq,
  at: seq,
  author: "orchestrator",
  kind: "note",
  body: `e${seq}`,
});
const live = (): Frame => ({ type: "live", grpId: null, agentId: null, kind: "status", body: "thinking" });

function sink() {
  const sent: Frame[] = [];
  return { sent, enqueue: async (frame: Frame) => void sent.push(frame) };
}

test("a frame the replay already sent is not sent again", async () => {
  const s = sink();
  // 4 and 5 were persisted before the replay's cursor caught up, so the replay
  // carried them. 6 landed after it, and a live frame has no seq to compare.
  await flushPending([event(4), event(5), live(), event(6)], 5, () => false, s.enqueue);
  expect(s.sent.map((f) => (f.type === "event" ? f.seq : "live"))).toEqual(["live", 6]);
});

test("nothing is flushed to a connection that has already gone", async () => {
  const s = sink();
  await flushPending([event(9)], 0, () => true, s.enqueue);
  expect(s.sent).toEqual([]);

  // And a connection that drops mid-flush stops there rather than writing on.
  const half = sink();
  let seen = 0;
  await flushPending([event(1), event(2), event(3)], 0, () => seen++ >= 1, half.enqueue);
  expect(half.sent).toHaveLength(1);
});

test("the stream replays from the cursor the browser last saw", async () => {
  const db = openMemory();
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    waiters: new Map(),
    config: loadConfig(),
  };
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', 'o/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  for (const body of ["first", "second", "third"]) {
    ctx.bus.emit({ grpId: 1, author: "orchestrator", kind: "note", body });
  }
  const app = makeApp(ctx);

  const abort = new AbortController();
  const res = await app(
    // `last-event-id` is what the browser resends by itself; `since` is what the
    // panel passes when it is opening cold. The larger of the two wins.
    new Request("http://x/api/v1/stream?since=1", { headers: { "last-event-id": "2" }, signal: abort.signal }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("third")) {
    const step = await reader.read();
    if (step.done) break;
    text += new TextDecoder().decode(step.value);
  }
  abort.abort();
  await reader.cancel();

  // Only what came after the cursor, and each frame carries the seq the browser
  // will send back as `last-event-id`.
  expect(text).toContain("third");
  expect(text).not.toContain("first");
  expect(text).not.toContain("second");
  expect(text).toContain("id: 3");
  // The project is resolved from the group so the panel can filter without a
  // second round trip.
  expect(text).toContain('"projectId":1');
});
