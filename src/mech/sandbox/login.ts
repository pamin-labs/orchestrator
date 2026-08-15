import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../../api.ts";
import { hostCodexHome, saveAuth, type AuthMode } from "./auth.ts";
import { REFRESH_HOME } from "./chatgpt.ts";
import { execLines, getFile, UTIL } from "./sandbox.ts";

/**
 * Logging in without leaving the panel.
 *
 * Both CLIs already do this properly — print a URL, wait for the browser, hand
 * back a credential — so the panel runs the CLI rather than reimplementing two
 * OAuth flows against undocumented client ids. The boss clicks a button, clicks
 * a link, and the token lands in the settings page by itself.
 *
 * On the host, deliberately: this is the boss's own login, and the machine with
 * the browser is this one. Nothing about it belongs in a sandbox.
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

const COMMANDS: Record<string, { argv: string[]; mode: AuthMode; capture: (out: string) => string | null }> = {
  // Prints the token on stdout at the end. Mints a separate long-lived token
  // rather than touching whatever this machine is already logged in as.
  claude: {
    argv: ["claude", "setup-token"],
    mode: "oauth_token",
    capture: (out) => out.match(CLAUDE_TOKEN_RE)?.[0] ?? null,
  },
  // Writes `$CODEX_HOME/auth.json` (default `~/.codex`) and prints nothing worth
  // keeping, so the credential is read from where it landed. This does log this
  // machine in, which is what `codex login` is for.
  codex: {
    argv: ["codex", "login"],
    mode: "chatgpt",
    capture: () => null,
  },
};

export function loginRuntimes(): string[] {
  return Object.keys(COMMANDS);
}

/**
 * Start a login and stream it to the panel.
 *
 * The URL is the whole point of streaming: the CLI blocks until the browser
 * comes back, so without showing the link the button would look like it hung.
 */
export function startLogin(ctx: Ctx, runtime: string, home = homedir()): LoginRun | null {
  const spec = COMMANDS[runtime];
  if (!spec) return null;

  const proc = Bun.spawn(spec.argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const run: LoginRun = {
    url: null,
    cancel: () => proc.kill("SIGTERM"),
    done: Promise.resolve({ ok: false, detail: "" }),
  };

  const say = (body: string) =>
    ctx.bus.live({ grpId: null, agentId: null, role: "orchestrator", kind: "status", body });

  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const dec = new TextDecoder();
    let all = "";
    let buf = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      const text = dec.decode(chunk, { stream: true });
      all += text;
      buf += text;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const plain = clean(line);
        if (plain.trim()) say(plain.trim());
        if (!run.url) run.url = plain.match(URL_RE)?.[0] ?? null;
      }
    }
    const tail = clean(buf).trim();
    if (tail) {
      say(tail);
      if (!run.url) run.url = tail.match(URL_RE)?.[0] ?? null;
    }
    return all;
  };

  run.done = (async () => {
    const [out, err] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
    const code = await proc.exited;
    if (code !== 0) {
      return { ok: false, detail: `${spec.argv[0]} exited ${code}: ${(err || out).trim().slice(-300)}` };
    }
    const secret =
      spec.capture(clean(`${out}\n${err}`)) ??
      // `$CODEX_HOME` if the boss has one. Hardcoding `~/.codex` meant the login
      // succeeded, wrote somewhere else, and this read nothing — surfacing as
      // "finished but produced no credential", which reads like the CLI failed.
      (runtime === "codex" ? await Bun.file(join(hostCodexHome(home), "auth.json")).text().catch(() => "") : "");
    if (!secret.trim()) {
      return { ok: false, detail: `${spec.argv[0]} finished but produced no credential` };
    }
    saveAuth(ctx.db, { runtime, mode: spec.mode, secret: secret.trim() });
    ctx.sched.tick(); // whatever was held for a missing credential can go now
    return { ok: true, detail: "stored" };
  })();

  return run;
}
