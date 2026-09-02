import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { loadAuth } from "../../src/mech/sandbox/auth.ts";
import { REFRESH_HOME } from "../../src/mech/sandbox/chatgpt.ts";

/** The older shape, still minted by a CLI that has not changed. */
const CLAUDE_TOKEN = `sk-ant-oat01-${"aB3-_x9Z".repeat(6)}`;
import {
  currentClaudeLogin,
  currentCodexDeviceLogin,
  startClaudeLogin,
  startCodexDeviceLogin,
} from "../../src/mech/sandbox/login.ts";
import { fakePty, type FakePty } from "../support/fake-pty.ts";
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
  // Codex runs through the command runner and Claude through a terminal, so the
  // same scripted output is offered on both — each test uses the one its
  // runtime reads.
  const pty = sayingThenExit(out);
  // The command reaches the terminal now, not the command runner — both logins
  // open a pty (ADR 053), so `cmds` no longer sees them.
  const ctx = await testContext({
    db,
    sandbox,
    pty: async (_c, _s, command) => {
      cmds.push(command);
      return pty;
    },
  });
  return { ctx, db, cmds, pty };
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
    `Open https://console.anthropic.com/oauth/code\nPaste code here if prompted >\n${CLAUDE_TOKEN}`,
  );
  const run = startClaudeLogin(ctx);
  expect(await run.done).toEqual({ ok: true, detail: "stored" });
  // The link is not mistaken for the credential, though it is long and unbroken.
  expect(run.url).toBe("https://console.anthropic.com/oauth/code");
  expect(await loadAuth(db, "claude")).toMatchObject({ mode: "oauth_token", secret: CLAUDE_TOKEN });
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
 * Now that both logins open a terminal, the slot is released in `cancel()` and
 * the daemon is told to stop the process — the two halves the abort could not
 * do.
 */
test("cancelling a claude login frees the slot and signals the process", async () => {
  // A fresh terminal per login, like the real one: a session is opened for each
  // and its generator is consumed once.
  const opened: FakePty[] = [];
  const ctx = await testContext({
    sandbox: fakeSandbox(),
    pty: async () => {
      const p = saying("Paste code here if prompted >");
      opened.push(p);
      return p;
    },
  });
  const first = startClaudeLogin(ctx);
  expect(currentClaudeLogin()).toBe(first);
  // The terminal is opened asynchronously; a cancel before it is open must still
  // release the slot, and one after it must reach the process.
  await Bun.sleep(20);

  first.cancel();
  // Released now, not when `done` settles — which, here, is never.
  expect(currentClaudeLogin()).toBeNull();
  // A signal the container receives. Aborting an HTTP request did not stop the
  // command, which is how a dead run kept the slot.
  expect(opened[0]?.signals).toEqual(["SIGINT"]);
  const second = startClaudeLogin(ctx);
  expect(second).not.toBe(first);
  second.cancel();
});

test("cancelling a codex login frees the slot and signals the process", async () => {
  // A fresh terminal per login, like the real one.
  const opened: FakePty[] = [];
  const ctx = await testContext({
    sandbox: fakeSandbox(),
    pty: async () => {
      const p = saying("waiting for the browser");
      opened.push(p);
      return p;
    },
  });
  const first = startCodexDeviceLogin(ctx);
  expect(currentCodexDeviceLogin()).toBe(first);
  await Bun.sleep(20);

  first.cancel();
  expect(currentCodexDeviceLogin()).toBeNull();
  // Codex ran through the command runner before this, whose cancel aborts an
  // HTTP request and leaves the process polling an OAuth endpoint for the rest
  // of its sixteen-minute server-side timeout.
  expect(opened[0]?.signals).toEqual(["SIGINT"]);
  const second = startCodexDeviceLogin(ctx);
  expect(second).not.toBe(first);
  second.cancel();
});

/**
 * The login finishes on the token, not on the stream.
 *
 * `realLines` ends its queue when the SDK's `run()` promise settles, and
 * measured on a live server it did not: `claude setup-token` had exited — no
 * process left in the container — while the stream stayed open. The read sat on
 * `stream.next()` forever, `run.done` never resolved, and the panel showed a
 * link whose pasted code went into a file with no reader. No event was emitted
 * either way, so nothing said so.
 */
/**
 * Every line is delivered as it arrives, so by the time the token has been
 * printed the rest of the stream holds nothing this needs. The driver here does
 * exactly what that one did: yields the CLI's output, then never ends.
 */
/**
 * A terminal that says these lines and then holds, which is what the CLI does
 * while it waits for the boss. `exit` is never called, so a login that only
 * finishes when the session ends would hang here — that is deliberate.
 */
const saying = (out: string): FakePty => fakePty(out.split("\n").filter(Boolean));

/** The same, for a CLI that says its piece and exits — which is what an ending
 *  looks like now that the transport has one. */
const sayingThenExit = (out: string, code = 0): FakePty => {
  const pty = saying(out);
  queueMicrotask(() => pty.exit(code));
  return pty;
};

/** The login, driven through a terminal the test owns. */
const withPty = async (pty: FakePty, db?: Awaited<ReturnType<typeof openMemory>>) =>
  testContext({ ...(db ? { db } : {}), sandbox: fakeSandbox(), pty: async () => pty });

test("a printed token completes the login even if the stream never ends", async () => {
  const db = await openMemory();
  const ctx = await withPty(saying(`Open https://claude.ai/oauth/authorize?x=1 to continue\n${CLAUDE_TOKEN}`), db);

  const run = startClaudeLogin(ctx);
  const done = await Promise.race([run.done, Bun.sleep(5_000).then(() => null)]);
  expect(done).not.toBeNull();
  expect(done?.ok).toBe(true);
  expect((await loadAuth(db, "claude"))?.secret).toBe(CLAUDE_TOKEN);
  // And the slot is free again, so the next sign-in is a new run rather than
  // this one with its url already cached.
  expect(currentClaudeLogin()).toBeNull();
});

/**
 * A submitted code always gets an answer, even when nothing follows it.
 *
 * The early stop above covers the run that prints a token. This covers the other
 * one: the CLI prints an OAuth error and exits, so there is no line to stop on —
 * and the stream stays open regardless, because `realLines` closes its queue on
 * a `run()` promise that measured on a live server did not settle. Without a
 * deadline the read waits forever and the panel is told nothing at all, which is
 * how three sign-in attempts ended in silence.
 */
/**
 * The clock starts on the submit and not before: while the boss is in a browser
 * the CLI is silent, and that silence is not a fault.
 */
test("a submitted code that draws no answer still ends the login", async () => {
  const base = loadConfig();
  const pty = saying("Open https://claude.ai/oauth/authorize?x=1 to continue\nPaste code here if prompted >");
  const ctx = await testContext({
    db: await openMemory(),
    sandbox: fakeSandbox(),
    pty: async () => pty,
    // The real 45s is the boss's grace, not a property under test; what is under
    // test is that the deadline exists and starts on the submit.
    config: { ...base, timeouts: { ...base.timeouts, loginVerdictMs: 300 } },
  });

  const run = startClaudeLogin(ctx);
  // Nothing is pending on the login itself yet — the deadline has not started.
  expect(await Promise.race([run.done.then(() => "ended"), Bun.sleep(300).then(() => "waiting")])).toBe("waiting");

  await run.submit("WDJB-MJHT");
  const done = await Promise.race([run.done, Bun.sleep(5_000).then(() => null)]);
  expect(done?.ok).toBe(false);
  expect(done?.detail).toContain("no verdict");
  expect(currentClaudeLogin()).toBeNull();
});

/**
 * The token has no prefix any more, so it is found by where it is printed.
 *
 * Measured against a real sign-in on claude-code 2.1.233: the whole exchange
 * succeeded — the approval, the code, the round trip — and an opaque 90-odd
 * character token went past on its own line under
 * `Your OAuth token (valid for 1 year):`. The recogniser was
 * `/sk-ant-oat01-…/`, so the login reported that no token was ever printed and
 * threw away a credential the boss cannot see again.
 */
/**
 * Transcribed from that run, ANSI stripped. The heading has to be checked after
 * the line it introduces, or the announcement matches as its own token.
 */
/**
 * Transcribed from a real sign-in, truncated. Its length and character mix are
 * the point: the recogniser no longer knows any prefix, so a fixture shaped like
 * `sk-ant-oat01-token_value` would pass a test the product cannot pass.
 */
const NEW_TOKEN = `sk-ant-at01-CJCHm1_dwua-3YSY-OtA1YEsig1AggeB2Axp3eQb5Tqm${"KsYY6qId".repeat(3)}`;

const REAL_TAIL = [
  "Paste code here if prompted >",
  "✓ Long-lived authentication token created successfully!",
  // Both layouts the CLI has produced, one run apart: the sentence on its own
  // line, and the sentence with the token appended. A whole-line rule reads the
  // second as prose and reports that nothing was printed.
  `Your OAuth token (valid for 1 year): ${NEW_TOKEN}`,
  "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>",
  "Store this token securely. You won't be able to see it again.",
].join("\n");

test("a token with no prefix is still recognised and stored", async () => {
  const db = await openMemory();
  const ctx = await withPty(saying(REAL_TAIL), db);

  const run = startClaudeLogin(ctx);
  const done = await Promise.race([run.done, Bun.sleep(5_000).then(() => null)]);
  expect(done?.ok).toBe(true);
  const stored = (await loadAuth(db, "claude"))?.secret;
  expect(stored).toBe(NEW_TOKEN);
  // Not the sentence that introduced it, and not the `export …=<token>` line.
  expect(stored).not.toContain("OAuth");
});

/** The old shape keeps working: a CLI that has not changed yet mints one, and
 *  the prefix match runs before the heading is ever seen. */
/**
 * The two other long unbroken lines this output contains, neither of which is a
 * credential: the login link, and the row of asterisks the CLI echoes a pasted
 * code back as. A recogniser that only knew "long and no spaces" would take the
 * asterisks — they are exactly as long as the code that was pasted.
 */
test("neither the link nor the masked echo is mistaken for the token", async () => {
  const db = await openMemory();
  const ctx = await testContext({
    db,
    sandbox: fakeSandbox(),
    pty: async () =>
      saying(
        [
          "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code",
          // The mask as the CLI actually prints it: asterisks with the last few
          // characters of the pasted code in clear. An all-asterisk line was the
          // first version of this fixture and it passed against the recogniser
          // that shipped the mask as the credential — the clear tail is what made
          // it mix case and digits.
          `${"*".repeat(88)}CXxA`,
          NEW_TOKEN,
        ].join("\n"),
      ),
  });
  const done = await Promise.race([startClaudeLogin(ctx).done, Bun.sleep(5_000).then(() => null)]);
  expect(done?.ok).toBe(true);
  expect((await loadAuth(db, "claude"))?.secret).toBe(NEW_TOKEN);
});

test("a sk-ant-oat01 token is still recognised", async () => {
  const db = await openMemory();
  const ctx = await withPty(saying(`some preamble\n${CLAUDE_TOKEN}`), db);
  const done = await Promise.race([startClaudeLogin(ctx).done, Bun.sleep(5_000).then(() => null)]);
  expect(done?.ok).toBe(true);
  expect((await loadAuth(db, "claude"))?.secret).toBe(CLAUDE_TOKEN);
});

/**
 * The code and its Enter arrive as two keystrokes.
 *
 * The CLI turns on bracketed paste, so one write carrying text and a `\r`
 * together is one paste and the `\r` inside it is content rather than a key.
 * Measured against claude-code 2.1.233: ten characters and a CR in one write
 * submitted; ninety-two did not — every asterisk echoed back and then nothing.
 */
/**
 * Asserted on what reaches the terminal rather than on the runner's source,
 * which is what the guard this replaces did — and it read stdin a byte at a time,
 * so it could not tell a pasted return from a pressed one and passed against the
 * broken version.
 */
test("a submitted code is typed, then Enter, as two separate keystrokes", async () => {
  const pty = saying("Paste code here if prompted >");
  const ctx = await withPty(pty);
  const run = startClaudeLogin(ctx);
  await Bun.sleep(20);

  const code = `${"a".repeat(43)}#${"b".repeat(48)}`;
  await run.submit(`  ${code}  `);
  expect(pty.typed).toEqual([code, "\r"]);

  run.cancel();
});
