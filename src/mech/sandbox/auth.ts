import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { DB } from "../../platform/persistence/database.ts";
import { trailers } from "../git/ghlogin.ts";
import { forgetHolds } from "../git/repository.ts";
import { maskValue } from "../../platform/observability/redaction.ts";
import { accessToken, type CodexHomeIO, decoyAuth, isStale, parseAuth, renew, seedHome } from "./chatgpt.ts";
import type { Credential } from "./sandbox.ts";

/**
 * Where each runtime's credential comes from, and how it reaches the model.
 *
 * Never into the sandbox. The value goes to the egress sidecar's vault and is
 * injected into outbound requests on the way past; the sandbox's environment
 * holds a format-plausible fake. The sidecar *replaces* an `Authorization`
 * header the CLI already set (docs/adr/005), so each path must send something.
 */

/** The sandbox server key is stored beside model credentials, but never injected. */
export const SANDBOX_KEY = "sandbox";

export const AuthRuntimeSchema = z.enum(["claude", "codex", "github", SANDBOX_KEY]);
const credential = {
  secret: z.string().trim().min(1),
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
};

/**
 * Runtime and mode are one fact: combinations outside this union cannot run.
 *
 * `chatgpt` is its own mode because what is stored is a login, not a key — a
 * pair of tokens codex rotates, so the vault could only bind one access token
 * that expires in hours. It is stored whole, refreshed on the host, and injected
 * as a header while the sandbox gets a decoy file. It alone can go stale.
 */
export const RuntimeAuthSchema = z.discriminatedUnion("runtime", [
  z.strictObject({ runtime: z.literal("claude"), mode: z.enum(["oauth_token", "api_key"]), ...credential }),
  z.strictObject({ runtime: z.literal("codex"), mode: z.enum(["chatgpt", "api_key"]), ...credential }),
  z.strictObject({ runtime: z.literal("github"), mode: z.literal("api_key"), ...credential }),
  z.strictObject({ runtime: z.literal(SANDBOX_KEY), mode: z.literal("api_key"), ...credential }),
]);
export type RuntimeAuth = z.infer<typeof RuntimeAuthSchema>;
export type AuthMode = RuntimeAuth["mode"];

/** Hosts each runtime talks to, and the header its credential belongs in. */
const BINDINGS: Record<string, { hosts: string[]; header?: string }> = {
  // An OAuth token travels as `Authorization: Bearer`; an API key as `x-api-key`.
  claude: { hosts: ["api.anthropic.com"] },
  codex: { hosts: ["api.openai.com", "chatgpt.com"] },
  // Read-only in a group container, enforced by `readOnlyGitPaths` rather than
  // by the scope of the token. Bound here so a private repository can be cloned
  // over HTTPS without the token being inside the container.
  github: { hosts: ["github.com", "api.github.com"] },
};

/**
 * The two request paths a clone and a fetch use, and no third.
 *
 * This is the whole of "a group container cannot write to the remote", and the
 * guarantee is **no write ever completes**, not "the token is never presented on
 * a write path": push discovery differs from fetch discovery only in the query
 * string, which the sidecar cuts before matching, so it *is* credentialed.
 */
export function readOnlyGitPaths(remote: string): string[] | null {
  const m = /github\.com[:/]+(.+?)(\.git)?\/?$/i.exec(remote.trim());
  if (!m) return null;
  const base = `/${m[1]}${m[2] ?? ""}`;
  // Exact strings, never `/owner/repo.git*`: a trailing `*` is a prefix match
  // that does not stop at `/` and would readmit `git-receive-pack` — which,
  // matching nothing, goes out with the decoy and gets a 401 from GitHub. Git
  // LFS (`/owner/repo.git/info/lfs/…`) is absent because its path admits uploads
  // too, so a private LFS repository cannot fetch objects inside a group.
  return [`${base}/info/refs`, `${base}/git-upload-pack`];
}

/** A value the CLI will accept as well-formed and the API will reject. */
export function decoy(runtime: string, mode: AuthMode): string {
  if (runtime === "claude")
    return mode === "oauth_token" ? `sk-ant-oat01-${"A".repeat(80)}` : `sk-ant-api03-${"A".repeat(80)}`;
  return `sk-${"A".repeat(48)}`;
}

const CREDENTIAL_PREFIX: Readonly<Record<string, readonly [string, string]>> = {
  "claude:oauth_token": ["sk-ant-oat01-", "订阅 token 是 sk-ant-oat01- 开头的"],
  "claude:api_key": ["sk-ant-", "Anthropic 的 API key 是 sk-ant- 开头的"],
  "codex:api_key": ["sk-", "OpenAI 的 API key 是 sk- 开头的"],
};

/** Reject provider-impossible shapes early; prefixes are stable while lengths drift. */
export function wrongShape({ runtime, mode, secret }: RuntimeAuth): string | null {
  const v = secret.trim();
  if (!v) return "空的";
  if (/^https?:\/\//.test(v)) return "这是个网址，不是凭据 —— 登录页的地址不是 token";
  if (mode === "chatgpt") {
    const parsed = parseAuth(v);
    if (!parsed) return "要的是 ~/.codex/auth.json 的完整内容，那是一段 JSON";
    return parsed.tokens?.refresh_token ? null : "auth.json 里没有 tokens.refresh_token，续不了期";
  }
  const expected = CREDENTIAL_PREFIX[`${runtime}:${mode}`];
  return expected && !v.startsWith(expected[0]) ? expected[1] : null;
}

export function saveAuth(db: DB, a: RuntimeAuth): void {
  const auth = RuntimeAuthSchema.parse(a);
  // Registered the moment it is stored, so the masker knows this value before
  // anything has a chance to print it. Same order as `::add-mask::`.
  maskValue(auth.secret);
  // Nothing learned from the old credential still applies; without this a
  // reconnect changes nothing visible until the hold's clock lapses.
  forgetHolds(auth.runtime);
  db.run(
    `INSERT INTO runtime_auth (runtime, mode, secret, base_url, updated_at)
     VALUES (?, ?, ?, ?, unixepoch() * 1000)
     ON CONFLICT(runtime) DO UPDATE SET mode = excluded.mode, secret = excluded.secret,
       base_url = excluded.base_url, updated_at = excluded.updated_at`,
    [auth.runtime, auth.mode, auth.secret, auth.baseUrl ?? null],
  );
}

/**
 * Does this runtime have a subscription window worth reading?
 *
 * A per-token key has no window to run out of. And the usage endpoint is the
 * provider's own (subusage.ts), so once a self-hosted gateway is configured the
 * quota belongs to a different account than the one the fleet spends. No row is
 * false for the same reason: it would report an account nothing here touches.
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
 * Both tools let you move it — `$CODEX_HOME`, `$CLAUDE_CONFIG_DIR` — and
 * hardcoding `~/.codex` / `~/.claude` fails silently for anyone who has, reading
 * the credential from a directory the CLI never wrote. These are the *host*
 * paths; `CODEX_HOME` below is the container's, ours to fix and fixed.
 */
export const hostCodexHome = (home = homedir()): string => process.env.CODEX_HOME || join(home, ".codex");
export const hostClaudeHome = (home = homedir()): string => process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");

/**
 * The hosts a turn has to be able to reach, for the configured credentials.
 *
 * Derived rather than configured: exactly the hosts the vault binds, so a
 * self-hosted gateway moves the probe with it and no second list drifts. Only
 * credentials that exist count — probing a provider nobody configured reports
 * the machine offline for a wall it will never hit.
 */
export function probeHosts(db: DB): string[] {
  const out = new Set<string>();
  for (const a of db
    .query<{ runtime: string; base_url: string | null }, []>("SELECT runtime, base_url FROM runtime_auth")
    .all()) {
    // Only runtimes this file actually binds. `runtime_auth` also holds rows that
    // are not model providers — `sandbox` is the local server, with a `base_url`
    // of `http://127.0.0.1:8080` — and the `base_url` branch used to run before
    // this check, so that row put **127.0.0.1** into the list. With no provider
    // configured it was the *only* entry, and since any one host answering is
    // enough, "is the internet up" was decided by whether something listens on
    // localhost:443. Nothing does. Measured: fails in 5ms, every tick, and the
    // panel says 宿主断网了.
    const bound = BINDINGS[a.runtime];
    if (!bound) continue;
    if (a.base_url) {
      try {
        // The whole origin, not the hostname. Discarding the scheme and port
        // defeated the reason this is derived rather than configured — a
        // self-hosted gateway on `http://gw.internal:8443` was probed at
        // `https://gw.internal:443` and reported unreachable.
        out.add(new URL(a.base_url).origin);
        continue;
      } catch {}
    }
    for (const h of bound.hosts) out.add(`https://${h}`);
  }
  // github is bound for cloning, not for running a turn, and a repo host being
  // unreachable is not a reason to stop every agent.
  for (const h of BINDINGS.github!.hosts) out.delete(`https://${h}`);
  return [...out];
}

type StoredAuthRow = { runtime: string; mode: string; secret: string; base_url: string | null };

const parseStoredAuth = (row: StoredAuthRow): RuntimeAuth | null => {
  const parsed = RuntimeAuthSchema.safeParse({
    runtime: row.runtime,
    mode: row.mode,
    secret: row.secret,
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
  });
  return parsed.success ? parsed.data : null;
};

/**
 * The address a stored sandbox key belongs to, as one `host[:port]`.
 *
 * `base_url` is a URL because a model gateway's is; the sandbox server's address
 * is `host[:port]` by contract. Compared as authorities so a row written as
 * `http://127.0.0.1:8080` matches a configured `127.0.0.1:8080`.
 */
const authorityOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * The key to send to one sandbox server address, and nothing to send elsewhere.
 *
 * `sandbox.server` is a settings knob the panel rewrites at runtime while the
 * secret is stored once, so resolving them independently made changing the
 * address enough to hand the stored key to it. The config/environment value is
 * not filtered: whoever sets it also sets the address, so no boundary is crossed.
 */
export function sandboxKeyFor(db: DB, server: string, fromConfig?: string): string {
  const stored = loadAuth(db, SANDBOX_KEY);
  const bound = stored?.baseUrl ? authorityOf(stored.baseUrl) : null;
  if (stored && bound && bound === server.trim()) return stored.secret;
  // An unbound row is one stored before the address travelled with it. `bindSandboxKey`
  // fixes that at startup, so reaching here means the address has genuinely moved
  // since — and a key that may belong to somewhere else is not sent.
  return fromConfig ?? "";
}

/**
 * Give a key stored before this rule the address that was in effect at boot.
 *
 * ponytail: binds to whatever the settings say at startup, so it cannot tell a
 * legitimate address from one changed before the last restart. It closes the
 * live path — change the knob and the next probe hands the key over with
 * nothing restarting. Bind at write time if that ceiling starts to matter.
 */
export function bindSandboxKey(db: DB, server: string): void {
  const stored = loadAuth(db, SANDBOX_KEY);
  if (!stored || stored.baseUrl) return;
  saveAuth(db, { ...stored, baseUrl: `http://${server.trim()}` });
}

export function loadAuth(db: DB, runtime: string): RuntimeAuth | null {
  const r = db
    .query<StoredAuthRow, [string]>("SELECT runtime, mode, secret, base_url FROM runtime_auth WHERE runtime = ?")
    .get(runtime);
  return r ? parseStoredAuth(r) : null;
}

/**
 * What the settings page is allowed to see.
 *
 * Never the secret. A masked tail is enough to tell two tokens apart, which is
 * the only question a human asks of one they already pasted.
 */
export function listAuth(
  db: DB,
): Array<{ runtime: string; mode: AuthMode; hint: string; baseUrl?: string; updatedAt: number }> {
  return db
    .query<{ runtime: string; mode: string; secret: string; base_url: string | null; updated_at: number }, []>(
      "SELECT runtime, mode, secret, base_url, updated_at FROM runtime_auth ORDER BY runtime",
    )
    .all()
    .flatMap((r) => {
      const auth = parseStoredAuth(r);
      if (!auth) return [];
      return [
        {
          runtime: auth.runtime,
          mode: auth.mode,
          // A token's tail identifies it. A pasted auth.json's tail is `11Z" }`,
          // which identifies nothing — for that one the account it logged in as is
          // the only thing worth showing.
          hint: auth.mode === "chatgpt" ? chatgptHint(auth.secret) : `…${auth.secret.slice(-6)}`,
          ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
          updatedAt: r.updated_at,
        },
      ];
    });
}

/** Where codex looks for its login inside a sandbox. */
export const CODEX_HOME = "/root/.codex";

/**
 * Files a sandbox needs because the CLI reads a file and nothing else.
 *
 * codex is the only one, and what it gets is a **decoy**: enough to start and
 * believe it is logged in, while the sidecar swaps in the real access token on
 * the way out. The real auth.json in every sandbox is what codex's own CI
 * guidance warns against — each copy refreshes, and they invalidate each other.
 */
export function filesFor(db: DB): Record<string, string> {
  const files: Record<string, string> = { ...gitFilesFor(db), ...claudeFilesFor(db) };
  const a = loadAuth(db, "codex");
  if (a?.mode !== "chatgpt") return files;
  const parsed = parseAuth(a.secret);
  if (!parsed) return files;
  files[`${CODEX_HOME}/auth.json`] = decoyAuth(parsed);
  // Without this codex looks for the login in the OS keychain instead.
  files[`${CODEX_HOME}/config.toml`] = 'cli_auth_credentials_store = "file"\n';
  return files;
}

/**
 * Claude Code's own commit trailer, on the commits an agent writes by hand.
 *
 * The CLI appends `Co-Authored-By: Claude` to its own commits; left alone the
 * setting is on, and nothing in the panel could reach it. `--setting-sources
 * user,project,local` is what makes this file read at all, and `/root/.claude`
 * is the container's HOME, holding nothing but what we put in it.
 */
function claudeFilesFor(db: DB): Record<string, string> {
  const { claudeCoauthor } = trailers(db);
  return { "/root/.claude/settings.json": `${JSON.stringify({ includeCoAuthoredBy: claudeCoauthor }, null, 2)}\n` };
}

/** The username half of git's Basic auth. GitHub ignores it; the token is the password. */
const GIT_USER = "x-access-token";

/**
 * Give git something to send, so the sidecar has something to replace.
 *
 * `git clone` does **not** send `Authorization` up front: it asks anonymously
 * and only then looks for a credential helper, so the vault had no header to
 * replace (005). git gets a stored credential whose password is a decoy,
 * swapped for the real one on the way out. Nothing real is ever inside.
 */
function gitFilesFor(db: DB): Record<string, string> {
  // Only when a GitHub credential is configured: a public repository clones
  // anonymously, and handing git a credential it will fail with makes that a 401.
  if (!loadAuth(db, "github")) return {};
  return {
    "/root/.git-credentials": BINDINGS.github!.hosts.map(
      (h) => `https://${GIT_USER}:${decoy("github", "api_key")}@${h}\n`,
    ).join(""),
    // `store` is what makes git read the file above without asking anyone.
    // Written here rather than with `git config --global` because the checkout
    // sets its identity with a repo-local `git config`, so nothing else owns
    // this file.
    "/root/.gitconfig": "[credential]\n\thelper = store\n",
  };
}

/**
 * Re-entrancy guard, and the reason it has to exist.
 *
 * The refresh runs `codex` inside the utility container, and getting that
 * container means `openSandbox` → `vaultBindings` → here, so a stale refresh
 * would recurse forever. While one is in flight every other caller gets the
 * token we already have: minutes from expiry at worst, against a deadlock.
 */
let refreshing = false;

/**
 * Refresh the stored ChatGPT login if it is getting old, and hand back the
 * access token the sidecar should inject.
 *
 * One refresher, on the host, because there is one login: ten sandboxes each
 * refreshing their own copy is what codex's CI guidance says not to do. A failed
 * one keeps what we had, and surfaces later as the 401 that pauses the group.
 */
async function currentChatgptToken(db: DB, io: CodexHomeIO | null, now = Date.now()): Promise<string | null> {
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
        // One writer. The container is where the refresh happens; this row is
        // the only copy anything reads, and the container's `auth.json` is
        // scratch that gets reseeded from here. Nothing else ever refreshes it.
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
 * `absorbCodexHome` used to read `$CODEX_HOME/auth.json` back out after every
 * codex turn. Since 005 that file is a decoy *we* wrote, so the read-back found
 * our own fake and stored it, replacing the real refresh token, which nothing
 * else holds. One login, one refresher, on the host; a second writer is the bug.
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
  /** Restrict GitHub injection to one repository's read paths. */
  repo?: string | null;
}

/** Real credentials for the vault, and the fakes that go in the environment. */
export function vaultFor(db: DB, opts: VaultOpts = {}): { credentials: Credential[]; env: Record<string, string> } {
  const credentials: Credential[] = [];
  const env: Record<string, string> = {};
  for (const runtime of Object.keys(BINDINGS)) {
    const a = loadAuth(db, runtime);
    if (!a) continue;
    const credential = vaultCredential(a, opts);
    if (credential) credentials.push(credential);
    addDecoyEnv(env, a);
  }
  return { credentials, env };
}

function vaultCredential(a: RuntimeAuth, opts: VaultOpts): Credential | null {
  if (a.mode === "chatgpt") return null;
  const binding = BINDINGS[a.runtime]!;
  const basic = a.runtime === "github" ? `Basic ${btoa(`${GIT_USER}:${a.secret}`)}` : null;
  if (basic) maskValue(basic);
  const header = credentialHeader(a, basic, binding.header);
  const paths = credentialPaths(a, opts);
  return {
    name: a.runtime,
    value: basic ?? a.secret,
    hosts: a.baseUrl ? [...binding.hosts, new URL(a.baseUrl).hostname] : binding.hosts,
    ...(header ? { header } : {}),
    ...(paths ? { paths } : {}),
  };
}

function credentialHeader(a: RuntimeAuth, basic: string | null, fallback?: string): string | undefined {
  if (basic) return "Authorization";
  if (a.runtime === "claude" && a.mode === "api_key") return "x-api-key";
  return fallback;
}

function credentialPaths(a: RuntimeAuth, opts: VaultOpts): string[] | null {
  if (a.runtime !== "github" || !opts.repo) return null;
  return readOnlyGitPaths(opts.repo);
}

function addDecoyEnv(env: Record<string, string>, a: RuntimeAuth): void {
  if (a.runtime === "github" || a.runtime === SANDBOX_KEY || a.mode === "chatgpt") return;
  if (a.runtime === "claude") {
    env[a.mode === "oauth_token" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = decoy(a.runtime, a.mode);
    if (a.baseUrl) env.ANTHROPIC_BASE_URL = a.baseUrl;
    return;
  }
  env.OPENAI_API_KEY = decoy(a.runtime, a.mode);
  if (a.baseUrl) env.OPENAI_BASE_URL = a.baseUrl;
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
