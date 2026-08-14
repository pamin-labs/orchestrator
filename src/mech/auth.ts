import type { DB } from "../db.ts";
import type { Credential } from "./sandbox.ts";

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

export type AuthMode = "oauth_token" | "api_key";

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

/** Real credentials for the vault, and the fakes that go in the environment. */
export function vaultFor(db: DB): { credentials: Credential[]; env: Record<string, string> } {
  const credentials: Credential[] = [];
  const env: Record<string, string> = {};
  for (const runtime of Object.keys(BINDINGS)) {
    const a = loadAuth(db, runtime);
    if (!a) continue;
    const b = BINDINGS[runtime]!;
    credentials.push({
      name: runtime,
      value: a.secret,
      hosts: a.baseUrl ? [...b.hosts, new URL(a.baseUrl).hostname] : b.hosts,
      header: a.mode === "api_key" && runtime === "claude" ? "x-api-key" : b.header,
    });
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
