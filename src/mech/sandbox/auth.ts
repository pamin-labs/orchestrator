import { homedir } from "node:os";
import { join } from "node:path";
import type { DB } from "../../db.ts";
import type { Credential } from "./sandbox.ts";
import { accessToken, decoyAuth, isStale, parseAuth, renew, seedHome, type CodexHomeIO } from "./chatgpt.ts";
import { forgetHolds } from "../git/github.ts";
import { maskValue } from "../util/scrub.ts";

/**
 * Where each runtime's credential comes from, and how it reaches the model.
 *
 * Never into the sandbox. The value is written to the egress sidecar's vault and
 * injected into outbound requests on the way past; the sandbox's environment
 * holds a format-plausible fake. Measured (docs/decisions/005): the sidecar
 * REPLACES an `Authorization` header the CLI already set, and `claude` does not
 * validate its token locally — a synthetic one comes back as a server-side 401 —
 * which together are what make this work at all.
 */

/**
 * `chatgpt` is the odd one, and deliberately so.
 *
 * codex has exactly two non-interactive credential paths: an API key, or an
 * `auth.json` in `$CODEX_HOME`. A ChatGPT-account login is the second — a pair
 * of access and refresh tokens that codex itself rotates and rewrites — so it
 * cannot go in the vault: what you would bind is one access token that expires
 * in hours with nothing to renew it. claude's `setup-token` works precisely
 * because it hands over a year-long token instead.
 *
 * So a ChatGPT subscription is stored whole, refreshed here on the host, and
 * reaches the model as an injected header like everything else — the sandbox
 * gets a decoy file. Its own mode because what is stored is a login rather than
 * a key, and because only this one can go stale on its own.
 */
export type AuthMode = "oauth_token" | "api_key" | "chatgpt";

export interface RuntimeAuth {
  runtime: string;
  mode: AuthMode;
  secret: string;
  baseUrl?: string;
}

/** Hosts each runtime talks to, and the header its credential belongs in. */
const BINDINGS: Record<string, { hosts: string[]; header?: string }> = {
  // An OAuth token travels as `Authorization: Bearer`; an API key as `x-api-key`.
  claude: { hosts: ["api.anthropic.com"] },
  codex: { hosts: ["api.openai.com", "chatgpt.com"] },
  // Read-only in a group container, and that is enforced by `readOnlyGitPaths`
  // rather than by the scope of the token — see it for why the host list alone
  // was never enough. Bound here so a private repository can be cloned over
  // HTTPS without the token being inside the container.
  github: { hosts: ["github.com", "api.github.com"] },
};

/**
 * The two request paths a clone and a fetch use, and no third.
 *
 * This is the whole of "a group container cannot write to the remote", so it is
 * worth stating exactly what it does and does not stop. Git's smart HTTP is four
 * requests:
 *
 *   fetch   GET  /owner/repo.git/info/refs?service=git-upload-pack
 *           POST /owner/repo.git/git-upload-pack
 *   push    GET  /owner/repo.git/info/refs?service=git-receive-pack
 *           POST /owner/repo.git/git-receive-pack
 *
 * The two discovery requests differ only in the query string, and the sidecar
 * cuts the query off before matching — so no rule can tell them apart, and a
 * push's discovery *is* credentialed. What it cannot do is the second half: the
 * `git-receive-pack` POST carries the packfile, matches nothing, goes out with
 * the decoy, and GitHub answers 401. So the guarantee is **no write ever
 * completes**, not "the token is never presented on a write path". The
 * difference is worth one paragraph because it is the reason the utility
 * container exists at all rather than every group simply pushing.
 *
 * Exact strings, never `/owner/repo.git*`: a trailing `*` is a prefix match that
 * does not stop at `/`, so the shape the upstream guide suggests would readmit
 * `git-receive-pack`.
 *
 * Known gap, stated rather than papered over: Git LFS lives under
 * `/owner/repo.git/info/lfs/…` and is not in this list, so a private repository
 * using LFS will fail to fetch its objects inside a group. Adding it would also
 * admit LFS *uploads*, which share the path — so it waits for a repository that
 * needs it.
 */
export function readOnlyGitPaths(remote: string): string[] | null {
  const m = /github\.com[:/]+(.+?)(\.git)?\/?$/i.exec(remote.trim());
  if (!m) return null;
  const base = `/${m[1]}${m[2] ?? ""}`;
  return [`${base}/info/refs`, `${base}/git-upload-pack`];
}

/** A value the CLI will accept as well-formed and the API will reject. */
export function decoy(runtime: string, mode: AuthMode): string {
  if (runtime === "claude") return mode === "oauth_token" ? `sk-ant-oat01-${"A".repeat(80)}` : `sk-ant-api03-${"A".repeat(80)}`;
  return `sk-${"A".repeat(48)}`;
}

/**
 * Is this the shape the provider will accept?
 *
 * Checked here because the alternative is finding out hours later, in a
 * container, as a 401 that reads like an expired subscription. A login URL
 * pasted into the token box is the one that actually happened: it saved, it
 * looked configured, and every turn after it failed.
 *
 * Prefixes only. Length and character set drift; the prefix is what each
 * provider stamps on the thing so it can be told apart from everything else.
 */
export function wrongShape(runtime: string, mode: AuthMode, secret: string): string | null {
  const v = secret.trim();
  if (!v) return "空的";
  if (/^https?:\/\//.test(v)) return "这是个网址，不是凭据 —— 登录页的地址不是 token";
  if (mode === "chatgpt") {
    try {
      const parsed = JSON.parse(v) as { tokens?: { refresh_token?: string } };
      if (!parsed?.tokens?.refresh_token) return "auth.json 里没有 tokens.refresh_token，续不了期";
      return null;
    } catch {
      return "要的是 ~/.codex/auth.json 的完整内容，那是一段 JSON";
    }
  }
  if (runtime === "claude") {
    if (mode === "oauth_token" && !v.startsWith("sk-ant-oat01-")) return "订阅 token 是 sk-ant-oat01- 开头的";
    if (mode === "api_key" && !v.startsWith("sk-ant-")) return "Anthropic 的 API key 是 sk-ant- 开头的";
  }
  if (runtime === "codex" && mode === "api_key" && !v.startsWith("sk-")) return "OpenAI 的 API key 是 sk- 开头的";
  return null;
}

export function saveAuth(db: DB, a: RuntimeAuth): void {
  // Registered the moment it is stored, so the masker knows this value before
  // anything has a chance to print it. Same order as `::add-mask::`.
  maskValue(a.secret);
  // Nothing learned from the old credential still applies. Without this a boss who
  // reconnects GitHub watches nothing happen until the hold's clock lapses, which
  // reads as the fix not having worked.
  forgetHolds(a.runtime);
  db.run(
    `INSERT INTO runtime_auth (runtime, mode, secret, base_url, updated_at)
     VALUES (?, ?, ?, ?, unixepoch() * 1000)
     ON CONFLICT(runtime) DO UPDATE SET mode = excluded.mode, secret = excluded.secret,
       base_url = excluded.base_url, updated_at = excluded.updated_at`,
    [a.runtime, a.mode, a.secret, a.baseUrl ?? null],
  );
}

/**
 * Does this runtime have a subscription window worth reading?
 *
 * Two conditions, and the second is the one that is easy to miss. A per-token key
 * has no window to run out of. And the usage endpoint is the provider's own
 * (subusage.ts), so once a self-hosted gateway is configured the quota it reports
 * belongs to a different account than the one the fleet is spending — a number
 * about somebody else's subscription, rendered as if it were the constraint on
 * what to start next.
 *
 * No row at all is also false: nothing can run without a configured credential,
 * so a bar sourced from whatever this host happens to be logged into would be
 * about an account the fleet never touches.
 */
export function subscriptionAccount(db: DB, runtime: string): boolean {
  const a = loadAuth(db, runtime);
  if (!a || a.mode === "api_key") return false;
  if (!a.baseUrl) return true;
  try {
    return BINDINGS[runtime]?.hosts.includes(new URL(a.baseUrl).hostname) ?? false;
  } catch {
    return false;
  }
}

/**
 * Where a CLI keeps its own state *on this host*.
 *
 * Both tools let you move it — codex reads `$CODEX_HOME`, Claude Code reads
 * `$CLAUDE_CONFIG_DIR` — and hardcoding `~/.codex` / `~/.claude` fails silently
 * for anyone who has: `codex login` succeeds and the credential is read from a
 * directory it did not write, so the panel says "finished but produced no
 * credential"; every ticked skill stages zero files and the mount is empty.
 * Honour the variable the CLI honours, then fall back to the conventional path.
 *
 * `homedir()` handles the platform difference; the env vars handle the
 * install-somewhere-else one. Note these are the *host* paths — `CODEX_HOME`
 * above is the path inside the container, which is ours to fix and never varies.
 */
export const hostCodexHome = (home = homedir()): string => process.env.CODEX_HOME || join(home, ".codex");
export const hostClaudeHome = (home = homedir()): string =>
  process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");

/**
 * The hosts a turn has to be able to reach, for the configured credentials.
 *
 * Derived rather than configured: these are exactly the hosts the vault binds,
 * so a self-hosted gateway moves the probe with it and nobody has to keep a
 * second list in step. Only credentials that exist count — probing a provider
 * nobody configured would report the machine offline for a wall it will never
 * hit.
 */
export function probeHosts(db: DB): string[] {
  const out = new Set<string>();
  for (const a of db
    .query<{ runtime: string; base_url: string | null }, []>("SELECT runtime, base_url FROM runtime_auth")
    .all()) {
    if (a.base_url) {
      try {
        out.add(new URL(a.base_url).hostname);
        continue;
      } catch {}
    }
    for (const h of BINDINGS[a.runtime]?.hosts ?? []) out.add(h);
  }
  // github is bound for cloning, not for running a turn, and a repo host being
  // unreachable is not a reason to stop every agent.
  for (const h of BINDINGS.github!.hosts) out.delete(h);
  return [...out];
}

export function loadAuth(db: DB, runtime: string): RuntimeAuth | null {
  const r = db
    .query<{ runtime: string; mode: string; secret: string; base_url: string | null }, [string]>(
      "SELECT runtime, mode, secret, base_url FROM runtime_auth WHERE runtime = ?",
    )
    .get(runtime);
  return r ? { runtime: r.runtime, mode: r.mode as AuthMode, secret: r.secret, baseUrl: r.base_url ?? undefined } : null;
}

/**
 * What the settings page is allowed to see.
 *
 * Never the secret. A masked tail is enough to tell two tokens apart, which is
 * the only question a human asks of one they already pasted.
 */
export function listAuth(db: DB): Array<{ runtime: string; mode: AuthMode; hint: string; baseUrl?: string; updatedAt: number }> {
  return db
    .query<{ runtime: string; mode: string; secret: string; base_url: string | null; updated_at: number }, []>(
      "SELECT runtime, mode, secret, base_url, updated_at FROM runtime_auth ORDER BY runtime",
    )
    .all()
    .map((r) => ({
      runtime: r.runtime,
      mode: r.mode as AuthMode,
      // A token's tail identifies it. A pasted auth.json's tail is `11Z" }`,
      // which identifies nothing — for that one the account it logged in as is
      // the only thing worth showing.
      hint: r.mode === "chatgpt" ? chatgptHint(r.secret) : `…${r.secret.slice(-6)}`,
      baseUrl: r.base_url ?? undefined,
      updatedAt: r.updated_at,
    }));
}

/**
 * The sandbox server's own key, stored beside the model credentials.
 *
 * Not a model credential — it never reaches a sidecar and is never injected —
 * but it is a secret the boss has to set, and it has exactly one good home:
 * the store that already keeps secrets out of the committed yaml. Absent from
 * `BINDINGS`, so nothing tries to bind it.
 */
export const SANDBOX_KEY = "sandbox";

/** Where codex looks for its login inside a sandbox. */
export const CODEX_HOME = "/root/.codex";

/**
 * Files a sandbox needs because the CLI reads a file and nothing else.
 *
 * codex is the only one, and what it gets is a decoy: enough to start and
 * believe it is logged in, while the sidecar swaps in the real access token on
 * the way out. The alternative — the real auth.json in every sandbox — is what
 * codex's own CI guidance warns against, because each copy refreshes and they
 * invalidate each other.
 */
export function filesFor(db: DB): Record<string, string> {
  const files: Record<string, string> = { ...gitFilesFor(db) };
  const a = loadAuth(db, "codex");
  if (a?.mode !== "chatgpt") return files;
  const parsed = parseAuth(a.secret);
  if (!parsed) return files;
  files[`${CODEX_HOME}/auth.json`] = decoyAuth(parsed);
  // Without this codex looks for the login in the OS keychain instead.
  files[`${CODEX_HOME}/config.toml`] = 'cli_auth_credentials_store = "file"\n';
  return files;
}

/** The username half of git's Basic auth. GitHub ignores it; the token is the password. */
const GIT_USER = "x-access-token";

/**
 * Give git something to send, so the sidecar has something to replace.
 *
 * This is the half that was described and never built. `git clone` over HTTPS
 * does **not** send `Authorization` up front: it asks anonymously, takes the
 * 401, and only then looks for a credential helper. With `GIT_TERMINAL_PROMPT=0`
 * and no helper in the container it stopped at `could not read Username`, and no
 * token anywhere could have changed that — the vault *replaces* a header the
 * client already set (005), and git had set none.
 *
 * So the container gets a stored credential whose password is a decoy, exactly
 * like codex's `auth.json`. git reads it, sends `Authorization: Basic
 * base64(x-access-token:decoy)`, and the sidecar swaps in the real one on the
 * way out. Nothing real is ever inside.
 *
 * Only when a GitHub credential is configured. A public repository clones
 * anonymously today, and handing git a credential it will fail with would turn
 * that into a 401 — breaking the case that currently works.
 */
function gitFilesFor(db: DB): Record<string, string> {
  if (!loadAuth(db, "github")) return {};
  return {
    "/root/.git-credentials": BINDINGS.github!.hosts.map((h) => `https://${GIT_USER}:${decoy("github", "api_key")}@${h}\n`).join(""),
    // `store` is what makes git read the file above without asking anyone.
    // Written here rather than with `git config --global` because the checkout
    // sets its identity with a repo-local `git config`, so nothing else owns
    // this file.
    "/root/.gitconfig": "[credential]\n\thelper = store\n",
  };
}

/**
 * Refresh the stored ChatGPT login if it is getting old, and hand back the
 * access token the sidecar should inject.
 *
 * One refresher, on the host, because there is one login: ten sandboxes each
 * refreshing their own copy is precisely the thing codex's CI guidance says not
 * to do. The renewal is done by codex itself rather than by us — see chatgpt.ts
 * for why that distinction is worth a few hundred tokens a week. A failed one
 * keeps what we had, and shows up later as the 401 that pauses the group.
 */
/**
 * Re-entrancy guard, and the reason it has to exist.
 *
 * The refresh runs `codex` inside the **utility container**, and getting that
 * container means `openSandbox`, which calls `vaultBindings`, which calls this —
 * so the first stale refresh would recurse into itself forever, building a
 * container in order to build a container. Nothing else in the loop notices,
 * because each step is doing something reasonable.
 *
 * While a refresh is in flight, every other caller gets the token we already
 * have. It is minutes from expiry at worst, and the alternative is a deadlock at
 * the exact moment the fleet needs a credential.
 */
let refreshing = false;

export async function currentChatgptToken(
  db: DB,
  io: CodexHomeIO | null,
  now = Date.now(),
): Promise<string | null> {
  const a = loadAuth(db, "codex");
  if (a?.mode !== "chatgpt") return null;
  let parsed = parseAuth(a.secret);
  if (!parsed) return null;
  if (io && !refreshing && isStale(parsed, now)) {
    refreshing = true;
    try {
      await seedHome(io, a.secret);
      const next = await renew(io);
      if (next) {
        // One writer. The container is where the refresh *happens*; this row is
        // where the login lives, and it is the only copy anything reads. The
        // container's `auth.json` is scratch — a rebuilt one is reseeded from
        // here — so the two-writers-one-token case codex warns about cannot
        // arise: nothing else ever refreshes it.
        saveAuth(db, { ...a, secret: JSON.stringify(next) });
        parsed = next;
      }
    } finally {
      refreshing = false;
    }
  }
  return accessToken(parsed);
}

/**
 * There is no write-back from the sandbox, deliberately.
 *
 * `absorbCodexHome` used to read `$CODEX_HOME/auth.json` out of the container
 * after every codex turn and store whatever it found, on the theory that codex
 * rotates its own tokens. Since 005 that file is a decoy *we* wrote (`filesFor`
 * below), and `decoyAuth` stamps `last_refresh` with now for the express purpose
 * of stopping codex from refreshing it. So the only thing the read-back could
 * ever find was our own fake — and it stored it, replacing the real refresh
 * token, which nothing else holds. Every sandbox then got `decoy-aaa…` injected
 * and the whole fleet 401'd, presenting as an expired account.
 *
 * One login, one refresher, on the host (`currentChatgptToken` below). A second
 * writer for the same row is what this comment exists to prevent someone adding
 * back.
 */

/**
 * Everything the sidecar should inject, including the refreshed ChatGPT token.
 *
 * Async because that one may have to be renewed first, and renewing it is a
 * network call. Every other credential is a stored string.
 */
export async function vaultBindings(
  db: DB,
  io: CodexHomeIO | null,
  opts: VaultOpts = {},
): Promise<{ credentials: Credential[]; env: Record<string, string> }> {
  const base = vaultFor(db, opts);
  const token = await currentChatgptToken(db, io);
  if (!token) return base;
  const a = loadAuth(db, "codex")!;
  return {
    // A ChatGPT login can still be pointed at a gateway — someone running their
    // own front end has one login and a different address for it.
    env: { ...base.env, ...(a.baseUrl ? { OPENAI_BASE_URL: a.baseUrl } : {}) },
    credentials: [
      ...base.credentials,
      {
        name: "codex",
        value: token,
        hosts: a.baseUrl ? [...BINDINGS.codex!.hosts, new URL(a.baseUrl).hostname] : BINDINGS.codex!.hosts,
      },
    ],
  };
}

function chatgptHint(secret: string): string {
  const a = parseAuth(secret);
  const id = a?.tokens?.account_id;
  return id ? `账号 …${id.slice(-6)}` : "auth.json";
}

export interface VaultOpts {
  /**
   * The one repository this container may read, as its remote URL.
   *
   * Given, the GitHub credential is bound to that repository's fetch paths and
   * nothing else. Absent (the utility container, and every caller that only
   * wants the environment) it keeps the whole token — which is right there and
   * wrong in a container that runs an agent.
   */
  repo?: string | null;
}

/** Real credentials for the vault, and the fakes that go in the environment. */
export function vaultFor(db: DB, opts: VaultOpts = {}): { credentials: Credential[]; env: Record<string, string> } {
  const credentials: Credential[] = [];
  const env: Record<string, string> = {};
  for (const runtime of Object.keys(BINDINGS)) {
    const a = loadAuth(db, runtime);
    if (!a) continue;
    // Its credential is a file, not a header; nothing to bind and nothing to fake.
    // Handled as a file plus an injected header; see filesFor and vaultBindings.
    if (a.mode === "chatgpt") continue;
    const b = BINDINGS[runtime]!;
    // git speaks Basic, not Bearer: the whole header value is built here and set
    // verbatim, because a bearer binding would send a scheme GitHub does not use
    // for the git endpoints. The token is the password; the username is ignored.
    const basic = runtime === "github" ? `Basic ${btoa(`${GIT_USER}:${a.secret}`)}` : null;
    if (basic) maskValue(basic);
    credentials.push({
      name: runtime,
      value: basic ?? a.secret,
      hosts: a.baseUrl ? [...b.hosts, new URL(a.baseUrl).hostname] : b.hosts,
      header: basic ? "Authorization" : a.mode === "api_key" && runtime === "claude" ? "x-api-key" : b.header,
      ...(runtime === "github" && opts.repo ? { paths: readOnlyGitPaths(opts.repo) ?? undefined } : {}),
    });
    if (runtime === "github") {
      // The decoy git will actually send is a stored credential file, not an env
      // var — see `gitFilesFor`.
      continue;
    }
    if (runtime === "claude") {
      if (a.mode === "oauth_token") env.CLAUDE_CODE_OAUTH_TOKEN = decoy(runtime, a.mode);
      else env.ANTHROPIC_API_KEY = decoy(runtime, a.mode);
      if (a.baseUrl) env.ANTHROPIC_BASE_URL = a.baseUrl;
    } else {
      env.OPENAI_API_KEY = decoy(runtime, a.mode);
      if (a.baseUrl) env.OPENAI_BASE_URL = a.baseUrl;
    }
  }
  return { credentials, env };
}

/**
 * Did this turn fail because the credential is no longer good?
 *
 * A year-long OAuth token expires exactly once, quietly, and the symptom is
 * every group failing at the same moment for what reads like a model error. The
 * group pauses and the escalation points at the settings page, because there is
 * nothing an agent can do about it.
 */
export function isAuthFailure(text: string): boolean {
  return /\b(401|403)\b|invalid[_ ]api[_ ]key|OAuth access token is invalid|authentication[_ ]error|Failed to authenticate/i.test(
    text,
  );
}
