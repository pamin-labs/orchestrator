import { expect, test } from "bun:test";
import { openMemory } from "../src/db.ts";
import { listAuth, loadAuth, saveAuth, vaultFor } from "../src/mech/auth.ts";
import { githubAccount, githubInstallations, pollForToken, startDeviceFlow, type Fetcher } from "../src/mech/ghlogin.ts";

/** A fetcher that answers from a script and records what it was sent. */
function scripted(answers: any[]): { fetchFn: Fetcher; sent: Array<{ url: string; body: string }> } {
  const sent: Array<{ url: string; body: string }> = [];
  let i = 0;
  const fetchFn: Fetcher = async (url, init) => {
    sent.push({ url, body: init?.body ?? "" });
    const a = answers[Math.min(i++, answers.length - 1)];
    return { ok: a.status ? a.status < 400 : true, status: a.status ?? 200, json: async () => a };
  };
  return { fetchFn, sent };
}

const DEVICE = {
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  deviceCode: "dev-code",
  interval: 5,
  expiresIn: 900,
};

test("the device flow asks for a code, with no secret and no scope", async () => {
  // No secret: that is the whole reason this flow is shippable in an open repo,
  // and why the client id can live in committed yaml. No scope either: a GitHub
  // App has none — what the token may do is declared on the app and chosen when
  // it is installed.
  const { fetchFn, sent } = scripted([
    { device_code: "dev-code", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 },
  ]);
  const d = await startDeviceFlow("Iv23li.public", fetchFn);
  expect(d.userCode).toBe("WDJB-MJHT");
  expect(d.deviceCode).toBe("dev-code");
  expect(sent[0]!.url).toBe("https://github.com/login/device/code");
  expect(sent[0]!.body).toBe("client_id=Iv23li.public");
  expect(sent[0]!.body).not.toContain("scope");
  expect(sent[0]!.body).not.toContain("secret");
});

test("authorization_pending keeps polling, and the exchange carries the device grant", async () => {
  const { fetchFn, sent } = scripted([
    { error: "authorization_pending" },
    { error: "authorization_pending" },
    { access_token: "gho_real" },
  ]);
  const waits: number[] = [];
  const token = await pollForToken("Iv1.public", DEVICE, {
    fetchFn,
    sleep: async (ms) => void waits.push(ms),
  });
  expect(token).toBe("gho_real");
  expect(sent).toHaveLength(3);
  expect(waits).toEqual([5000, 5000, 5000]);
  expect(sent[0]!.url).toBe("https://github.com/login/oauth/access_token");
  expect(sent[0]!.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
  expect(sent[0]!.body).toContain("device_code=dev-code");
  expect(sent[0]!.body).not.toContain("secret");
});

test("slow_down widens the interval, which is the whole reason to handle it", async () => {
  // Polling faster than GitHub allows gets the flow rate-limited into an
  // expired code — the failure a hand-rolled loop forgets. GitHub says what the
  // new interval is; its documented floor is +5s when it does not.
  const { fetchFn } = scripted([
    { error: "slow_down", interval: 10 },
    { error: "slow_down" },
    { access_token: "gho_real" },
  ]);
  const waits: number[] = [];
  const token = await pollForToken("Iv1.public", DEVICE, {
    fetchFn,
    sleep: async (ms) => void waits.push(ms),
  });
  expect(token).toBe("gho_real");
  expect(waits).toEqual([5000, 10_000, 15_000]);
});

test("a refused or expired login stops, and says which", async () => {
  const denied = scripted([{ error: "access_denied" }]);
  await expect(
    pollForToken("Iv1.public", DEVICE, { fetchFn: denied.fetchFn, sleep: async () => {} }),
  ).rejects.toThrow(/拒绝/);

  const expired = scripted([{ error: "expired_token" }]);
  await expect(
    pollForToken("Iv1.public", DEVICE, { fetchFn: expired.fetchFn, sleep: async () => {} }),
  ).rejects.toThrow(/过期/);

  // And a code that runs out while nobody is looking is the same message rather
  // than a poll that never returns.
  const forever = scripted([{ error: "authorization_pending" }]);
  let clock = 0;
  await expect(
    pollForToken("Iv1.public", DEVICE, {
      fetchFn: forever.fetchFn,
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
    }),
  ).rejects.toThrow(/过期/);
});

test("no client id is refused before anything is sent, naming both app switches", async () => {
  const { fetchFn, sent } = scripted([{}]);
  await expect(startDeviceFlow("  ", fetchFn)).rejects.toThrow(/clientId/);
  expect(sent).toHaveLength(0);
  // Both are invisible from here and both fail later rather than now: without
  // Device Flow the code request is refused, and with user token expiry left on
  // the login works today and is dead tomorrow.
  await expect(startDeviceFlow("", fetchFn)).rejects.toThrow(/Device Flow/);
  await expect(startDeviceFlow("", fetchFn)).rejects.toThrow(/过期/);
});

test("the token lands in runtime_auth like every other credential", async () => {
  // Stored, not returned: the panel reads a masked tail, and the value itself
  // only ever leaves this process into the egress sidecar's vault.
  const db = openMemory();
  const { fetchFn } = scripted([{ access_token: "gho_real_token_abc123" }]);
  const token = await pollForToken("Iv1.public", DEVICE, { fetchFn, sleep: async () => {} });
  saveAuth(db, { runtime: "github", mode: "api_key", secret: token });

  expect(loadAuth(db, "github")!.secret).toBe("gho_real_token_abc123");
  const shown = listAuth(db).find((r) => r.runtime === "github")!;
  expect(shown.hint).toBe("…abc123");
  expect(JSON.stringify(shown)).not.toContain("gho_real_token_abc123");

  // git speaks Basic, and the sidecar is what holds the real value.
  const bound = vaultFor(db).credentials.find((c) => c.name === "github")!;
  expect(bound.value).toBe(`Basic ${btoa(`x-access-token:gho_real_token_abc123`)}`);
  expect(bound.hosts).toContain("github.com");
});

test("authorized is not installed, and only one of the two can reach a repo", async () => {
  // The state that reads as success and is not: a GitHub App's user token sees
  // exactly the installations the app has, so zero of them is a green 已连接
  // over a repo list that can never fill.
  const none = scripted([{ total_count: 0, installations: [] }]);
  expect(await githubInstallations("gho_x", none.fetchFn)).toBe(0);
  expect(none.sent[0]!.url).toBe("https://api.github.com/user/installations");

  const one = scripted([{ total_count: 1, installations: [{ id: 42 }] }]);
  expect(await githubInstallations("gho_x", one.fetchFn)).toBe(1);

  // Could not tell is neither: the panel already reports that as a stale token
  // rather than as "not installed", which would send the boss to the wrong page.
  const dead = scripted([{ status: 401 }]);
  expect(await githubInstallations("gho_x", dead.fetchFn)).toBeNull();
});

test("the account is asked of GitHub, and a dead token reads as no account", async () => {
  const ok = scripted([{ login: "octocat" }]);
  expect(await githubAccount("gho_x", ok.fetchFn)).toBe("octocat");
  // 404 as well as 401: GitHub answers 404 for what a token cannot see, so this
  // deliberately does not try to say which of the two it was.
  const gone = scripted([{ status: 404, message: "Not Found" }]);
  expect(await githubAccount("gho_x", gone.fetchFn)).toBeNull();
  expect(await githubAccount("gho_x", async () => {
    throw new Error("offline");
  })).toBeNull();
});
