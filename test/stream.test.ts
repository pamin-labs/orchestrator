import { expect, test } from "bun:test";
import { makeApp } from "../src/composition/api.ts";
import { testContext } from "./test-context.ts";

const LAST_SEQ = 1_101;

function harness() {
  const ctx = testContext();
  const insert = ctx.db.prepare("INSERT INTO event (author, kind, body, at) VALUES ('boss', 'say', ?, ?)");
  ctx.db.transaction(() => {
    for (let seq = 1; seq <= LAST_SEQ; seq++) insert.run(`event ${seq}`, seq);
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
