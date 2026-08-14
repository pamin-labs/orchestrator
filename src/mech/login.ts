import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../api.ts";
import { saveAuth, type AuthMode } from "./auth.ts";

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
  /** Resolves when the CLI exits: stored, or a reason it did not. */
  done: Promise<{ ok: boolean; detail: string }>;
  /** Give up and stop waiting for a browser that is not coming. */
  cancel: () => void;
}

const COMMANDS: Record<string, { argv: string[]; mode: AuthMode; capture: (out: string) => string | null }> = {
  // Prints the token on stdout at the end. Mints a separate long-lived token
  // rather than touching whatever this machine is already logged in as.
  claude: {
    argv: ["claude", "setup-token"],
    mode: "oauth_token",
    capture: (out) => out.match(CLAUDE_TOKEN_RE)?.[0] ?? null,
  },
  // Writes ~/.codex/auth.json and prints nothing worth keeping, so the
  // credential is read from where it landed. This does log this machine in,
  // which is what `codex login` is for.
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
      (runtime === "codex" ? await Bun.file(join(home, ".codex/auth.json")).text().catch(() => "") : "");
    if (!secret.trim()) {
      return { ok: false, detail: `${spec.argv[0]} finished but produced no credential` };
    }
    saveAuth(ctx.db, { runtime, mode: spec.mode, secret: secret.trim() });
    ctx.sched.tick(); // whatever was held for a missing credential can go now
    return { ok: true, detail: "stored" };
  })();

  return run;
}
