import { expect, test } from "bun:test";
import { makeApp } from "../../src/composition/api.ts";
import { boundedWriter } from "../../src/api/panel/stream.ts";
import type { Frame } from "../../src/contracts/events.ts";
import * as fx from "../support/factories.ts";
import { event } from "../../src/platform/persistence/schema.ts";
import { testContext } from "../support/test-context.ts";

const LAST_SEQ = 1_101;

async function harness() {
  const ctx = await testContext();
  // One statement rather than 1101: the transaction this used to open was there
  // for the same reason, and the rows are what the test is about, not the writes.
  await ctx.db
    .insert(event)
    .values(
      Array.from({ length: LAST_SEQ }, (_, i) => fx.event.build({ author: "boss", body: `event ${i + 1}`, at: i + 1 })),
    );
  return makeApp(ctx);
}

async function replay(path: string, headers: HeadersInit, finalSeq: number): Promise<string> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 2_000);
  const response = await (await harness())(new Request(`http://x${path}`, { headers, signal: abort.signal }));
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

/**
 * A stream the server can end, because `server.stop(false)` cannot.
 *
 * Bun's graceful stop waits for every request to finish and an SSE request never
 * does. Measured against Bun 1.4: 3ms to stop with no stream open, still hanging
 * at 5s with one. So a single panel tab held the graceful phase to its whole
 * 10s deadline, `shutdownRuntime` returned 1, and ctrl-c printed
 * `error: script "server" exited with code 1` over a clean shutdown.
 */
/**
 * `ctx.closing` is the third way a stream ends and the only one the client does
 * not start. Dropping the subscription is free: the panel reconnects on its own
 * `retry: 3000`, and there is nothing to reconnect to.
 */
test("a closing server ends the stream rather than being held open by it", async () => {
  const closing = new AbortController();
  const ctx = await testContext({ closing: closing.signal });
  const response = await makeApp(ctx)(new Request("http://x/api/v1/stream?since=0"));
  const reader = response.body!.getReader();
  // The `: connected` preamble, so the stream is live before anything is asked
  // of it — a stream that never opened would end for the wrong reason.
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("connected");

  closing.abort();
  const ended = await Promise.race([
    (async () => {
      for (;;) if ((await reader.read()).done) return "ended";
    })(),
    Bun.sleep(2_000).then(() => "still open after 2s"),
  ]);
  expect(ended).toBe("ended");
});

/** An `AbortSignal` that is already aborted does not fire `addEventListener`, so
 *  a tab that connects during shutdown would hold the stream open forever on the
 *  listener alone. */
test("a stream opened after the server started closing does not stay open", async () => {
  const closing = new AbortController();
  closing.abort();
  const ctx = await testContext({ closing: closing.signal });
  const response = await makeApp(ctx)(new Request("http://x/api/v1/stream?since=0"));
  const reader = response.body!.getReader();
  const ended = await Promise.race([
    (async () => {
      for (;;) if ((await reader.read()).done) return "ended";
    })(),
    Bun.sleep(2_000).then(() => "still open after 2s"),
  ]);
  expect(ended).toBe("ended");
});
