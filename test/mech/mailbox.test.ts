import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalise, serve } from "../../src/mech/sandbox/mailbox.ts";
import type { Json } from "../../src/contracts/json.ts";
import { ProtocolResponse } from "../../src/contracts/protocol.ts";
import { z } from "zod";

const Envelope = z.object({
  id: z.string(),
  method: z.enum(["GET", "POST"]),
  path: z.string(),
  token: z.string(),
  request_id: z.string(),
  idempotency_key: z.string().optional(),
});
const ErrorAnswer = z.object({ status: z.number(), body: z.object({ error: z.string() }) });

/**
 * The agent's only way out.
 *
 * `host.docker.internal` works on Docker Desktop and does not exist on Linux, so
 * building the transport on it would quietly make the orchestrator
 * macOS-and-Windows-only. The files API is the same everywhere. What is checked
 * here is the shape of the exchange — the CLI writes a request and blocks on a
 * response file — because the failure mode if that is wrong is an agent that
 * hangs forever rather than one that errors.
 */

function mailbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-mb-"));
  mkdirSync(join(dir, "req"));
  mkdirSync(join(dir, "res"));
  return dir;
}

/** Run the CLI the way a sandbox does: mailbox in the environment, no network. */
function runCli(mb: string, argv: string[], env: Record<string, string> = {}) {
  return Bun.spawn(["bun", "run", "src/orch/cli.ts", ...argv], {
    env: { ...process.env, ORCH_MAILBOX: mb, ORCH_TOKEN: "tok-1", ORCH_URL: "http://127.0.0.1:1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("a call becomes a request file and blocks until an answer appears", async () => {
  const mb = mailbox();
  const proc = runCli(mb, ["status", "still going"]);

  // The request shows up as a file; nothing has answered it yet.
  let req = "";
  for (let i = 0; i < 100 && !req; i++) {
    req = readdirSync(join(mb, "req"))[0] ?? "";
    if (!req) await Bun.sleep(20);
  }
  expect(req).toMatch(/\.json$/);
  const env = Envelope.parse(JSON.parse(await Bun.file(join(mb, "req", req)).text()));
  expect(env.method).toBe("POST");
  expect(env.path).toBe("/orch/v1/status");
  expect(env.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(env.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  // The token travels in the envelope, because a mailbox has no headers. It is
  // still the identity: anything else able to write here could claim to be any
  // agent, which is why the mailbox lives inside one group's sandbox.
  expect(env.token).toBe("tok-1");

  // Still waiting: an unanswered call must not return, or `orch lease` would
  // come back before the build it is waiting for has run.
  expect(proc.exitCode).toBe(null);

  await Bun.write(join(mb, "res", `${env.id}.json`), JSON.stringify({ status: 200, body: { message: "ok" } }));
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toContain("ok");

  // The CLI clears its own answer. Otherwise a restarted orchestrator would see
  // a directory full of stale files it has no way to date.
  expect(existsSync(join(mb, "res", `${env.id}.json`))).toBe(false);
});

/**
 * A sandbox is a `files` API and nothing else, as far as `serve` is concerned.
 * `writes` is the assertion: the answer the agent would read back.
 */
function fakeFiles(req: Record<string, Json>) {
  const writes: Array<{ path: string; data: string }> = [];
  const deletes: string[][] = [];
  const sb = {
    files: {
      readFile: async () => JSON.stringify({ request_id: "request-test", ...req }),
      deleteFiles: async (paths: string[]) => {
        deletes.push(paths);
      },
      writeFiles: async (fs: Array<{ path: string; data: string }>) => {
        writes.push(...fs);
      },
    },
  } satisfies Parameters<typeof serve>[0];
  return {
    writes,
    deletes,
    sb,
  };
}

test("a malformed envelope cannot select the response path or make a request", async () => {
  const { writes, deletes, sb } = fakeFiles({
    id: "../../boss",
    method: "DELETE",
    path: "/orch/v1/status",
    token: "tok-1",
  });

  await serve(sb, "http://127.0.0.1:1", "/var/orch/req/invalid.json");

  expect(writes).toEqual([]);
  expect(deletes).toEqual([["/var/orch/req/invalid.json"]]);
});

test("an invalid envelope with a safe id receives a bounded failure", async () => {
  const { writes, sb } = fakeFiles({
    id: "safe-id",
    method: "DELETE",
    path: "/orch/v1/status",
    token: "tok-1",
  });

  await serve(sb, "http://127.0.0.1:1", "/var/orch/req/invalid.json");

  expect(writes).toHaveLength(1);
  expect(writes[0]!.path).toContain("/res/safe-id.json");
  expect(JSON.parse(writes[0]!.data)).toEqual({ status: 400, body: { error: "invalid mailbox request" } });
});

test("a sandbox cannot reach the boss's routes through the mailbox", async () => {
  // `/api/v1/*` takes no token — its only caller was a browser on 127.0.0.1. Without
  // the guard this replays, and the agent approves its own DRAFT.
  const { writes, sb } = fakeFiles({
    id: "x",
    method: "POST",
    path: "/api/v1/draft/1/approve",
    token: "tok-1",
  });
  await serve(sb, "http://127.0.0.1:1", "/var/orch/req/x.json");

  expect(writes).toHaveLength(1);
  const answer = ErrorAnswer.parse(JSON.parse(writes[0]!.data));
  // 403, not silence: a dropped request leaves the agent blocked forever.
  expect(answer.status).toBe(403);
  // 502 would mean it tried the fetch and the (unreachable) port refused it.
  expect(answer.body.error).not.toContain("unreachable");
});

test("the prefix guard cannot be walked out of with dot segments", async () => {
  // The guard used to test the raw string and then hand that same raw string to
  // `fetch`, which parses it as a URL and normalises `..` away. So the check saw
  // `/orch/v1/../api/auth` and the server saw `/api/v1/auth` — every unauthenticated
  // boss route, reachable from inside the sandbox. Judged and sent must be the
  // same string.
  for (const path of [
    "/orch/v1/../api/auth",
    "/orch/v1/%2e%2e/api/dirs",
    "/orch/v1/./../api/say",
    "/orch/v1/x/../../api/state",
    "//evil.example/orch/status",
    "http://evil.example/orch/v1/status",
  ]) {
    const { writes, sb } = fakeFiles({ id: "z", method: "POST", path, token: "tok-1" });
    await serve(sb, "http://127.0.0.1:1", "/var/orch/req/z.json");
    expect(writes).toHaveLength(1);
    const answer = ProtocolResponse.parse(JSON.parse(writes[0]!.data));
    // 403 rather than 502: a 502 would mean the fetch was attempted.
    expect({ path, status: answer.status }).toEqual({ path, status: 403 });
  }
});

test("a query string survives normalisation", () => {
  // `orch lease log --grep` is a GET with one, and dropping it would silently
  // return the whole log instead of the lines asked for.
  expect(normalise("http://127.0.0.1:1", "/orch/v1/lease/7/log?grep=error")).toBe(
    "http://127.0.0.1:1/orch/v1/lease/7/log?grep=error",
  );
  expect(normalise("http://127.0.0.1:1", "/orch/status")).toBeNull();
});

test("an /orch route still goes through", async () => {
  const { writes, sb } = fakeFiles({ id: "y", method: "POST", path: "/orch/v1/status", token: "tok-1" });
  await serve(sb, "http://127.0.0.1:1", "/var/orch/req/y.json");
  // Nothing is listening on port 1, so reaching the fetch at all is the assertion.
  expect(ProtocolResponse.parse(JSON.parse(writes[0]!.data)).status).toBe(502);
});

test("a non-200 answer is passed through as a failure, not swallowed", async () => {
  const mb = mailbox();
  const proc = runCli(mb, ["status", "x"]);
  let req = "";
  for (let i = 0; i < 100 && !req; i++) {
    req = readdirSync(join(mb, "req"))[0] ?? "";
    if (!req) await Bun.sleep(20);
  }
  const { id } = Envelope.parse(JSON.parse(await Bun.file(join(mb, "req", req)).text()));
  await Bun.write(join(mb, "res", `${id}.json`), JSON.stringify({ status: 422, body: { error: "no such group" } }));
  expect(await proc.exited).not.toBe(0);
});

test("an unanswered CLI request times out and removes both mailbox files", async () => {
  const mb = mailbox();
  const proc = runCli(mb, ["status", "no answer"], { ORCH_MAILBOX_TIMEOUT_MS: "10" });

  expect(await proc.exited).not.toBe(0);
  expect(await new Response(proc.stderr).text()).toContain("timed out after 10ms");
  expect(readdirSync(join(mb, "req"))).toEqual([]);
  expect(readdirSync(join(mb, "res"))).toEqual([]);
});
