import { expect, test } from "bun:test";
import { openMemory } from "../src/db.ts";
import { decoy, isAuthFailure, listAuth, loadAuth, saveAuth, vaultFor } from "../src/mech/auth.ts";
import { newEnough, preflight, report } from "../src/mech/preflight.ts";

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
