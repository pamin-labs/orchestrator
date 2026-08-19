import { expect, test } from "bun:test";
import { makeApp } from "../../src/composition/api.ts";
import { boundedWriter } from "../../src/api/panel/stream.ts";
import type { Frame } from "../../src/contracts/events.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

const LAST_SEQ = 1_101;

function harness() {
  const ctx = testContext();
  ctx.db.transaction(() => {
    for (let seq = 1; seq <= LAST_SEQ; seq++) {
      fx.event.insert(ctx.db, { author: "boss", body: `event ${seq}`, at: seq });
    }
  })();
  return makeApp(ctx);
}

async function replay(path: string, headers: HeadersInit, finalSeq: number): Promise<string> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 2_000);
  const response = await harness()(new Request(`http://x${path}`, { headers, signal: abort.signal }));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes(`id: ${finalSeq}\n`)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`SSE ended before event ${finalSeq}`);
    body += decoder.decode(chunk.value, { stream: true });
  }
  clearTimeout(timeout);
  await reader.cancel();
  abort.abort();
  return body;
}

const ids = (body: string) => [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));

test("an initial stream replays the latest 500 events", async () => {
  const seen = ids(await replay("/api/v1/stream?since=0", {}, LAST_SEQ));
  expect(seen).toHaveLength(500);
  expect(seen[0]).toBe(602);
  expect(seen.at(-1)).toBe(LAST_SEQ);
});

test("Last-Event-ID catches up a gap larger than one replay page", async () => {
  const seen = ids(await replay("/api/v1/stream?since=0", { "Last-Event-ID": "500" }, LAST_SEQ));
  expect(seen).toHaveLength(601);
  expect(seen[0]).toBe(501);
  expect(seen.at(-1)).toBe(LAST_SEQ);
});

test("the explicit query cursor is honored", async () => {
  const seen = ids(await replay("/api/v1/stream?since=1000", {}, LAST_SEQ));
  expect(seen).toHaveLength(101);
  expect(seen[0]).toBe(1_001);
  expect(seen.at(-1)).toBe(LAST_SEQ);
});

/** A frame the writer only has to hand to `send`; its content is not the subject. */
const frame = (seq: number): Frame => ({ type: "event", seq, author: "boss", kind: "say", body: "x", at: seq });

test("a browser that stops reading drops frames instead of growing without bound", async () => {
  // The chain was `writes = writes.then(() => send(frame))`, fed by one
  // `bus.live()` per token from up to four concurrent turns. A tab that stopped
  // reading held the stream's backpressure and every later frame accumulated as a
  // closure — no cap, no drop policy, and the one path that grows unboundedly.
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: number[] = [];
  const writer = boundedWriter(async (f) => {
    sent.push(f.type === "event" ? f.seq : -1);
    await blocked;
  }, 4);

  for (let seq = 1; seq <= 20; seq++) void writer.enqueue(frame(seq));
  release();
  await writer.settled();

  // Four in the queue, and the sixteenth frame is not still held in memory.
  expect(sent.length).toBe(4);
});

test("one dead socket ends its own frame, not every frame after it", async () => {
  // `.then` chaining meant a single rejection poisoned the chain permanently:
  // every later link produced another rejected promise, and `void enqueue(...)`
  // left each one unhandled — which reached the process-wide rejection reporter,
  // which emits a bus event, which fans out to this same writer.
  const sent: number[] = [];
  const writer = boundedWriter(async (f) => {
    const seq = f.type === "event" ? f.seq : -1;
    if (seq === 1) throw new Error("socket went away");
    sent.push(seq);
  }, 16);

  for (let seq = 1; seq <= 3; seq++) void writer.enqueue(frame(seq));
  await writer.settled();

  expect(sent).toEqual([2, 3]);
});
