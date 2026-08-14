import type { DB } from "../db.ts";
import type { Credential } from "./sandbox.ts";
import { join } from "node:path";
import { accessToken, decoyAuth, isStale, parseAuth, renew, seedHome } from "./chatgpt.ts";

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
  // Read-only, and only for the clone. A sandbox must never hold something that
  // can write to the remote — see publishBranch for why that is load-bearing
  // rather than tidy. Bound here so a private repository can be cloned over
  // HTTPS without the token being inside the container.
  github: { hosts: ["github.com", "api.github.com"] },
};

/** A value the CLI will accept as well-formed and the API will reject. */
export function decoy(runtime: string, mode: AuthMode): string {
  if (runtime === "claude") return mode === "oauth_token" ? `sk-ant-oat01-${"A".repeat(80)}` : `sk-ant-api03-${"A".repeat(80)}`;
  return `sk-${"A".repeat(48)}`;
}

export function saveAuth(db: DB, a: RuntimeAuth): void {
  db.run(
    `INSERT INTO runtime_auth (runtime, mode, secret, base_url, updated_at)
     VALUES (?, ?, ?, ?, unixepoch() * 1000)
     ON CONFLICT(runtime) DO UPDATE SET mode = excluded.mode, secret = excluded.secret,
       base_url = excluded.base_url, updated_at = excluded.updated_at`,
    [a.runtime, a.mode, a.secret, a.baseUrl ?? null],
  );
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
      hint: `…${r.secret.slice(-6)}`,
      baseUrl: r.base_url ?? undefined,
      updatedAt: r.updated_at,
    }));
}

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
  const a = loadAuth(db, "codex");
  if (a?.mode !== "chatgpt") return {};
  const parsed = parseAuth(a.secret);
  if (!parsed) return {};
  return {
    [`${CODEX_HOME}/auth.json`]: decoyAuth(parsed),
    // Without this codex looks for the login in the OS keychain instead.
    [`${CODEX_HOME}/config.toml`]: 'cli_auth_credentials_store = "file"\n',
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
export async function currentChatgptToken(db: DB, dataDir: string, now = Date.now()): Promise<string | null> {
  const a = loadAuth(db, "codex");
  if (a?.mode !== "chatgpt") return null;
  let parsed = parseAuth(a.secret);
  if (!parsed) return null;
  if (isStale(parsed, now)) {
    const codexHome = join(dataDir, "codex-home");
    await seedHome(codexHome, a.secret);
    const next = await renew(codexHome);
    if (next) {
      saveAuth(db, { ...a, secret: JSON.stringify(next) });
      parsed = next;
    }
  }
  return accessToken(parsed);
}

/**
 * The refreshed login, if the sandbox rotated it.
 *
 * codex refreshes its own tokens and rewrites auth.json, so the copy in the
 * sandbox drifts ahead of ours within hours. Reading it back keeps the next
 * sandbox working. The boss's own `~/.codex/auth.json` is never touched — it is
 * theirs, and the same login refreshed in two places will eventually invalidate
 * one of them whatever we do.
 */
export function absorbCodexHome(db: DB, contents: string): boolean {
  const a = loadAuth(db, "codex");
  if (a?.mode !== "chatgpt" || !contents.trim() || contents === a.secret) return false;
  try {
    JSON.parse(contents);
  } catch {
    return false;
  }
  saveAuth(db, { ...a, secret: contents });
  return true;
}

/**
 * Everything the sidecar should inject, including the refreshed ChatGPT token.
 *
 * Async because that one may have to be renewed first, and renewing it is a
 * network call. Every other credential is a stored string.
 */
export async function vaultBindings(db: DB, dataDir: string): Promise<{ credentials: Credential[]; env: Record<string, string> }> {
  const base = vaultFor(db);
  const token = await currentChatgptToken(db, dataDir);
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

/** Real credentials for the vault, and the fakes that go in the environment. */
export function vaultFor(db: DB): { credentials: Credential[]; env: Record<string, string> } {
  const credentials: Credential[] = [];
  const env: Record<string, string> = {};
  for (const runtime of Object.keys(BINDINGS)) {
    const a = loadAuth(db, runtime);
    if (!a) continue;
    // Its credential is a file, not a header; nothing to bind and nothing to fake.
    // Handled as a file plus an injected header; see filesFor and vaultBindings.
    if (a.mode === "chatgpt") continue;
    const b = BINDINGS[runtime]!;
    credentials.push({
      name: runtime,
      value: a.secret,
      hosts: a.baseUrl ? [...b.hosts, new URL(a.baseUrl).hostname] : b.hosts,
      header: a.mode === "api_key" && runtime === "claude" ? "x-api-key" : b.header,
    });
    if (runtime === "github") {
      // git sends `Authorization: Basic`, so the decoy has to be a username the
      // sidecar can replace rather than an env var the CLI reads.
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
