import { describe, expect, test } from "bun:test";
import { waitFor } from "@testing-library/dom";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { count } from "drizzle-orm";
import { makeApp } from "../../src/composition/api.ts";
import { runtime_auth } from "../../src/platform/persistence/schema.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import type { Json } from "../../src/contracts/json.ts";
import { setTrailers } from "../../src/mech/git/ghlogin.ts";
import { newEnough, preflight, report } from "../../src/mech/ops/preflight.ts";
import {
  CODEX_HOME,
  decoy,
  filesFor,
  isAuthFailure,
  listAuth,
  loadAuth,
  bindSandboxKey,
  RuntimeAuthSchema,
  sandboxKeyFor,
  SANDBOX_KEY,
  saveAuth,
  probeHosts,
  vaultFor,
  wrongShape,
} from "../../src/mech/sandbox/auth.ts";
import { accessToken, isStale, parseAuth, REFRESH_HOME, renew } from "../../src/mech/sandbox/chatgpt.ts";
import { DEVICE_CODE_TTL_MS } from "../../src/mech/sandbox/login.ts";
import * as fx from "../support/factories.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { testContext } from "../support/test-context.ts";

const REAL = `sk-ant-oat01-${"R".repeat(80)}`;
const ClaudeSettings = z.object({ includeCoAuthoredBy: z.boolean() });
const DeviceLoginResponse = z.object({ code: z.string(), url: z.string(), expiresAt: z.number() });
const CodexAuthFile = z.object({ tokens: z.object({ id_token: z.string(), access_token: z.string() }) });

test("the real value never leaves the process except into the vault", async () => {
  const db = await openMemory();
  await saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: REAL });

  // What the settings page sees.
  const shown = await listAuth(db);
  expect(shown[0]!.hint).toBe(`…${REAL.slice(-6)}`);
  expect(JSON.stringify(shown)).not.toContain(REAL);

  // What the sandbox sees: a token the CLI will accept as well-formed and the
  // API will reject. Measured (005): claude does not validate locally, so this
  // reaches the server and comes back 401 — which is what makes the swap work.
  const { credentials, env } = await vaultFor(db);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(decoy("claude", "oauth_token"));
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(REAL);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN!).toStartWith("sk-ant-oat01-");

  // And what the sidecar gets, bound to the one host it is for.
  expect(credentials).toEqual([{ name: "claude", value: REAL, hosts: ["api.anthropic.com"] }]);
});

test("an api key goes in the header the API wants, and can name its own endpoint", async () => {
  const db = await openMemory();
  await saveAuth(db, {
    runtime: "claude",
    mode: "api_key",
    secret: "sk-ant-api03-x",
    baseUrl: "https://proxy.example.com/v1",
  });
  const { credentials, env } = await vaultFor(db);
  expect(credentials[0]!.header).toBe("x-api-key");
  // The compatible endpoint has to be bound too, or the injection never fires
  // for the host the CLI is actually talking to.
  expect(credentials[0]!.hosts).toContain("proxy.example.com");
  expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example.com/v1");
  expect(env.ANTHROPIC_API_KEY).not.toContain("sk-ant-api03-x");
});

test("re-saving replaces rather than accumulating", async () => {
  const db = await openMemory();
  await saveAuth(db, { runtime: "codex", mode: "api_key", secret: "one" });
  await saveAuth(db, { runtime: "codex", mode: "api_key", secret: "two" });
  expect((await listAuth(db)).length).toBe(1);
  expect((await loadAuth(db, "codex"))!.secret).toBe("two");
});

describe("an expired credential is recognised from what the CLI actually prints", () => {
  test.each([
    // Verbatim from a real run against a synthetic token.
    ["Failed to authenticate. API Error: 401 OAuth access token is invalid.", true],
    ["401 invalid_api_key", true],
    // A model refusing a request is not a credential problem, and pausing the
    // group over it would stop work for something a retry fixes.
    ["the tests failed: 3 assertions", false],
    ["rate_limit_error: 429", false],
  ])("%s is a credential failure: %p", (line, failure) => {
    expect(isAuthFailure(line)).toBe(failure);
  });
});

test("preflight names what is missing and how to fix it, rather than degrading", async () => {
  const db = await openMemory();
  const checks = await preflight({
    db,
    sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
    probe: () => false,
    // Injected: whether a provider still accepts a token is a network fact, and
    // a test that asks the network is a test that fails on a train.
    verify: async () => ({ ok: true, detail: "能用" }),
  });
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  // The fix for a missing server is a uvx command, so a machine without uv has
  // two problems that look like one. Asserted as one map, so a failure names the
  // check that started passing rather than a line number.
  expect({
    docker: by.docker!.ok,
    "uv / python": by["uv / python"]!.ok,
    "opensandbox-server": by["opensandbox-server"]!.ok,
    "credential:claude": by["credential:claude"]!.ok,
  }).toEqual({ docker: false, "uv / python": false, "opensandbox-server": false, "credential:claude": false });
  // Every failure carries the command that fixes it. Without that this is a
  // list of nouns, and the failure mode it replaces — agents that silently do
  // nothing — is already hard enough to read.
  for (const c of checks) if (!c.ok) expect(c.fix!.length).toBeGreaterThan(10);
  expect(report(checks)).toContain("opensandbox-server");

  await saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: REAL });
  const after = await preflight({
    db,
    sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
    probe: () => false,
    verify: async () => ({ ok: true, detail: "能用" }),
  });
  expect(after.find((c) => c.name === "credential:claude")!.ok).toBe(true);
});

/**
 * The egress sidecar version is checked, because its failure reads as a project
 * problem.
 *
 * v1.1.4 is what `opensandbox-server init-config --example docker` writes, and
 * with a credential bound it 403s every scoped package fetch. The symptom is
 * "this project cannot install its dependencies", which nobody traces back to a
 * sidecar version — so the version is checked rather than the symptom.
 */
describe("the egress sidecar version is checked", () => {
  test.each([
    ["v1.1.4", false],
    ["v1.1.6", true],
    ["v1.2.0", true],
    ["v2.0.0", true],
    // Not ours to judge: a tag we cannot parse is somebody's deliberate choice.
    ["latest", true],
  ])("%s is new enough: %p", (tag, ok) => {
    expect(newEnough(tag)).toBe(ok);
  });
});

test("a ChatGPT login is refreshed on the host, and the sandbox only gets a decoy", async () => {
  // codex has exactly two non-interactive credential paths: an API key, or an
  // auth.json in $CODEX_HOME. Its own CI guidance says to put the real file on
  // the runner — and, in the same breath, not to share it across concurrent
  // jobs. A fleet is ten concurrent jobs on one login, so the file stays here
  // and the sandbox gets something shaped like it.
  const db = await openMemory();
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
  await saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: real });

  const files = await filesFor(db);
  const written = files[`${CODEX_HOME}/auth.json`]!;
  expect(written).not.toContain("REAL-ACCESS");
  expect(written).not.toContain("REAL-REFRESH");
  // The one that used to travel: a signed JWT identifying the account is a token,
  // and it was passed through untouched next to two carefully faked ones.
  expect(written).not.toContain("REAL-ID-TOKEN");
  // Still shaped like a JWT, or anything that parses it decides the login is bad.
  const writtenAuth = CodexAuthFile.parse(JSON.parse(written));
  expect(writtenAuth.tokens.id_token.split(".")).toHaveLength(3);
  // Shaped like a login, or codex will not start.
  expect(writtenAuth.tokens.access_token.length).toBeGreaterThan(20);
  // And told to read the file rather than the OS keychain.
  expect(files[`${CODEX_HOME}/config.toml`]).toContain("file");

  // Nothing for the environment either: this one is a file plus an injection.
  const { credentials, env } = await vaultFor(db);
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
  const src = await Bun.file(new URL("../../src/application/executor.ts", import.meta.url)).text();
  expect(src).not.toContain("absorbCodexHome");
  expect(src).not.toContain(`\${CODEX_HOME}/auth.json`);
});

test("an api key for codex goes to the sidecar like everything else", async () => {
  const db = await openMemory();
  await saveAuth(db, { runtime: "codex", mode: "api_key", secret: "sk-real" });
  const { credentials, env } = await vaultFor(db);
  expect(credentials.find((c) => c.name === "codex")!.value).toBe("sk-real");
  expect(env.OPENAI_API_KEY).not.toContain("sk-real");
  // No credential file, which is the point: an API key is bound in the vault and
  // nothing about it is written into the container. The one file that is always
  // there is Claude Code's own settings, which carries no secret.
  expect(Object.keys(await filesFor(db))).toEqual(["/root/.claude/settings.json"]);
});

test("Claude Code's own co-author trailer is a switch of its own", async () => {
  // Left alone the CLI appends `Co-Authored-By: Claude` to commits it makes
  // itself — on the commits an agent wrote by hand rather than the ones this
  // orchestrator squashes — and nothing in the panel could reach it.
  const db = await openMemory();
  const read = async () => ClaudeSettings.parse(JSON.parse((await filesFor(db))["/root/.claude/settings.json"]!));
  expect((await read()).includeCoAuthoredBy).toBe(true);

  // Not the git one: which tool wrote the diff and what this project puts in its
  // history are different questions, and somebody can want one without the other.
  await setTrailers(db, { coauthor: false });
  expect((await read()).includeCoAuthoredBy).toBe(true);

  await setTrailers(db, { claudeCoauthor: false });
  expect((await read()).includeCoAuthoredBy).toBe(false);
});

test("the ChatGPT login is renewed here, once, and by codex rather than by us", async () => {
  // Ten sandboxes each refreshing their own copy is what codex's CI guidance
  // warns against, so there is one refresher and it is this process. It renews
  // by making the real CLI do it: posting the refresh token ourselves would
  // work and would be our code presenting itself as the official client.
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 9 * 24 * 3600_000).toISOString();
  const fresher = new Date(Date.now() + 1000).toISOString();
  // Never refreshed, or a date nothing can parse: assume it needs one.
  expect({
    fresh: isStale(parseAuth(JSON.stringify({ last_refresh: fresh }))!),
    old: isStale(parseAuth(JSON.stringify({ last_refresh: old }))!),
    "never refreshed": isStale({}),
    unparseable: isStale({ last_refresh: "sometime last week" }),
  }).toEqual({ fresh: false, old: true, "never refreshed": true, unparseable: true });

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
  const src = readFileSync(new URL("../../src/mech/sandbox/login.ts", import.meta.url).pathname, "utf8");
  expect(src).not.toMatch(/Bun\.spawn/);
  // And the CLI names appear only as arguments to a container exec.
  for (const line of src.split("\n")) {
    if (!/\b(claude|codex)\b/.test(line)) continue;
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue; // prose
    expect(line).not.toMatch(/spawn|execFile|execSync/);
  }
});

test("the sandbox server key is stored like a secret, not in the committed yaml", async () => {
  // Two ends have to agree and only one is ours. It is not a model credential —
  // nothing binds it at a sidecar — but it is still a secret, so it lives in the
  // same store rather than in config/default.yaml, which is committed.
  const db = await openMemory();
  await saveAuth(db, { runtime: SANDBOX_KEY, mode: "api_key", secret: "generated-key" });

  // Nothing tries to inject it: it is absent from the bindings table.
  const { credentials, env } = await vaultFor(db);
  expect(credentials.find((c) => c.name === SANDBOX_KEY)).toBeUndefined();
  expect(JSON.stringify(env)).not.toContain("generated-key");
  // And the settings page sees a tail, like every other secret.
  expect((await listAuth(db)).find((r) => r.runtime === SANDBOX_KEY)!.hint).toBe("…ed-key");
});

test("a secret that cannot be right is refused before it is stored", () => {
  // The one that actually happened: the login URL pasted into the token box. It
  // saved cleanly, the page said configured, and every turn afterwards failed
  // with a 401 that reads like an expired subscription.
  expect(
    wrongShape({ runtime: "claude", mode: "oauth_token", secret: "https://claude.com/cai/oauth/authorize?code=true" }),
  ).toContain("is a URL, not a credential");
  expect(wrongShape({ runtime: "claude", mode: "oauth_token", secret: "sk-ant-api03-x" })).toContain("sk-ant-oat01-");
  expect(wrongShape({ runtime: "claude", mode: "api_key", secret: "sk-proj-x" })).toContain("sk-ant-");
  expect(wrongShape({ runtime: "codex", mode: "api_key", secret: "not-a-key" })).toContain("sk-");
  expect(wrongShape({ runtime: "codex", mode: "chatgpt", secret: "{}" })).toContain("refresh_token");
  expect(wrongShape({ runtime: "codex", mode: "chatgpt", secret: "half a file" })).toContain("JSON");
  expect(wrongShape({ runtime: "claude", mode: "oauth_token", secret: "  " })).toBe("empty");

  // And the shapes that are right.
  expect(wrongShape({ runtime: "claude", mode: "oauth_token", secret: `sk-ant-oat01-${"A".repeat(40)}` })).toBeNull();
  expect(wrongShape({ runtime: "codex", mode: "api_key", secret: "sk-abc" })).toBeNull();
  expect(
    wrongShape({ runtime: "codex", mode: "chatgpt", secret: JSON.stringify({ tokens: { refresh_token: "r" } }) }),
  ).toBeNull();
});

test("runtime and mode are one contract at the route and database boundaries", async () => {
  const db = await openMemory();
  const app = makeApp(await testContext({ db }));

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
  expect((await db.select({ n: count() }).from(runtime_auth))[0]!.n).toBe(0);

  const valid = await app(
    new Request("http://x/api/v1/auth", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ runtime: "codex", mode: "api_key", secret: "sk-valid" }),
    }),
  );
  expect(valid.status).toBe(200);
  expect((await loadAuth(db, "codex"))?.mode).toBe("api_key");
  const cleared = await app(
    new Request("http://x/api/v1/auth", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ runtime: "codex", clear: true }),
    }),
  );
  expect(cleared.status).toBe(200);
  expect(await loadAuth(db, "codex")).toBeNull();

  for (const runtime of ["github", "claude"]) {
    await fx.on(db).runtimeAuth.create({ runtime, mode: "chatgpt", secret: "dead", updated_at: 1 });
  }
  expect(await loadAuth(db, "github")).toBeNull();
  expect(await loadAuth(db, "claude")).toBeNull();
  expect(await listAuth(db)).toEqual([]);
});

test("a chatgpt login is judged by the expiry it carries, without a request", async () => {
  // The refresh token is what matters and it is not ours to test; the access
  // token says when it dies, and codex rotates it from the host. Checking that
  // offline is what keeps the settings page from costing a round trip per open.
  const db = await openMemory();
  const segment = (value: Json) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (exp: number) => `${segment({ alg: "none", typ: "JWT" })}.${segment({ exp })}.eA`;
  const auth = (exp: number) => JSON.stringify({ tokens: { refresh_token: "r", access_token: jwt(exp) } });

  await saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: auth(Math.floor(Date.now() / 1000) + 86_400 * 9) });
  const good = await preflight({ db, sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" }, probe: () => false });
  expect(good.find((c) => c.name === "credential:codex")!.ok).toBe(true);

  await saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: auth(Math.floor(Date.now() / 1000) - 60) });
  const dead = await preflight({ db, sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" }, probe: () => false });
  const row = dead.find((c) => c.name === "credential:codex")!;
  expect(row.ok).toBe(false);
  expect(row.detail).toContain("expired — sign in again");
});

test("the codex device login shows a code with its link, and stores what the container wrote", async () => {
  // Nothing installed on this machine: `codex login --device-auth` runs in the
  // utility container, prints a URL and a one-time code, and writes the refresh
  // token there — the one credential no container with an agent in it may hold.
  //
  // The panel's half is the pair. A link on its own opens a page asking for a
  // code the boss does not have.
  const db = await openMemory();
  const sandbox = fakeSandbox((cmd) =>
    cmd.includes("codex login") ? { out: "1. Open https://chatgpt.com/device\n2. Enter code T5M2-76TFM\n" } : {},
  );
  sandbox.files.set(`${REFRESH_HOME}/auth.json`, JSON.stringify({ tokens: { refresh_token: "REAL" } }));
  const ctx = await testContext({ db, sandbox });
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
  //
  // `waitFor` rather than a hand-rolled `for` with a `Bun.sleep` in it. The loop
  // it replaces polled fifty times and then simply carried on, so a device flow
  // that never completed failed on the *next* assertion — `toEqual` against
  // `null`, which reads as "the row is wrong" rather than "the row never
  // arrived". This one throws where the waiting happened, and it is already a
  // dependency: `@testing-library/dom` is what `@testing-library/react` is
  // built on, and `waitFor` itself touches no DOM.
  await waitFor(async () => expect(await loadAuth(db, "codex")).not.toBeNull());
  expect(await loadAuth(db, "codex")).toEqual({
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
  const db = await openMemory();
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
  expect(names(inside)).toContain("host environment");

  // The one check that still means something is reachability — and its fix has
  // to stop telling a container to start a server it cannot start.
  const server = (c: Awaited<ReturnType<typeof preflight>>) => c.find((x) => x.name === "opensandbox-server")!;
  expect(server(host).fix).toContain("uvx opensandbox-server");
  expect(server(inside).fix).toContain("ORCH_SANDBOX_SERVER");
});

test("the stored sandbox key does not follow the address to a place it was never accepted by", async () => {
  // `sandbox.server` is a settings knob — the panel writes it through
  // `sandbox-server/addr` and through the `sandbox.server` row, which is not in
  // `SETTING_DENIALS` — while the key is stored once and reused. Four call
  // sites resolved the two independently and sent the stored key to whatever
  // the address currently said, so moving the address was enough to have the
  // orchestrator hand the key over. The suppression on `reachable` asserted the
  // opposite; this is what makes the assertion true.
  const db = await openMemory();
  await saveAuth(db, {
    runtime: SANDBOX_KEY,
    mode: "api_key",
    secret: "orch-secret",
    baseUrl: "http://127.0.0.1:8080",
  });

  expect(await sandboxKeyFor(db, "127.0.0.1:8080")).toBe("orch-secret");
  // Written as a URL, read as an authority: a trailing slash is not a different server.
  expect(await sandboxKeyFor(db, " 127.0.0.1:8080 ")).toBe("orch-secret");
  expect(await sandboxKeyFor(db, "evil.example:8080")).toBe("");
  expect(await sandboxKeyFor(db, "127.0.0.1:9090")).toBe("");

  // The config/environment value still goes, and is meant to: it is not stored
  // here, and whoever writes it also writes the address in the same file.
  expect(await sandboxKeyFor(db, "evil.example:8080", "from-env")).toBe("from-env");
});

test("a key stored before the address travelled with it is bound at startup, once", async () => {
  const db = await openMemory();
  // No `baseUrl` — every row written before this rule existed looks like this,
  // and refusing to send it would take a working install offline on upgrade.
  await saveAuth(db, { runtime: SANDBOX_KEY, mode: "api_key", secret: "orch-old" });
  expect(await sandboxKeyFor(db, "127.0.0.1:8080")).toBe("");

  await bindSandboxKey(db, "127.0.0.1:8080");
  expect(await sandboxKeyFor(db, "127.0.0.1:8080")).toBe("orch-old");
  expect(await sandboxKeyFor(db, "evil.example:8080")).toBe("");

  // Once: a later boot with a moved address must not re-bind a key that already
  // has one, or the whole guard would reset itself every restart.
  await bindSandboxKey(db, "evil.example:8080");
  expect(await sandboxKeyFor(db, "evil.example:8080")).toBe("");
  expect((await loadAuth(db, SANDBOX_KEY))?.baseUrl).toBe("http://127.0.0.1:8080");
});

/**
 * What "the host is offline" is actually asking.
 *
 * `runtime_auth` holds more than model providers: `sandbox` is the local server,
 * with a `base_url` of `http://127.0.0.1:8080`. That branch ran before the check
 * for a bound runtime, so the row put **127.0.0.1** into the probe list — and with
 * no provider configured it was the only entry. Since any one host answering is
 * enough, "is the internet up" was decided by whether anything listens on localhost
 * **443**. Nothing does; the panel announced 宿主断网了 on a machine that was online.
 */
/**
 * The origin, not the hostname, for the reason this list is derived rather than
 * configured: a self-hosted gateway on `http://gw.internal:8443` was being probed
 * at `https://gw.internal:443`.
 */
describe("the network probe asks the providers, at the addresses they were given", () => {
  test("a local sandbox server is not a provider and stays out of the list", async () => {
    const db = await openMemory();
    await saveAuth(db, { runtime: "sandbox", mode: "api_key", secret: "k", baseUrl: "http://127.0.0.1:8080" });
    // Empty is the right answer with nothing configured, and `probe` reads it as
    // online: there is no wall to detect, and `credentialMissing` covers the rest.
    expect(await probeHosts(db)).toEqual([]);
  });

  test("a provider's own base_url keeps its scheme and port", async () => {
    const db = await openMemory();
    await saveAuth(db, { runtime: "claude", mode: "api_key", secret: "k", baseUrl: "http://gw.internal:8443/v1" });
    expect(await probeHosts(db)).toEqual(["http://gw.internal:8443"]);
  });

  test("a provider with no base_url is probed at its documented hosts", async () => {
    const db = await openMemory();
    await saveAuth(db, { runtime: "codex", mode: "chatgpt", secret: "k" });
    expect(await probeHosts(db)).toEqual(["https://api.openai.com", "https://chatgpt.com"]);
  });

  test("github is bound for cloning, so a repo host being down does not stop every agent", async () => {
    const db = await openMemory();
    await saveAuth(db, { runtime: "github", mode: "api_key", secret: "k" });
    expect(await probeHosts(db)).toEqual([]);
  });
});
