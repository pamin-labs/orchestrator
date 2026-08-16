import type { Ctx } from "../../ctx.ts";
import { saveAuth } from "./auth.ts";
import { REFRESH_HOME } from "./chatgpt.ts";
import { execIn, execLines, getFile, putFile, UTIL } from "./sandbox.ts";
import { shq } from "../util/shq.ts";

/**
 * Logging in without leaving the panel.
 *
 * Both CLIs already do this properly — print a URL, wait for the browser, hand
 * back a credential — so the panel runs the CLI rather than reimplementing two
 * OAuth flows against undocumented client ids. The boss clicks a button, clicks
 * a link, and the token lands in the settings page by itself.
 *
 * In the **utility container**, all of it. Both flows produce a real long-lived
 * credential, and that container is the one with no agent, no mailbox and no
 * `orch` in it — which is the entire reason it is allowed to hold one. The host
 * runs the server and nothing else; the browser is still the boss's.
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
 * Log in to a ChatGPT account from the utility container.
 *
 * `codex login` proper starts a listener on `http://localhost:1455` and registers
 * that exact redirect with the provider — probed — so no proxied endpoint can
 * ever satisfy it, and altering `redirect_uri` is forging a redirect. codex
 * answers this itself on the next line of its own output: `--device-auth`, which
 * prints a URL and a one-time code and polls. Same shape the panel already runs
 * for GitHub, and the real CLI still does the whole exchange — so the objection
 * that kept this on the host, our code impersonating the official client, does
 * not apply.
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

  run.done = (async () => {
    try {
      const stream = execLines(ctx, UTIL, "codex login --device-auth", {
        env: { CODEX_HOME: REFRESH_HOME },
        timeoutMs: DEVICE_CODE_TTL_MS + 60_000,
        signal: abort.signal,
      });
      for (;;) {
        const step = await stream.next();
        if (step.done) {
          if (step.value.code !== 0) {
            return { ok: false, detail: `codex login exited ${step.value.code}: ${step.value.err.trim().slice(-300)}` };
          }
          break;
        }
        const plain = clean(step.value).trim();
        if (!plain) continue;
        ctx.bus.live({ grpId: null, agentId: null, role: "orchestrator", kind: "status", body: plain });
        run.url ??= plain.match(URL_RE)?.[0] ?? null;
        run.code ??= plain.match(DEVICE_CODE_RE)?.[0] ?? null;
      }
      if (!run.code) {
        // Said rather than waited out: this is what a changed CLI looks like.
        return { ok: false, detail: "could not read a device code from codex's output — check `codex login --device-auth` in the image" };
      }
      const secret = (await getFile(ctx, UTIL, `${REFRESH_HOME}/auth.json`)) ?? "";
      if (!secret.trim()) return { ok: false, detail: "codex login finished but produced no credential" };
      saveAuth(ctx.db, { runtime: "codex", mode: "chatgpt", secret: secret.trim() });
      ctx.sched.tick(); // whatever was held for a missing credential can go now
      return { ok: true, detail: "stored" };
    } finally {
      deviceLogin = null;
    }
  })();

  return run;
}

/**
 * A terminal, so a terminal program will talk.
 *
 * `claude setup-token` is a TUI. Run without one it prints **nothing** and exits
 * 0 — measured, twice, in `orch/agent:1`:
 *
 *   claude setup-token < /dev/null   ->  (no output)   [exited with code 0]
 *
 * which is the worst possible shape: the panel had a "log in" button that
 * succeeded instantly and stored nothing, and the only way to tell was that no
 * credential appeared. Under a pty the same command prints its URL and then
 * waits at `Paste code here if prompted >`.
 *
 * Two details are not incidental. **The window size** is set explicitly, because
 * a pty with no parent defaults to 80 columns and the CLI wraps its URL across
 * five lines mid-token — the link the boss is handed has to be one string.
 * **Stdin** comes from a file this process appends to, because the sandbox SDK
 * has no channel into a running command: `select` on the master fd plus
 * `readline` on a file we `putFile` into is the whole mechanism by which the
 * pasted code gets in.
 *
 * `script -qec` is in the image and does the pty part, and it was the first
 * thing tried; it ignores `COLUMNS`, so the URL still arrived wrapped.
 *
 * **This runs the real CLI and nothing else.** No client id of ours, no URL we
 * built, no call to a token endpoint — `claude setup-token` performs the entire
 * OAuth exchange itself, exactly as it does in a terminal. A pty is a terminal;
 * that is the only thing being supplied.
 */
const PTY_PATH = "/opt/orch/pty.py";
const PTY_RUNNER = `import fcntl, os, pty, select, struct, sys, termios
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
 * The last thing that needed a binary on the boss's own machine. It is here for
 * the same reason the ChatGPT refresh is: what it produces is a real long-lived
 * credential, and the utility container is the one with no agent, no mailbox and
 * no `orch` in it — which is the entire reason it may hold one.
 *
 * `setup-token` mints a *separate* token rather than touching whatever session
 * the container happens to hold, so running it here does not disturb anything.
 *
 * Two halves, minutes apart, same shape as the GitHub and codex flows: the URL
 * comes back from `start`, and `submit` carries the code the boss pastes from
 * the page — which is what the CLI is sitting at a prompt waiting for.
 */
let claudeLogin: (LoginRun & { submit: (code: string) => Promise<void> }) | null = null;

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

  run.done = (async () => {
    try {
      await putFile(ctx, UTIL, PTY_PATH, PTY_RUNNER);
      // The runner opens this before the CLI starts. Truncated, so a code from
      // an abandoned attempt is not fed to this one.
      await execIn(ctx, UTIL, `: > ${CODE_FILE}`);
      const stream = execLines(
        ctx,
        UTIL,
        `ORCH_PTY_IN=${CODE_FILE} python3 ${PTY_PATH} claude setup-token`,
        { timeoutMs: PASTE_TTL_MS + 60_000, signal: abort.signal },
      );
      let token: string | null = null;
      let sawPrompt = false;
      for (;;) {
        const step = await stream.next();
        if (step.done) {
          if (!token && step.value.code !== 0) {
            return {
              ok: false,
              detail: `claude setup-token exited ${step.value.code}: ${step.value.err.trim().slice(-300)}`,
            };
          }
          break;
        }
        const plain = clean(step.value).trim();
        if (!plain) continue;
        ctx.bus.live({ grpId: null, agentId: null, role: "orchestrator", kind: "status", body: plain });
        run.url ??= plain.match(URL_RE)?.[0] ?? null;
        token ??= plain.match(CLAUDE_TOKEN_RE)?.[0] ?? null;
        sawPrompt ||= PASTE_RE.test(plain);
      }
      if (!token) {
        // Said, not waited out. A CLI that stopped printing its URL and a CLI
        // that stopped accepting a pasted code fail identically from here, and
        // both are silent — which is what this whole function exists to stop.
        return {
          ok: false,
          detail: sawPrompt
            ? "claude setup-token asked for the code and never printed a token — the code may have been wrong or expired"
            : "claude setup-token printed no token — run it under a pty in the image and see what changed",
        };
      }
      saveAuth(ctx.db, { runtime: "claude", mode: "oauth_token", secret: token });
      ctx.sched.tick(); // whatever was held for a missing credential can go now
      return { ok: true, detail: "stored" };
    } finally {
      claudeLogin = null;
    }
  })();

  return run;
}

/** The code on that page is short-lived; the panel's pending state should be too. */
export const PASTE_TTL_MS = 10 * 60_000;
