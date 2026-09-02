import type { Bus } from "../../platform/persistence/event-bus.ts";
import type { Ctx } from "../../mech/ctx.ts";
import { saveAuth } from "./auth.ts";
import { REFRESH_HOME } from "./chatgpt.ts";
import { execLines, getFile, UTIL } from "./sandbox.ts";
import { openPty, type PtySession } from "./pty.ts";

/**
 * Logging in without leaving the panel.
 *
 * Both CLIs already do this properly — print a URL, wait for the browser, hand back
 * a credential — so the panel runs the CLI rather than reimplementing two OAuth
 * flows against undocumented client ids.
 */
/**
 * In the **utility container**, all of it. Both flows produce a real long-lived
 * credential, and that container is the one with no agent, no mailbox and no `orch`
 * in it — which is the entire reason it is allowed to hold one. The host runs the
 * server and nothing else; the browser is still the boss's.
 */

/**
 * Terminal escapes, gone before anything is matched.
 *
 * `claude setup-token` prints its URL as an OSC 8 hyperlink — the address twice,
 * once inside `ESC ] 8 ; ; … ST` and once as the visible label — so a naive
 * match on the raw line captures both plus the escape bytes between them. What
 * reached the panel was a link twice its own length ending in `]8;;`.
 */
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[a-zA-Z]/g;
const clean = (s: string) => s.replace(ANSI, " ");

const URL_RE = /https?:\/\/[^\s\u0007\u001b"'<>]+/;
/**
 * The token, recognised by what a credential is rather than by what this CLI
 * currently prints.
 *
 * Two hard-coded recognisers have already expired. `sk-ant-oat01-` became
 * `sk-ant-at01-` — one letter — and the login reported that no token was printed
 * while the event stream carried `✓ Long-lived authentication token created
 * successfully!` and the value itself. Anchoring on that sentence instead only
 * moves the guess: the wording is the CLI's to change, and it is not a contract.
 */
/**
 * What is left is a shape nobody owns. A credential line is long, has no
 * whitespace, is not a URL, and mixes character classes — which separates it
 * from the two other long unbroken lines in this output: the link, and the row
 * of asterisks a pasted code is echoed back as.
 */
/**
 * Not a prefix, not a sentence, not a length the provider chose. If it ever
 * matches the wrong line the deadline reports a failed sign-in and the boss can
 * see what was on it; a recogniser that matches nothing loses a credential
 * silently, which is what both of the previous ones did.
 */
const TOKEN_MIN = 40;

/**
 * How much of a line one character may be before it is padding, not payload.
 *
 * The CLI echoes a pasted code back as asterisks with its last few characters in
 * clear — `********…CXxA` — which is long, unbroken, not a URL, and mixes case
 * and digits, so every earlier rule passed it.
 */
/**
 * It was stored as the credential, and the real token four lines later was never
 * read: the recogniser stops at the first match. What separates them is
 * distribution — a secret has no character worth more than a few percent of it,
 * a mask is one character with a tail.
 */
const DOMINANT_MAX = 0.4;

const dominatedByOneCharacter = (line: string): boolean => {
  const seen = new Map<string, number>();
  for (const ch of line) seen.set(ch, (seen.get(ch) ?? 0) + 1);
  return Math.max(...seen.values()) > line.length * DOMINANT_MAX;
};

const looksLikeCredential = (line: string): boolean =>
  line.length >= TOKEN_MIN &&
  !/\s/.test(line) &&
  !/^[a-z][a-z0-9+.-]*:\/\//i.test(line) &&
  /[a-z]/.test(line) &&
  /[A-Z0-9]/.test(line) &&
  !dominatedByOneCharacter(line);

export interface LoginRun {
  /** The link to open. Present as soon as the CLI prints it. */
  url: string | null;
  /** The one-time code to type there. Device flow only; null for the rest. */
  code?: string | null;
  /** Resolves when the CLI exits: stored, or a reason it did not. */
  done: Promise<{ ok: boolean; detail: string }>;
  /** Give up and stop waiting for a browser that is not coming. */
  cancel: () => void;
}

type LineStream = ReturnType<typeof execLines>;

/**
 * `onLine` returning true ends the read, and that is not a convenience.
 *
 * `realLines` closes its queue when the SDK's `run()` promise settles. Measured
 * on a live server: `claude setup-token` had exited — no process left in the
 * container — and the stream never ended, so this sat on `stream.next()` forever
 * and `run.done` never resolved. The panel showed a link, the pasted code went
 * into a file whose reader was gone, and no event was ever emitted either way.
 */
/**
 * The line handlers see everything the stream has already produced, and stdout
 * is delivered as it arrives — so by the time a token has been printed, waiting
 * for the stream to end is waiting for nothing this cares about.
 */
async function consumeLogin(bus: Bus, stream: LineStream, onLine: (line: string) => boolean | void) {
  for (;;) {
    const step = await stream.next();
    if (step.done) return step.value;
    const plain = clean(step.value).trim();
    if (!plain) continue;
    bus.live({ grpId: null, agentId: null, role: "orchestrator", kind: "status", body: plain });
    // Zero rather than the stream's code: the CLI printed what it exists to
    // print, and the exit status of a process we stopped reading is not a
    // verdict on it.
    if (onLine(plain)) return { code: 0, err: "" };
  }
}

/**
 * `T5M2-76TFM`. Probed against codex-cli **0.147.0** in `orch/agent:1`.
 *
 * The shape is the CLI's to change, and if it does this breaks *silently* — the
 * login simply never completes — so a run that produces no code says exactly
 * that rather than waiting out its fifteen minutes. Re-probe on an image bump:
 * `codex login --device-auth` prints the URL and the code on two numbered lines.
 */
const DEVICE_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;

/** codex's own stated expiry. The panel's pending state should not outlive it. */
export const DEVICE_CODE_TTL_MS = 15 * 60_000;

/** One at a time: a second click would print a second code and invalidate the first. */
let deviceLogin: LoginRun | null = null;

/**
 * The run in flight, or null. Never starts one.
 *
 * `startCodexDeviceLogin` and `startClaudeLogin` are get-or-create, and the cancel
 * and code routes spelled them as "the current run". So a cancel with nothing to
 * cancel *launched* a login in the utility container, and an image holding a
 * session mints and stores a token for it — a cancel route that creates the thing
 * it cancels.
 */
/**
 * The suite is where it surfaced: `POST /login/cancel` after a finished login
 * started a second `claude setup-token`, whose `saveAuth` landed in the next
 * test's freshly emptied schema — a credential row seen by a test whose own login
 * had returned 422. Green on main for twenty runs, red the first time the runner
 * was slow enough to reorder the two.
 */
export const currentCodexDeviceLogin = () => deviceLogin;

async function finishCodexLogin(ctx: Ctx, run: LoginRun, session: PtySession) {
  // Codex reads to the end on purpose: its credential is a file it writes, not a
  // line it prints, so there is nothing on stdout that means "done".
  const result = await consumeLogin(ctx.bus, session.lines, (line) => {
    run.url ??= line.match(URL_RE)?.[0] ?? null;
    run.code ??= line.match(DEVICE_CODE_RE)?.[0] ?? null;
    return false;
  });
  if (result.code !== 0)
    return { ok: false, detail: `codex login exited ${result.code}: ${result.err.trim().slice(-300)}` };
  if (!run.code)
    return {
      ok: false,
      detail: "could not read a device code from codex's output — check `codex login --device-auth` in the image",
    };
  const secret = (await getFile(ctx, UTIL, `${REFRESH_HOME}/auth.json`)) ?? "";
  if (!secret.trim()) return { ok: false, detail: "codex login finished but produced no credential" };
  await saveAuth(ctx.db, { runtime: "codex", mode: "chatgpt", secret: secret.trim() });
  void ctx.sched.tick().catch(() => {});
  return { ok: true, detail: "stored" };
}

/**
 * Log in to a ChatGPT account from the utility container.
 *
 * `codex login` proper starts a listener on `http://localhost:1455` and registers
 * that exact redirect with the provider — probed — so no proxied endpoint can
 * satisfy it, and altering `redirect_uri` is forging a redirect. codex answers this
 * on the next line of its own output: `--device-auth`, which prints a URL and a
 * one-time code and polls.
 */
/**
 * Same shape the panel already runs for GitHub, and the real CLI still does the
 * whole exchange — so the objection that kept this on the host, our code
 * impersonating the official client, does not apply.
 *
 * In the **utility container**: this writes a real refresh token, and that is the
 * one credential no container with an agent in it may see.
 */
export function startCodexDeviceLogin(ctx: Ctx): LoginRun {
  if (deviceLogin) return deviceLogin;
  let opened: PtySession | null = null;
  const run: LoginRun = {
    url: null,
    code: null,
    /**
     * The same signal claude's cancel sends, and for the same reason.
     *
     * `codex login --device-auth` needs no terminal — it prints and polls — but
     * it was run through the command runner, whose cancel aborts an HTTP request
     * and leaves the process running until its server-side timeout: sixteen
     * minutes of a container polling an OAuth endpoint nobody is waiting on.
     * `run()` takes no session id, so `interrupt` cannot reach it; a pty session
     * has a control channel that can.
     */
    cancel: () => {
      opened?.signal("SIGINT");
      opened?.close();
      if (deviceLogin === run) deviceLogin = null;
    },
    done: Promise.resolve({ ok: false, detail: "" }),
  };
  deviceLogin = run;

  run.done = (async () => {
    const session = await (ctx.pty ?? openPty)(ctx, UTIL, `env CODEX_HOME=${REFRESH_HOME} codex login --device-auth`);
    opened = session;
    try {
      return await finishCodexLogin(ctx, run, session);
    } finally {
      session.close();
    }
  })().finally(() => {
    deviceLogin = null;
  });

  return run;
}

/** What the CLI is waiting for once the URL is out. Probed, and matched loosely. */
const PASTE_RE = /paste code/i;

/**
 * Sign in to a Claude account, from the utility container.
 *
 * The last thing that needed a binary on the boss's own machine. Here for the same
 * reason the ChatGPT refresh is: what it produces is a real long-lived credential,
 * and the utility container is the one with no agent, no mailbox and no `orch` in
 * it — which is the entire reason it may hold one.
 */
/**
 * `setup-token` mints a *separate* token rather than touching whatever session the
 * container happens to hold, so running it here disturbs nothing.
 *
 * Two halves, minutes apart, the same shape as the GitHub and codex flows: the URL
 * comes back from `start`, and `submit` carries the code the boss pastes — which is
 * what the CLI is sitting at a prompt waiting for.
 */
let claudeLogin: (LoginRun & { submit: (code: string) => Promise<void> }) | null = null;

/** The claude half of `currentCodexDeviceLogin`, and there for the same reason. */
export const currentClaudeLogin = () => claudeLogin;

/**
 * How long after the boss submits a code the CLI has to reach a verdict.
 *
 * It has one either way within a second or two — a token, or an OAuth error —
 * so `timeouts.loginVerdictMs` is generous. It exists because the *stream* may
 * not end when the CLI does: `realLines` closes its queue on the SDK's `run()`
 * promise, and measured on a live server that promise did not settle after
 * `claude setup-token` had exited. Without a deadline the read waits forever and
 * the panel is told nothing at all, which is worse than being told it failed.
 */
async function finishClaudeLogin(
  ctx: Ctx,
  run: LoginRun,
  session: PtySession,
  submitted: Promise<void>,
): Promise<{ ok: boolean; detail: string }> {
  const stream = session.lines;
  let token: string | null = null;
  let sawPrompt = false;
  // Raced with the deadline, not just awaited. The early stop above covers the
  // run that prints a token; this covers the one that prints an OAuth error and
  // exits, where there is no line to stop on and the stream stays open anyway.
  const read = consumeLogin(ctx.bus, stream, (line) => {
    run.url ??= line.match(URL_RE)?.[0] ?? null;
    if (looksLikeCredential(line)) token ??= line;
    // The token is the whole errand. Read no further for a stream that may not
    // end — see `consumeLogin`.
    if (token) return true;
    sawPrompt ||= PASTE_RE.test(line);
    return false;
  });
  const result = await Promise.race([
    read,
    submitted.then(async () => {
      await Bun.sleep(ctx.config.timeouts.loginVerdictMs);
      return { code: -1, err: "no verdict from claude setup-token after the code was submitted" };
    }),
  ]);
  if (!token && result.code !== 0)
    return { ok: false, detail: `claude setup-token exited ${result.code}: ${result.err.trim().slice(-300)}` };
  if (!token)
    return {
      ok: false,
      detail: sawPrompt
        ? "claude setup-token asked for the code and never printed a token — the code may have been wrong or expired"
        : "claude setup-token printed no token — run it under a pty in the image and see what changed",
    };
  await saveAuth(ctx.db, { runtime: "claude", mode: "oauth_token", secret: token });
  void ctx.sched.tick().catch(() => {});
  return { ok: true, detail: "stored" };
}

export function startClaudeLogin(ctx: Ctx): LoginRun & { submit: (code: string) => Promise<void> } {
  if (claudeLogin) return claudeLogin;
  let announceSubmit = () => {};
  const submitted = new Promise<void>((resolve) => {
    announceSubmit = resolve;
  });
  // Resolved once the terminal is open. `submit` and `cancel` are reachable from
  // the routes the moment this returns, and the boss cannot have pasted anything
  // yet — but a cancel arriving during the handshake must still land.
  let opened: PtySession | null = null;
  const run: LoginRun & { submit: (code: string) => Promise<void> } = {
    url: null,
    code: null,
    /**
     * A signal the container actually receives, and the slot back.
     *
     * Aborting an HTTP request left the command running and `done` pending, so
     * the slot stayed occupied by a dead run and every later login was handed
     * it. The daemon's control channel stops the process itself.
     */
    cancel: () => {
      opened?.signal("SIGINT");
      opened?.close();
      if (claudeLogin === run) claudeLogin = null;
    },
    /**
     * The code, then Enter, as two sends.
     *
     * The CLI turns on bracketed paste, so one write carrying text and a `\r`
     * together arrives as one paste and the `\r` inside it is content rather
     * than a keypress. Measured against claude-code 2.1.233: ninety-two
     * characters and a CR in one write submitted nothing.
     */
    submit: async (code) => {
      opened?.write(code.trim());
      await Bun.sleep(SUBMIT_KEY_GAP_MS);
      opened?.write("\r");
      // Starts the clock on a verdict. Before the code goes in there is nothing
      // to wait for — the boss is in a browser and the CLI is silent, which is
      // not a fault and must not be timed.
      announceSubmit();
    },
    done: Promise.resolve({ ok: false, detail: "" }),
  };
  claudeLogin = run;

  run.done = (async () => {
    const session = await (ctx.pty ?? openPty)(ctx, UTIL, "claude setup-token");
    opened = session;
    try {
      return await finishClaudeLogin(ctx, run, session, submitted);
    } finally {
      // Closed on every way out, including the successful one: the read stops at
      // the token and the CLI is still holding a terminal.
      session.close();
    }
  })().finally(() => {
    claudeLogin = null;
  });

  return run;
}

/**
 * How long the code sits in the terminal before Enter follows it.
 *
 * Two sends, not one, because the CLI turns on bracketed paste and a write
 * carrying both is a paste whose `\r` is content. The gap is what makes them two
 * arrivals rather than two writes the socket may coalesce.
 */
const SUBMIT_KEY_GAP_MS = 200;

/** The code on that page is short-lived; the panel's pending state should be too. */
export const PASTE_TTL_MS = 10 * 60_000;
