import type { Bus } from "../../platform/persistence/event-bus.ts";
import type { Ctx } from "../../mech/ctx.ts";
import { saveAuth } from "./auth.ts";
import { REFRESH_HOME } from "./chatgpt.ts";
import { execIn, execLines, getFile, putFile, UTIL } from "./sandbox.ts";
import { shq } from "../../platform/process/shell.ts";

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
const CLAUDE_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;

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

async function consumeLogin(bus: Bus, stream: LineStream, onLine: (line: string) => void) {
  for (;;) {
    const step = await stream.next();
    if (step.done) return step.value;
    const plain = clean(step.value).trim();
    if (!plain) continue;
    bus.live({ grpId: null, agentId: null, role: "orchestrator", kind: "status", body: plain });
    onLine(plain);
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

async function finishCodexLogin(ctx: Ctx, run: LoginRun, signal: AbortSignal) {
  const stream = execLines(ctx, UTIL, "codex login --device-auth", {
    env: { CODEX_HOME: REFRESH_HOME },
    timeoutMs: DEVICE_CODE_TTL_MS + 60_000,
    signal,
  });
  const result = await consumeLogin(ctx.bus, stream, (line) => {
    run.url ??= line.match(URL_RE)?.[0] ?? null;
    run.code ??= line.match(DEVICE_CODE_RE)?.[0] ?? null;
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
  const abort = new AbortController();
  const run: LoginRun = {
    url: null,
    code: null,
    cancel: () => abort.abort(),
    done: Promise.resolve({ ok: false, detail: "" }),
  };
  deviceLogin = run;

  run.done = finishCodexLogin(ctx, run, abort.signal).finally(() => {
    deviceLogin = null;
  });

  return run;
}

/**
 * A terminal, so a terminal program will talk.
 *
 * `claude setup-token` is a TUI. Without one it produces no link at all — it
 * printed nothing and exited 0 against the version this was written for, and
 * against 2.1.233 it simply hangs. Either way the panel had a login button that
 * stored nothing.
 */
/**
 * Two details are load-bearing. **The window size is set explicitly** — a parentless
 * pty defaults to 80 columns and the CLI wraps its URL across five lines mid-token,
 * and the link handed to the boss has to be one string; this is also why `script
 * -qec`, in the image and tried first, does not work. **Stdin is a file this process
 * appends to**, because the sandbox SDK has no channel into a running command.
 *
 * This runs the real CLI and nothing else. A pty is a terminal; that is all that is
 * supplied.
 */
/**
 * `-P` is the fix; the name is the belt beside it.
 *
 * Python puts the script's own directory at `sys.path[0]`, so this runner's own
 * first line `import pty` resolves there before the standard library. Installed
 * as `pty.py` it imported *itself*: `pty.fork` did not exist, and the traceback
 * went to a stream the login only reads for a URL — so every attempt was
 * reported as "the CLI needs a pty", which it does, and which this was giving it.
 */
/**
 * Renaming was not enough, and the container is why. `/opt/orch` outlives the
 * server that wrote into it, so the old `pty.py` and its `__pycache__` were
 * still lying beside the renamed file and `import pty` found them instead.
 * Measured in the live utility container: `python3 login-pty.py` still died at
 * `File "/opt/orch/pty.py", line 4`, and `python3 -P login-pty.py` reached the
 * CLI.
 */
/**
 * `-P` drops `sys.path[0]` entirely, so the answer no longer depends on what is
 * in the directory — which is the only version of this that a leftover file
 * cannot undo. The hyphenated name stays because it is free and it closes the
 * self-import case on its own; `-P` is the one carrying the guarantee.
 */
export const PTY_PATH = "/opt/orch/login-pty.py";

/**
 * The interpreter flags the runner is launched with, exported so the guard runs
 * it the way production does rather than asserting on a string.
 */
export const PYTHON_FLAGS = ["-P"] as const;
export const PTY_RUNNER = `import fcntl, os, pty, select, struct, sys, termios
cmd = sys.argv[1:]
inbox = os.environ.get("ORCH_PTY_IN", "")
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 200, 400, 0, 0))
src = open(inbox, "rb") if inbox else None
if src:
    src.seek(0, 2)
out = sys.stdout.buffer
while True:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out.write(data)
        out.flush()
    if src:
        line = src.readline()
        if line:
            os.write(fd, line if line.endswith(b"\\n") else line + b"\\n")
    if os.waitpid(pid, os.WNOHANG)[0]:
        try:
            while True:
                d = os.read(fd, 65536)
                if not d:
                    break
                out.write(d)
                out.flush()
        except OSError:
            pass
        break
`;

/** Where the boss's pasted code is appended for the pty's stdin to pick up. */
const CODE_FILE = "/tmp/orch-login-code";

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

async function finishClaudeLogin(ctx: Ctx, run: LoginRun, signal: AbortSignal) {
  await putFile(ctx, UTIL, PTY_PATH, PTY_RUNNER);
  await execIn(ctx, UTIL, `: > ${CODE_FILE}`);
  const argv = `python3 ${PYTHON_FLAGS.join(" ")} ${PTY_PATH}`;
  const stream = execLines(ctx, UTIL, `ORCH_PTY_IN=${CODE_FILE} ${argv} claude setup-token`, {
    timeoutMs: PASTE_TTL_MS + 60_000,
    signal,
  });
  let token: string | null = null;
  let sawPrompt = false;
  const result = await consumeLogin(ctx.bus, stream, (line) => {
    run.url ??= line.match(URL_RE)?.[0] ?? null;
    token ??= line.match(CLAUDE_TOKEN_RE)?.[0] ?? null;
    sawPrompt ||= PASTE_RE.test(line);
  });
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
  const abort = new AbortController();
  const run: LoginRun & { submit: (code: string) => Promise<void> } = {
    url: null,
    code: null,
    cancel: () => abort.abort(),
    // Appended, not overwritten: the runner holds the file open and reads from
    // where it left off, so a second paste after a typo is a second line rather
    // than a rewrite it will never see.
    submit: async (code) => {
      await execIn(ctx, UTIL, `printf '%s\\n' ${shq(code.trim())} >> ${CODE_FILE}`);
    },
    done: Promise.resolve({ ok: false, detail: "" }),
  };
  claudeLogin = run;

  run.done = finishClaudeLogin(ctx, run, abort.signal).finally(() => {
    claudeLogin = null;
  });

  return run;
}

/** The code on that page is short-lived; the panel's pending state should be too. */
export const PASTE_TTL_MS = 10 * 60_000;
