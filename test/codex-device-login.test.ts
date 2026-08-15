import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { openMemory } from "../src/db.ts";
import { Scheduler } from "../src/scheduler.ts";
import { loadAuth } from "../src/mech/sandbox/auth.ts";
import { REFRESH_HOME } from "../src/mech/sandbox/chatgpt.ts";
import { startCodexDeviceLogin } from "../src/mech/sandbox/login.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import type { Ctx } from "../src/api.ts";

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

function harness(out: string, auth = '{"tokens":{"refresh_token":"real"},"last_refresh":"2026-08-15T00:00:00Z"}') {
  const db = openMemory();
  const cmds: string[] = [];
  const sandbox = fakeSandbox((cmd) => {
    cmds.push(cmd);
    return { out };
  });
  if (auth) sandbox.files.set(`${REFRESH_HOME}/auth.json`, auth);
  const ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox,
    waiters: new Map(),
    config: { language: "中文" },
  } as unknown as Ctx;
  return { ctx, db, cmds };
}

test("the device code and its URL are read, and the login lands in runtime_auth", async () => {
  const { ctx, db, cmds } = harness(OUTPUT);
  const run = startCodexDeviceLogin(ctx);
  const done = await run.done;

  expect(done.ok).toBe(true);
  expect(run.url).toBe("https://auth.openai.com/codex/device");
  expect(run.code).toBe("T5M2-76TFM");
  // The credential is the file codex wrote, stored where everything reads it.
  expect(loadAuth(db, "codex")!.secret).toContain("real");
  expect(loadAuth(db, "codex")!.mode).toBe("chatgpt");
  // Its own CODEX_HOME, not the one every container's decoy sits in.
  expect(cmds.some((c) => c.includes("codex login --device-auth"))).toBe(true);
});

test("output with no code says so instead of waiting out fifteen minutes", async () => {
  // What a changed CLI looks like. Without this the button spins until the code
  // it never printed expires, and nothing anywhere names the cause.
  const { ctx } = harness("Signed in as someone@example.com\nnothing else here");
  const done = await startCodexDeviceLogin(ctx).done;
  expect(done.ok).toBe(false);
  expect(done.detail).toContain("could not read a device code");
});

test("a second click gets the first login, not a second code", async () => {
  // Two runs would print two codes and the first one would stop working, which
  // reads as "the code you were given is wrong".
  const { ctx } = harness(OUTPUT);
  const a = startCodexDeviceLogin(ctx);
  const b = startCodexDeviceLogin(ctx);
  expect(b).toBe(a);
  await a.done;
});
