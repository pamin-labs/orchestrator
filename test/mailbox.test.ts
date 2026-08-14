import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
function runCli(mb: string, argv: string[]) {
  return Bun.spawn(["bun", "run", "src/orch/cli.ts", ...argv], {
    env: { ...process.env, ORCH_MAILBOX: mb, ORCH_TOKEN: "tok-1", ORCH_URL: "http://127.0.0.1:1" },
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
  const env = JSON.parse(await Bun.file(join(mb, "req", req)).text());
  expect(env.method).toBe("POST");
  expect(env.path).toBe("/orch/status");
  // The token travels in the envelope, because a mailbox has no headers. It is
  // still the identity: anything else able to write here could claim to be any
  // agent, which is why the mailbox lives inside one group's sandbox.
  expect(env.token).toBe("tok-1");

  // Still waiting: an unanswered call must not return, or `orch lease` would
  // come back before the build it is waiting for has run.
  expect(proc.exitCode).toBe(null);

  await Bun.write(join(mb, "res", `${env.id}.json`), JSON.stringify({ status: 200, text: "ok" }));
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toContain("ok");

  // The CLI clears its own answer. Otherwise a restarted orchestrator would see
  // a directory full of stale files it has no way to date.
  expect(existsSync(join(mb, "res", `${env.id}.json`))).toBe(false);
});

test("a non-200 answer is passed through as a failure, not swallowed", async () => {
  const mb = mailbox();
  const proc = runCli(mb, ["status", "x"]);
  let req = "";
  for (let i = 0; i < 100 && !req; i++) {
    req = readdirSync(join(mb, "req"))[0] ?? "";
    if (!req) await Bun.sleep(20);
  }
  const { id } = JSON.parse(await Bun.file(join(mb, "req", req)).text());
  await Bun.write(join(mb, "res", `${id}.json`), JSON.stringify({ status: 422, text: "no such group" }));
  expect(await proc.exited).not.toBe(0);
});
