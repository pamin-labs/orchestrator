/**
 * Refreshing a ChatGPT-account login, on the host, once.
 *
 * codex's own answer to CI is "put auth.json on the runner and let codex
 * refresh it", with a warning attached: *do not share the same file across
 * concurrent jobs or multiple machines*. A fleet is exactly that — ten groups,
 * ten sandboxes, one login — so every sandbox refreshing its own copy means
 * they invalidate each other and the boss is asked to log in again.
 *
 * So the orchestrator is the one runner. It holds the file, refreshes it here,
 * and the sandbox gets a decoy while the sidecar injects the real access token
 * on the way out — the same arrangement as every other credential, which is
 * what keeps codex from being the one exception.
 *
 * Endpoint and client id are the CLI's own, read out of the shipped binary
 * rather than guessed: `https://auth.openai.com/oauth/token` and
 * `app_EMoamEEZ73f0CkXaXp7hrann`.
 *
 * ponytail: this reimplements one documented call of somebody else's auth flow.
 * If OpenAI changes it, the symptom is a 401 that pauses the group and points
 * at the settings page, which is the same place a genuinely expired login
 * lands — so it fails visibly rather than quietly.
 */

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** The shape codex writes. Only the parts anything here reads are typed. */
export interface CodexAuth {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { access_token?: string; id_token?: string; refresh_token?: string; account_id?: string };
  last_refresh?: string;
}

export function parseAuth(json: string): CodexAuth | null {
  try {
    const a = JSON.parse(json) as CodexAuth;
    return a && typeof a === "object" ? a : null;
  } catch {
    return null;
  }
}

export const accessToken = (a: CodexAuth): string | null => a.tokens?.access_token ?? null;

/**
 * Old enough to be worth refreshing before a turn spends anything on it.
 *
 * codex treats roughly eight days since `last_refresh` as stale. Half of that
 * is the margin: a turn can run for an hour, and discovering the expiry
 * mid-turn costs the turn.
 */
export function isStale(a: CodexAuth, now = Date.now(), maxAgeMs = 4 * 24 * 3600_000): boolean {
  if (!a.last_refresh) return true;
  const at = Date.parse(a.last_refresh);
  return Number.isNaN(at) || now - at > maxAgeMs;
}

/**
 * Exchange the refresh token for a new pair, and return the file to store.
 *
 * Returns null when the refresh itself failed — the caller keeps what it had,
 * because a network blip must not throw away a working login.
 */
export async function refresh(
  a: CodexAuth,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexAuth | null> {
  const refreshToken = a.tokens?.refresh_token;
  if (!refreshToken) return null;
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, string | undefined>;
    if (!body.access_token) return null;
    return {
      ...a,
      auth_mode: a.auth_mode ?? "chatgpt",
      tokens: {
        ...a.tokens,
        access_token: body.access_token,
        id_token: body.id_token ?? a.tokens?.id_token,
        // Rotated on use: keeping the old one would work until it did not.
        refresh_token: body.refresh_token ?? refreshToken,
      },
      last_refresh: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * What a sandbox is given instead of the real thing.
 *
 * Enough for codex to start and believe it is logged in; the sidecar replaces
 * the Authorization header on every request to OpenAI. `last_refresh` is now so
 * that codex does not decide the login is stale and try to refresh a decoy —
 * that call would fail, and the failure would look like an expired account.
 */
export function decoyAuth(a: CodexAuth): string {
  return JSON.stringify({
    auth_mode: a.auth_mode ?? "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: `decoy-${"a".repeat(40)}`,
      id_token: a.tokens?.id_token ?? `decoy-${"i".repeat(40)}`,
      refresh_token: `decoy-${"r".repeat(40)}`,
      account_id: a.tokens?.account_id ?? "",
    },
    last_refresh: new Date().toISOString(),
  });
}
