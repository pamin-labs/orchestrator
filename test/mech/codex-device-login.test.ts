import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { loadAuth } from "../../src/mech/sandbox/auth.ts";
import { REFRESH_HOME } from "../../src/mech/sandbox/chatgpt.ts";
import {
  currentClaudeLogin,
  currentCodexDeviceLogin,
  startClaudeLogin,
  startCodexDeviceLogin,
} from "../../src/mech/sandbox/login.ts";
import type { SandboxDriver } from "../../src/mech/sandbox/sandbox.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";

/**
 * Logging in to a ChatGPT account without a browser inside the container.
 *
 * `codex login` proper registers `http://localhost:1455/auth/callback` with the
 * provider, so no proxied endpoint can satisfy it — probed. `--device-auth` is
 * codex's own answer: a URL and a one-time code, polled by the real CLI.
 *
 * What breaks silently is the parsing: if the CLI changes its wording the login
 * simply never completes, so the failure has to name itself.
 */

// Verbatim from `codex login --device-auth`, codex-cli 0.147.0.
const OUTPUT = [
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "1. Open this link in your browser and sign in to your account",
  "   https://auth.openai.com/codex/device",
  "2. Enter this one-time code (expires in 15 minutes)",
  "   T5M2-76TFM",
].join("\n");

async function harness(
  out: string,
  auth = '{"tokens":{"refresh_token":"real"},"last_refresh":"2026-08-15T00:00:00Z"}',
) {
  const db = await openMemory();
  const cmds: string[] = [];
  const sandbox = fakeSandbox((cmd) => {
    cmds.push(cmd);
    return { out };
  });
  if (auth) sandbox.files.set(`${REFRESH_HOME}/auth.json`, auth);
  const ctx = await testContext({ db, sandbox });
  return { ctx, db, cmds };
}

test("the device code and its URL are read, and the login lands in runtime_auth", async () => {
  const { ctx, db, cmds } = await harness(OUTPUT);
  const run = startCodexDeviceLogin(ctx);
  const done = await run.done;

  expect(done.ok).toBe(true);
  expect(run.url).toBe("https://auth.openai.com/codex/device");
  expect(run.code).toBe("T5M2-76TFM");
  // The credential is the file codex wrote, stored where everything reads it.
  expect((await loadAuth(db, "codex"))!.secret).toContain("real");
  expect((await loadAuth(db, "codex"))!.mode).toBe("chatgpt");
  // Its own CODEX_HOME, not the one every container's decoy sits in.
  expect(cmds.join("\n")).toContain("codex login --device-auth");
});

test("output with no code says so instead of waiting out fifteen minutes", async () => {
  // What a changed CLI looks like. Without this the button spins until the code
  // it never printed expires, and nothing anywhere names the cause.
  const { ctx } = await harness("Signed in as someone@example.com\nnothing else here");
  const done = await startCodexDeviceLogin(ctx).done;
  expect(done.ok).toBe(false);
  expect(done.detail).toContain("could not read a device code");
});

test("a second click gets the first login, not a second code", async () => {
  // Two runs would print two codes and the first one would stop working, which
  // reads as "the code you were given is wrong".
  const { ctx } = await harness(OUTPUT);
  const a = startCodexDeviceLogin(ctx);
  const b = startCodexDeviceLogin(ctx);
  expect(b).toBe(a);
  await a.done;
});

test("Claude's own setup flow supplies the URL and stores its printed token", async () => {
  const { ctx, db } = await harness(
    "Open https://console.anthropic.com/oauth/code\nPaste code here if prompted >\nsk-ant-oat01-token_value",
  );
  const run = startClaudeLogin(ctx);
  expect(await run.done).toEqual({ ok: true, detail: "stored" });
  expect(run.url).toBe("https://console.anthropic.com/oauth/code");
  expect(await loadAuth(db, "claude")).toMatchObject({ mode: "oauth_token", secret: "sk-ant-oat01-token_value" });
});

test("Claude names a rejected or expired pasted code instead of claiming success", async () => {
  const { ctx } = await harness("Open https://console.anthropic.com/oauth/code\nPaste code here if prompted >");
  const done = await startClaudeLogin(ctx).done;
  expect(done.ok).toBe(false);
  expect(done.detail).toContain("wrong or expired");
});

/**
 * Cancelling has to give the slot back, even when the exec ignores its abort.
 *
 * Both logins are get-or-create, and the slot was released in `done`'s `finally`.
 * An exec that does not answer its abort leaves `done` pending forever, so the
 * slot stayed occupied by a run whose process was gone — and every later login
 * was handed it. Its `url` is still cached, so the panel showed a link and the
 * boss pasted a code against a pty that had already exited, into a file whose
 * reader was gone.
 */
/**
 * Measured on a live server: `POST /auth/claude/login/cancel` returned nothing
 * for 20s, and every sign-in after it produced a link that did nothing.
 */
const deaf = (): SandboxDriver => ({
  ...fakeSandbox(),
  // Never yields, never returns, and never looks at the signal. The `yield` is
  // unreachable and is there because a generator has to contain one.
  lines: async function* () {
    if (Date.now() < 0) yield "";
    await new Promise<never>(() => {});
    return { code: 0, err: "" };
  },
});

test("cancelling a claude login frees the slot for the next one", async () => {
  const ctx = await testContext({ sandbox: deaf() });
  const first = startClaudeLogin(ctx);
  expect(currentClaudeLogin()).toBe(first);

  first.cancel();
  // Released now, not when `done` settles — which, here, is never.
  expect(currentClaudeLogin()).toBeNull();
  expect(startClaudeLogin(ctx)).not.toBe(first);
});

test("cancelling a codex login frees the slot for the next one", async () => {
  const ctx = await testContext({ sandbox: deaf() });
  const first = startCodexDeviceLogin(ctx);
  expect(currentCodexDeviceLogin()).toBe(first);

  first.cancel();
  expect(currentCodexDeviceLogin()).toBeNull();
  expect(startCodexDeviceLogin(ctx)).not.toBe(first);
});
