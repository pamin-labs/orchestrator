import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { makeApp } from "../../src/composition/api.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import type { Json } from "../../src/contracts/json.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";

/**
 * When a login prints nothing, which layer gets named.
 *
 * Both CLIs run through `execLines(ctx, UTIL, …)`, so a sandbox server that
 * refuses us is a login that prints nothing — identical, from the route, to a
 * CLI whose output we no longer recognise. It was reported as the second: the
 * boss told to run `claude setup-token` in the image, while the panel's own
 * timeline already said the sandbox server was refusing us.
 */
/**
 * The probe inside `inspectServer` opens a real socket, and happy-dom's `fetch`
 * cannot: given one, it answers `none` whatever is listening, and this test
 * passes against a build with the fix removed.
 *
 * The preload used to keep that away by not registering a document for a file
 * that imports no browser module. It registers for every worker now and puts
 * Bun's `fetch` back after it, which is what makes this safe — see
 * `test/support/dom.ts`.
 */

/** A listener that answers 401 and nothing else, which is the whole condition:
 *  the address is taken and we cannot drive what is on it. Raw TCP because the
 *  probe reads the status line and stops. */
async function refusing(): Promise<{ at: string; close: () => Promise<void> }> {
  const server = createServer((socket) => {
    socket.on("data", () => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  // Port 0: two workers of a parallel run must not pick the same one.
  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  // `address()` is `string | AddressInfo | null` — a string for a unix socket,
  // which this never is, but narrowing beats asserting it away.
  const bound = server.address();
  if (typeof bound !== "object" || !bound) throw new Error("the refusing server did not bind a port");
  return {
    at: `127.0.0.1:${bound.port}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}

test("a sandbox server that refuses us is named instead of the image", async () => {
  const { at, close } = await refusing();
  try {
    const base = loadConfig();
    const ctx = await testContext({
      // Exits non-zero with nothing on stdout — the CLI never gets to print,
      // which is exactly what an unusable sandbox produces.
      sandbox: fakeSandbox(() => ({ code: 1, err: "no sandbox" })),
      config: { ...base, sandbox: { ...base.sandbox, server: at } },
    });
    const app = makeApp(ctx);
    const post = (path: string, body?: Json) =>
      app(
        new Request(`http://x${path}`, {
          method: "POST",
          body: JSON.stringify(body ?? {}),
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        }),
      );

    for (const [path, cliAdvice] of [
      ["/api/v1/auth/claude/login", "claude setup-token"],
      ["/api/v1/auth/codex/device", "codex login --device-auth"],
    ] as const) {
      const r = await post(path);
      expect(r.status).toBe(422);
      const text = await r.text();
      // Names the address that refused us, and does not send anybody into the
      // image to look for a CLI that was never started.
      expect(text).toContain(at);
      expect(text).not.toContain(cliAdvice);
    }
  } finally {
    await close();
  }
});
