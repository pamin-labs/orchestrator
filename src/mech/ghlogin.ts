/**
 * Connect GitHub once, from the settings page, the way GitHub Desktop does.
 *
 * **Device flow, against a GitHub App.** A code on screen, a browser tab,
 * nothing pasted and no `gh` binary. The token exchange needs `client_id`,
 * `device_code` and `grant_type` and *no client secret* — which is the entire
 * reason this is the flow an open-source project can ship. The client id is not
 * a secret and lives in `config/default.yaml`.
 *
 * No `scope` parameter: a GitHub App has no OAuth scopes. What the token may do
 * is declared on the app and chosen when it is installed, so sending one would
 * be ignored at best.
 *
 * Plain `fetch`, not `@octokit/auth-oauth-device`: that library's shape is
 * "block until the human comes back, calling `onVerification` on the way", and
 * what the panel needs is the opposite — hand the code to the browser now, poll
 * in the background, store the token whenever it lands. Its one real asset is
 * the `slow_down` backoff, which is the four lines below. Same call as
 * decision 007 made against `@octokit/rest` for eight endpoints.
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * No client id configured — said the same way wherever it is noticed.
 *
 * Both app settings are named because both are invisible from here and each
 * fails later rather than now: without Device Flow the code request itself is
 * refused, and with user token expiry left on the login works today and is dead
 * tomorrow — refreshing an expiring user token needs a client secret, which is
 * the one thing this project cannot ship.
 */
export const NO_CLIENT_ID =
  "还没配 GitHub App 的 client_id。去 GitHub → Settings → Developer settings → GitHub Apps 建一个，两个开关必须对：勾上 Enable Device Flow；Optional Features 里的 user token 过期要关掉（开着的话 8 小时就失效，续期得有 client secret，而这个仓库是公开的）。然后把 Client ID 填进 config/default.yaml 的 github.clientId。";

/** Only the shape used here, so a test stub is a function rather than a cast. */
export type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface DeviceCode {
  /** The eight characters the boss types into github.com. The whole interaction. */
  userCode: string;
  verificationUri: string;
  /** Ours, never shown: this is what the poll trades for a token. */
  deviceCode: string;
  /** Seconds between polls. GitHub rate-limits a faster one. */
  interval: number;
  expiresIn: number;
}

async function form(fetchFn: Fetcher, url: string, params: Record<string, string>): Promise<any> {
  const r = await fetchFn(url, {
    method: "POST",
    // Without this GitHub answers url-encoded and every field reads as undefined.
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GitHub 回了 ${r.status}`);
  return await r.json();
}

/** Ask for a code. Returns as soon as there is something to show. */
export async function startDeviceFlow(clientId: string, fetchFn: Fetcher = fetch): Promise<DeviceCode> {
  if (!clientId.trim()) throw new Error(NO_CLIENT_ID);
  const b = await form(fetchFn, DEVICE_CODE_URL, { client_id: clientId });
  if (b.error || !b.device_code) throw new Error(b.error_description || b.error || "GitHub 没给出登录码");
  return {
    userCode: String(b.user_code),
    verificationUri: String(b.verification_uri ?? "https://github.com/login/device"),
    deviceCode: String(b.device_code),
    interval: Number(b.interval) || 5,
    expiresIn: Number(b.expires_in) || 900,
  };
}

/**
 * Wait for the browser, then hand back the token.
 *
 * Four answers, not one. `slow_down` is the one a hand-rolled loop forgets, and
 * forgetting it is how the poll gets rate-limited into `expired_token` — GitHub
 * says what the new interval is, and its documented floor is +5 seconds when it
 * does not.
 */
export async function pollForToken(
  clientId: string,
  d: DeviceCode,
  opts: { fetchFn?: Fetcher; sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? Bun.sleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + d.expiresIn * 1000;
  let interval = d.interval;

  while (now() < deadline) {
    await sleep(interval * 1000);
    const b = await form(fetchFn, TOKEN_URL, {
      client_id: clientId,
      device_code: d.deviceCode,
      grant_type: GRANT_TYPE,
    });
    if (b.access_token) return String(b.access_token);
    switch (b.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        interval = Number(b.interval) || interval + 5;
        break;
      case "expired_token":
        throw new Error("登录码过期了，重新点一次「连接 GitHub」");
      case "access_denied":
        throw new Error("在 GitHub 上拒绝了这次授权");
      default:
        throw new Error(b.error_description || b.error || "GitHub 没给出 token");
    }
  }
  throw new Error("登录码过期了，重新点一次「连接 GitHub」");
}

/** A GET as this token. `null` for anything that is not an answer. */
async function api(token: string, path: string, fetchFn: Fetcher): Promise<any> {
  try {
    const r = await fetchFn(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * Which account this token is.
 *
 * Also the only proof it still works, which is why the settings page asks for it
 * rather than reading a name stored beside the token: a stored name keeps saying
 * "connected" for a token GitHub revoked last week (决策 007 §6). `null` means
 * the token no longer answers — deliberately not split into why, because
 * GitHub answers 404 for "cannot see it" as well as "gone".
 */
export async function githubAccount(token: string, fetchFn: Fetcher = fetch): Promise<string | null> {
  return (await api(token, "/user", fetchFn))?.login ?? null;
}

/**
 * How many places this app is installed.
 *
 * Authorized and installed are different states, and only the second one can
 * reach a repository: a GitHub App's user token sees exactly the installations
 * the app has. Zero is the state that reads as success and is not — a green
 * 已连接 above a repo list that is permanently empty — so the panel asks, and
 * says "install it" rather than "connected".
 *
 * `null` is "could not tell" (the token is dead, or the network is), which the
 * caller already reports as a stale credential.
 */
export async function githubInstallations(token: string, fetchFn: Fetcher = fetch): Promise<number | null> {
  const b = await api(token, "/user/installations", fetchFn);
  return b ? (Number(b.total_count) || 0) : null;
}
