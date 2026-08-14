import { expect, test } from "bun:test";
import { openMemory } from "../src/db.ts";
import { absorbCodexHome, CODEX_HOME, decoy, filesFor, isAuthFailure, listAuth, loadAuth, saveAuth, vaultFor } from "../src/mech/auth.ts";
import { newEnough, preflight, report } from "../src/mech/preflight.ts";
import { accessToken, isStale, parseAuth, refresh } from "../src/mech/chatgpt.ts";
import { loginRuntimes, startLogin } from "../src/mech/login.ts";
import type { Ctx } from "../src/api.ts";

const REAL = `sk-ant-oat01-${"R".repeat(80)}`;

test("the real value never leaves the process except into the vault", () => {
  const db = openMemory();
  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: REAL });

  // What the settings page sees.
  const shown = listAuth(db);
  expect(shown[0]!.hint).toBe(`…${REAL.slice(-6)}`);
  expect(JSON.stringify(shown)).not.toContain(REAL);

  // What the sandbox sees: a token the CLI will accept as well-formed and the
  // API will reject. Measured (005): claude does not validate locally, so this
  // reaches the server and comes back 401 — which is what makes the swap work.
  const { credentials, env } = vaultFor(db);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(decoy("claude", "oauth_token"));
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(REAL);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN!.startsWith("sk-ant-oat01-")).toBe(true);

  // And what the sidecar gets, bound to the one host it is for.
  expect(credentials).toEqual([
    { name: "claude", value: REAL, hosts: ["api.anthropic.com"], header: undefined },
  ]);
});

test("an api key goes in the header the API wants, and can name its own endpoint", () => {
  const db = openMemory();
  saveAuth(db, { runtime: "claude", mode: "api_key", secret: "sk-ant-api03-x", baseUrl: "https://proxy.example.com/v1" });
  const { credentials, env } = vaultFor(db);
  expect(credentials[0]!.header).toBe("x-api-key");
  // The compatible endpoint has to be bound too, or the injection never fires
  // for the host the CLI is actually talking to.
  expect(credentials[0]!.hosts).toContain("proxy.example.com");
  expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example.com/v1");
  expect(env.ANTHROPIC_API_KEY).not.toContain("sk-ant-api03-x");
});

test("re-saving replaces rather than accumulating", () => {
  const db = openMemory();
  saveAuth(db, { runtime: "codex", mode: "api_key", secret: "one" });
  saveAuth(db, { runtime: "codex", mode: "api_key", secret: "two" });
  expect(listAuth(db).length).toBe(1);
  expect(loadAuth(db, "codex")!.secret).toBe("two");
});

test("an expired credential is recognised from what the CLI actually prints", () => {
  // Verbatim from a real run against a synthetic token.
  expect(isAuthFailure("Failed to authenticate. API Error: 401 OAuth access token is invalid.")).toBe(true);
  expect(isAuthFailure("401 invalid_api_key")).toBe(true);
  // A model refusing a request is not a credential problem, and pausing the
  // group over it would stop work for something a retry fixes.
  expect(isAuthFailure("the tests failed: 3 assertions")).toBe(false);
  expect(isAuthFailure("rate_limit_error: 429")).toBe(false);
});

test("preflight names what is missing and how to fix it, rather than degrading", async () => {
  const db = openMemory();
  const checks = await preflight({
    db,
    sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
    probe: () => false,
  });
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  expect(by.docker!.ok).toBe(false);
  expect(by["opensandbox-server"]!.ok).toBe(false);
  expect(by["claude credentials"]!.ok).toBe(false);
  // Every failure carries the command that fixes it. Without that this is a
  // list of nouns, and the failure mode it replaces — agents that silently do
  // nothing — is already hard enough to read.
  for (const c of checks) if (!c.ok) expect(c.fix!.length).toBeGreaterThan(10);
  expect(report(checks)).toContain("opensandbox-server");

  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: REAL });
  const after = await preflight({ db, sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" }, probe: () => false });
  expect(after.find((c) => c.name === "claude credentials")!.ok).toBe(true);
});

test("the egress sidecar version is checked, because its failure reads as a project problem", () => {
  // v1.1.4 is what `opensandbox-server init-config --example docker` writes, and
  // with a credential bound it 403s every scoped package fetch. The symptom is
  // "this project cannot install its dependencies", which nobody traces back to
  // a sidecar version — so the version is checked rather than the symptom.
  expect(newEnough("v1.1.4")).toBe(false);
  expect(newEnough("v1.1.6")).toBe(true);
  expect(newEnough("v1.2.0")).toBe(true);
  expect(newEnough("v2.0.0")).toBe(true);
  // Not ours to judge: a tag we cannot parse is somebody's deliberate choice.
  expect(newEnough("latest")).toBe(true);
});

test("a ChatGPT login is refreshed on the host, and the sandbox only gets a decoy", () => {
  // codex has exactly two non-interactive credential paths: an API key, or an
  // auth.json in $CODEX_HOME. Its own CI guidance says to put the real file on
  // the runner — and, in the same breath, not to share it across concurrent
  // jobs. A fleet is ten concurrent jobs on one login, so the file stays here
  // and the sandbox gets something shaped like it.
  const db = openMemory();
  const real = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "REAL-ACCESS", refresh_token: "REAL-REFRESH", account_id: "acct" },
    last_refresh: new Date().toISOString(),
  });
  saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: real });

  const files = filesFor(db);
  const written = files[`${CODEX_HOME}/auth.json`]!;
  expect(written).not.toContain("REAL-ACCESS");
  expect(written).not.toContain("REAL-REFRESH");
  // Shaped like a login, or codex will not start.
  expect(JSON.parse(written).tokens.access_token.length).toBeGreaterThan(20);
  // And told to read the file rather than the OS keychain.
  expect(files[`${CODEX_HOME}/config.toml`]).toContain("file");

  // Nothing for the environment either: this one is a file plus an injection.
  const { credentials, env } = vaultFor(db);
  expect(credentials.find((c) => c.name === "codex")).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
});

test("a login codex refreshed inside the sandbox is written back, once it is really new", () => {
  const db = openMemory();
  const first = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } });
  saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: first });

  const rotated = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a2", refresh_token: "r2" } });
  expect(absorbCodexHome(db, rotated)).toBe(true);
  expect(loadAuth(db, "codex")!.secret).toBe(rotated);
  // Unchanged, or not a file at all, is not something to write back.
  expect(absorbCodexHome(db, rotated)).toBe(false);
  expect(absorbCodexHome(db, "half a file")).toBe(false);
  expect(loadAuth(db, "codex")!.secret).toBe(rotated);
});


test("an api key for codex goes to the sidecar like everything else", () => {
  const db = openMemory();
  saveAuth(db, { runtime: "codex", mode: "api_key", secret: "sk-real" });
  const { credentials, env } = vaultFor(db);
  expect(credentials.find((c) => c.name === "codex")!.value).toBe("sk-real");
  expect(env.OPENAI_API_KEY).not.toContain("sk-real");
  expect(filesFor(db)).toEqual({});
});

test("the ChatGPT login is renewed here, once, and a failed renewal keeps what worked", async () => {
  // Ten sandboxes each refreshing their own copy is what codex's CI guidance
  // warns against, so there is one refresher and it is this process.
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 9 * 24 * 3600_000).toISOString();
  expect(isStale(parseAuth(JSON.stringify({ last_refresh: fresh }))!)).toBe(false);
  expect(isStale(parseAuth(JSON.stringify({ last_refresh: old }))!)).toBe(true);
  // Never refreshed, or a date nothing can parse: assume it needs one.
  expect(isStale({})).toBe(true);
  expect(isStale({ last_refresh: "sometime last week" })).toBe(true);

  const before = { auth_mode: "chatgpt", tokens: { access_token: "old", refresh_token: "r1" }, last_refresh: old };
  const ok = await refresh(before, (async () =>
    new Response(JSON.stringify({ access_token: "new", refresh_token: "r2" }), { status: 200 })) as any);
  expect(accessToken(ok!)).toBe("new");
  // Rotated on use, so keeping the old one would work until it did not.
  expect(ok!.tokens!.refresh_token).toBe("r2");
  expect(isStale(ok!)).toBe(false);

  // A blip must not throw away a working login: the caller keeps what it had.
  expect(await refresh(before, (async () => new Response("nope", { status: 500 })) as any)).toBeNull();
  expect(await refresh(before, (async () => { throw new Error("offline"); }) as any)).toBeNull();
  expect(await refresh({ tokens: {} })).toBeNull();
});

test("the panel knows which runtimes it can log in for, and refuses the rest", () => {
  // Running the CLI beats reimplementing two OAuth flows against undocumented
  // client ids: both already print a URL, wait for the browser and hand back a
  // credential. Only the refusal is checked here — starting a real login opens
  // a browser and waits for a human, which is not something a test may do.
  expect(loginRuntimes().sort()).toEqual(["claude", "codex"]);

  const db = openMemory();
  const ctx = { db, bus: { live: () => {}, emit: () => {} }, sched: { tick: () => {} } } as unknown as Ctx;
  expect(startLogin(ctx, "nonesuch")).toBeNull();
  expect(loadAuth(db, "nonesuch")).toBeNull();
});
