import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { makeApp } from "../src/api.ts";
import { openMemory } from "../src/db.ts";
import type { Json } from "../src/contracts/json.ts";
import { setTrailers } from "../src/mech/git/ghlogin.ts";
import { newEnough, preflight, report } from "../src/mech/ops/preflight.ts";
import {
  CODEX_HOME,
  decoy,
  filesFor,
  isAuthFailure,
  listAuth,
  loadAuth,
  RuntimeAuthSchema,
  SANDBOX_KEY,
  saveAuth,
  vaultFor,
  wrongShape,
} from "../src/mech/sandbox/auth.ts";
import { accessToken, isStale, parseAuth, REFRESH_HOME, renew } from "../src/mech/sandbox/chatgpt.ts";
import { DEVICE_CODE_TTL_MS } from "../src/mech/sandbox/login.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { testContext } from "./test-context.ts";

const REAL = `sk-ant-oat01-${"R".repeat(80)}`;
const ClaudeSettings = z.object({ includeCoAuthoredBy: z.boolean() });
const DeviceLoginResponse = z.object({ code: z.string(), url: z.string(), expiresAt: z.number() });

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
  expect(credentials).toEqual([{ name: "claude", value: REAL, hosts: ["api.anthropic.com"] }]);
});

test("an api key goes in the header the API wants, and can name its own endpoint", () => {
  const db = openMemory();
  saveAuth(db, {
    runtime: "claude",
    mode: "api_key",
    secret: "sk-ant-api03-x",
    baseUrl: "https://proxy.example.com/v1",
  });
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
    // Injected: whether a provider still accepts a token is a network fact, and
    // a test that asks the network is a test that fails on a train.
    verify: async () => ({ ok: true, detail: "能用" }),
  });
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  expect(by.docker!.ok).toBe(false);
  // The fix for a missing server is a uvx command, so a machine without uv has
  // two problems that look like one.
  expect(by["uv / python"]!.ok).toBe(false);
  expect(by["opensandbox-server"]!.ok).toBe(false);
  expect(by["credential:claude"]!.ok).toBe(false);
  // Every failure carries the command that fixes it. Without that this is a
  // list of nouns, and the failure mode it replaces — agents that silently do
  // nothing — is already hard enough to read.
  for (const c of checks) if (!c.ok) expect(c.fix!.length).toBeGreaterThan(10);
  expect(report(checks)).toContain("opensandbox-server");

  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: REAL });
  const after = await preflight({
    db,
    sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
    probe: () => false,
    verify: async () => ({ ok: true, detail: "能用" }),
  });
  expect(after.find((c) => c.name === "credential:claude")!.ok).toBe(true);
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
    tokens: {
      access_token: "REAL-ACCESS",
      refresh_token: "REAL-REFRESH",
      id_token: "REAL-ID-TOKEN",
      account_id: "acct",
    },
    last_refresh: new Date().toISOString(),
  });
  saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: real });

  const files = filesFor(db);
  const written = files[`${CODEX_HOME}/auth.json`]!;
  expect(written).not.toContain("REAL-ACCESS");
  expect(written).not.toContain("REAL-REFRESH");
  // The one that used to travel: a signed JWT identifying the account is a token,
  // and it was passed through untouched next to two carefully faked ones.
  expect(written).not.toContain("REAL-ID-TOKEN");
  // Still shaped like a JWT, or anything that parses it decides the login is bad.
  expect(JSON.parse(written).tokens.id_token.split(".")).toHaveLength(3);
  // Shaped like a login, or codex will not start.
  expect(JSON.parse(written).tokens.access_token.length).toBeGreaterThan(20);
  // And told to read the file rather than the OS keychain.
  expect(files[`${CODEX_HOME}/config.toml`]).toContain("file");

  // Nothing for the environment either: this one is a file plus an injection.
  const { credentials, env } = vaultFor(db);
  expect(credentials.find((c) => c.name === "codex")).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
});

test("nothing reads a credential back out of a sandbox", async () => {
  // There used to be a write-back: after every codex turn the host read
  // `$CODEX_HOME/auth.json` out of the container and stored it. But that file is
  // the decoy this very module writes, and `decoyAuth` stamps `last_refresh` with
  // now precisely so codex will not refresh it — so the read-back could only ever
  // find our own fake, and it stored it over the real refresh token, which
  // nothing else holds. The whole fleet then 401'd against `decoy-aaa…`.
  //
  // Asserted on the source, because the failure was two locally-correct pieces
  // (the decoy is written; a rotated file is absorbed) with nothing joining them.
  const src = await Bun.file(new URL("../src/runtime/executor.ts", import.meta.url)).text();
  expect(src).not.toContain("absorbCodexHome");
  expect(src).not.toContain(`${"$"}{CODEX_HOME}/auth.json`);
});

test("an api key for codex goes to the sidecar like everything else", () => {
  const db = openMemory();
  saveAuth(db, { runtime: "codex", mode: "api_key", secret: "sk-real" });
  const { credentials, env } = vaultFor(db);
  expect(credentials.find((c) => c.name === "codex")!.value).toBe("sk-real");
  expect(env.OPENAI_API_KEY).not.toContain("sk-real");
  // No credential file, which is the point: an API key is bound in the vault and
  // nothing about it is written into the container. The one file that is always
  // there is Claude Code's own settings, which carries no secret.
  expect(Object.keys(filesFor(db))).toEqual(["/root/.claude/settings.json"]);
});

test("Claude Code's own co-author trailer is a switch of its own", () => {
  // Left alone the CLI appends `Co-Authored-By: Claude` to commits it makes
  // itself — on the commits an agent wrote by hand rather than the ones this
  // orchestrator squashes — and nothing in the panel could reach it.
  const db = openMemory();
  const read = () => ClaudeSettings.parse(JSON.parse(filesFor(db)["/root/.claude/settings.json"]!));
  expect(read().includeCoAuthoredBy).toBe(true);

  // Not the git one: which tool wrote the diff and what this project puts in its
  // history are different questions, and somebody can want one without the other.
  setTrailers(db, { coauthor: false });
  expect(read().includeCoAuthoredBy).toBe(true);

  setTrailers(db, { claudeCoauthor: false });
  expect(read().includeCoAuthoredBy).toBe(false);
});

test("the ChatGPT login is renewed here, once, and by codex rather than by us", async () => {
  // Ten sandboxes each refreshing their own copy is what codex's CI guidance
  // warns against, so there is one refresher and it is this process. It renews
  // by making the real CLI do it: posting the refresh token ourselves would
  // work and would be our code presenting itself as the official client.
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 9 * 24 * 3600_000).toISOString();
  const fresher = new Date(Date.now() + 1000).toISOString();
  expect(isStale(parseAuth(JSON.stringify({ last_refresh: fresh }))!)).toBe(false);
  expect(isStale(parseAuth(JSON.stringify({ last_refresh: old }))!)).toBe(true);
  // Never refreshed, or a date nothing can parse: assume it needs one.
  expect(isStale({})).toBe(true);
  expect(isStale({ last_refresh: "sometime last week" })).toBe(true);

  // The refresher's own CODEX_HOME, inside the utility container: renewing must
  // not touch the boss's own terminal login, and must not be a group's.
  const files = new Map<string, string>([
    [
      `${REFRESH_HOME}/auth.json`,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "old" },
        last_refresh: old,
      }),
    ],
  ]);
  const io = (run: () => Promise<boolean>) => ({
    read: async (p: string) => files.get(p) ?? null,
    write: async (p: string, d: string) => void files.set(p, d),
    remove: async (p: string) => void files.delete(p),
    run,
  });
  const wrote = (value: Json) => files.set(`${REFRESH_HOME}/auth.json`, JSON.stringify(value));

  // The CLI ran and rewrote the file: that is a renewal.
  const done = await renew(
    io(async () => {
      wrote({ auth_mode: "chatgpt", tokens: { access_token: "new" }, last_refresh: fresh });
      return true;
    }),
  );
  expect(accessToken(done!)).toBe("new");

  // It ran and changed nothing: not a renewal, and the caller keeps what it had
  // rather than storing a regression.
  expect(await renew(io(async () => true))).toBeNull();

  // It exited non-zero *and* the file moved on. That is a renewal too, and the
  // one this had to learn: in the utility container the sidecar replaces the
  // Authorization header with the token we already held, so the API call after a
  // successful refresh can 401 while `auth.json` is already the new login.
  // Reading the exit code instead of the file threw the refresh away.
  const salvaged = await renew(
    io(async () => {
      wrote({ auth_mode: "chatgpt", tokens: { access_token: "newer" }, last_refresh: fresher });
      return false;
    }),
  );
  expect(accessToken(salvaged!)).toBe("newer");
});

test("no login runs a CLI on this machine any more", () => {
  // Running the real CLI beats reimplementing two OAuth flows against
  // undocumented client ids — both already print a URL, wait for a browser and
  // hand back a credential, and forging that exchange is how an account gets
  // banned. What changed is only *where*: both now run in the utility
  // container, which is the one with no agent, no mailbox and no `orch` in it.
  //
  // Read as text, because that is the only thing that can see it: a
  // `Bun.spawn(["claude", …])` added back here would typecheck, pass every
  // other test, and quietly reintroduce a second credential path — the boss's
  // own CLI session instead of `runtime_auth`.
  const src = readFileSync(new URL("../src/mech/sandbox/login.ts", import.meta.url).pathname, "utf8");
  expect(src).not.toMatch(/Bun\.spawn/);
  // And the CLI names appear only as arguments to a container exec.
  for (const line of src.split("\n")) {
    if (!/\b(claude|codex)\b/.test(line)) continue;
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue; // prose
    expect(line).not.toMatch(/spawn|execFile|execSync/);
  }
});

test("the sandbox server key is stored like a secret, not in the committed yaml", () => {
  // Two ends have to agree and only one is ours. It is not a model credential —
  // nothing binds it at a sidecar — but it is still a secret, so it lives in the
  // same store rather than in config/default.yaml, which is committed.
  const db = openMemory();
  saveAuth(db, { runtime: SANDBOX_KEY, mode: "api_key", secret: "generated-key" });

  // Nothing tries to inject it: it is absent from the bindings table.
  const { credentials, env } = vaultFor(db);
  expect(credentials.find((c) => c.name === SANDBOX_KEY)).toBeUndefined();
  expect(JSON.stringify(env)).not.toContain("generated-key");
  // And the settings page sees a tail, like every other secret.
  expect(listAuth(db).find((r) => r.runtime === SANDBOX_KEY)!.hint).toBe("…ed-key");
});

test("a secret that cannot be right is refused before it is stored", () => {
  // The one that actually happened: the login URL pasted into the token box. It
  // saved cleanly, the page said configured, and every turn afterwards failed
  // with a 401 that reads like an expired subscription.
  expect(
    wrongShape({ runtime: "claude", mode: "oauth_token", secret: "https://claude.com/cai/oauth/authorize?code=true" }),
  ).toContain("网址");
  expect(wrongShape({ runtime: "claude", mode: "oauth_token", secret: "sk-ant-api03-x" })).toContain("sk-ant-oat01-");
  expect(wrongShape({ runtime: "claude", mode: "api_key", secret: "sk-proj-x" })).toContain("sk-ant-");
  expect(wrongShape({ runtime: "codex", mode: "api_key", secret: "not-a-key" })).toContain("sk-");
  expect(wrongShape({ runtime: "codex", mode: "chatgpt", secret: "{}" })).toContain("refresh_token");
  expect(wrongShape({ runtime: "codex", mode: "chatgpt", secret: "half a file" })).toContain("JSON");
  expect(wrongShape({ runtime: "claude", mode: "oauth_token", secret: "  " })).toBe("空的");

  // And the shapes that are right.
  expect(wrongShape({ runtime: "claude", mode: "oauth_token", secret: `sk-ant-oat01-${"A".repeat(40)}` })).toBeNull();
  expect(wrongShape({ runtime: "codex", mode: "api_key", secret: "sk-abc" })).toBeNull();
  expect(
    wrongShape({ runtime: "codex", mode: "chatgpt", secret: JSON.stringify({ tokens: { refresh_token: "r" } }) }),
  ).toBeNull();
});

test("runtime and mode are one contract at the route and database boundaries", async () => {
  const db = openMemory();
  const app = makeApp(testContext({ db }));

  for (const body of [
    { runtime: "github", mode: "chatgpt", secret: "not a GitHub token" },
    { runtime: "claude", mode: "chatgpt", secret: JSON.stringify({ tokens: { refresh_token: "r" } }) },
  ]) {
    expect(RuntimeAuthSchema.safeParse(body).success).toBe(false);
    const response = await app(
      new Request("http://x/api/v1/auth", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
  }
  expect(db.query<{ n: number }, []>("SELECT count(*) n FROM runtime_auth").get()!.n).toBe(0);

  const valid = await app(
    new Request("http://x/api/v1/auth", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ runtime: "codex", mode: "api_key", secret: "sk-valid" }),
    }),
  );
  expect(valid.status).toBe(200);
  expect(loadAuth(db, "codex")?.mode).toBe("api_key");
  const cleared = await app(
    new Request("http://x/api/v1/auth", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ runtime: "codex", clear: true }),
    }),
  );
  expect(cleared.status).toBe(200);
  expect(loadAuth(db, "codex")).toBeNull();

  db.run(
    "INSERT INTO runtime_auth (runtime, mode, secret, updated_at) VALUES ('github', 'chatgpt', 'dead', 1), ('claude', 'chatgpt', 'dead', 1)",
  );
  expect(loadAuth(db, "github")).toBeNull();
  expect(loadAuth(db, "claude")).toBeNull();
  expect(listAuth(db)).toEqual([]);
});

test("a chatgpt login is judged by the expiry it carries, without a request", async () => {
  // The refresh token is what matters and it is not ours to test; the access
  // token says when it dies, and codex rotates it from the host. Checking that
  // offline is what keeps the settings page from costing a round trip per open.
  const db = openMemory();
  const segment = (value: Json) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (exp: number) => `${segment({ alg: "none", typ: "JWT" })}.${segment({ exp })}.eA`;
  const auth = (exp: number) => JSON.stringify({ tokens: { refresh_token: "r", access_token: jwt(exp) } });

  saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: auth(Math.floor(Date.now() / 1000) + 86_400 * 9) });
  const good = await preflight({ db, sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" }, probe: () => false });
  expect(good.find((c) => c.name === "credential:codex")!.ok).toBe(true);

  saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: auth(Math.floor(Date.now() / 1000) - 60) });
  const dead = await preflight({ db, sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" }, probe: () => false });
  const row = dead.find((c) => c.name === "credential:codex")!;
  expect(row.ok).toBe(false);
  expect(row.detail).toContain("过期");
});

test("the codex device login shows a code with its link, and stores what the container wrote", async () => {
  // Nothing installed on this machine: `codex login --device-auth` runs in the
  // utility container, prints a URL and a one-time code, and writes the refresh
  // token there — the one credential no container with an agent in it may hold.
  //
  // The panel's half is the pair. A link on its own opens a page asking for a
  // code the boss does not have.
  const db = openMemory();
  const sandbox = fakeSandbox((cmd) =>
    cmd.includes("codex login") ? { out: "1. Open https://chatgpt.com/device\n2. Enter code T5M2-76TFM\n" } : {},
  );
  sandbox.files.set(`${REFRESH_HOME}/auth.json`, JSON.stringify({ tokens: { refresh_token: "REAL" } }));
  const ctx = testContext({ db, sandbox });
  const app = makeApp(ctx);

  const r = await app(
    new Request("http://x/api/v1/auth/codex/device", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    }),
  );
  expect(r.status).toBe(200);
  const b = DeviceLoginResponse.parse(await r.json());
  expect(b.code).toBe("T5M2-76TFM");
  expect(b.url).toBe("https://chatgpt.com/device");
  // codex's own expiry, not a second number kept in step by hand.
  expect(b.expiresAt - Date.now()).toBeGreaterThan(DEVICE_CODE_TTL_MS - 10_000);
  expect(b.expiresAt - Date.now()).toBeLessThanOrEqual(DEVICE_CODE_TTL_MS);

  // No completion route: the credential row is the confirmation.
  for (let i = 0; i < 50 && !loadAuth(db, "codex"); i++) await Bun.sleep(10);
  expect(loadAuth(db, "codex")).toEqual({
    runtime: "codex",
    mode: "chatgpt",
    secret: JSON.stringify({ tokens: { refresh_token: "REAL" } }),
    baseUrl: undefined,
  });

  // Single-flight: a second click hands back the same pair rather than printing
  // a second code, which would invalidate the first.
  const again = await app(
    new Request("http://x/api/v1/auth/codex/device", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    }),
  );
  expect(z.object({ code: z.string() }).parse(await again.json()).code).toBe("T5M2-76TFM");
});

test("in a container, preflight stops answering questions about somebody else's machine", async () => {
  // Observed after the first `docker run` of the server image: docker `not
  // reachable`, `no uvx on PATH`, `no opensandbox/egress image pulled` — three
  // red rows about a deployment that was working, each with a fix (`brew install
  // uv`) for a host the process cannot see. Those are facts about the machine
  // running the sandbox server, and when the orchestrator ships as an image that
  // machine is somebody else's.
  const db = openMemory();
  const input = {
    db,
    sandbox: { server: "127.0.0.1:9", apiKey: "", image: "ghcr.io/pamin-labs/orch-agent:latest" },
    probe: () => false,
    verify: async () => ({ ok: true, detail: "能用" }),
  };
  const host = await preflight({ ...input, contained: false });
  const inside = await preflight({ ...input, contained: true });
  const names = (c: Awaited<ReturnType<typeof preflight>>) => c.map((x) => x.name);

  for (const n of ["docker", "uv / python", "egress sidecar"]) {
    expect(names(host)).toContain(n);
    expect(names(inside)).not.toContain(n);
  }
  // Said once rather than dropped silently: somebody reading this pane should
  // learn where those questions went, not wonder whether they are still asked.
  expect(names(inside)).toContain("宿主环境");

  // The one check that still means something is reachability — and its fix has
  // to stop telling a container to start a server it cannot start.
  const server = (c: Awaited<ReturnType<typeof preflight>>) => c.find((x) => x.name === "opensandbox-server")!;
  expect(server(host).fix).toContain("uvx opensandbox-server");
  expect(server(inside).fix).toContain("ORCH_SANDBOX_SERVER");
});
