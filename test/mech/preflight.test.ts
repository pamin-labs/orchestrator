import { expect, test } from "bun:test";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { saveAuth } from "../../src/mech/sandbox/auth.ts";
import { credentialVerdict, modelProbe, preflight } from "../../src/mech/ops/preflight.ts";
import { MESSAGES, MESSAGE_IDS } from "../../src/platform/text/messages.generated.ts";

test("a ChatGPT login is called out when it is old, not when the host lacks codex", async () => {
  // This used to check `probe("codex")`. Since 007 step 7 the renewal runs real
  // codex inside the **utility container** — codex is in the agent image because
  // turns run it — so the host needs nothing, and a check asserting otherwise was
  // reporting a requirement that had stopped existing.
  //
  // What can still go wrong is the login going stale with nothing able to renew
  // it, and that failure is silent and hours late: every codex turn 401s looking
  // like an expired account.
  const db = await openMemory();
  const withLogin = async (lastRefresh: string) => {
    await saveAuth(db, {
      runtime: "codex",
      mode: "chatgpt",
      secret: JSON.stringify({ tokens: { refresh_token: "r" }, last_refresh: lastRefresh }),
    });
    return preflight({
      db,
      sandbox: { server: "http://127.0.0.1:1", apiKey: "", image: "x" },
      // No codex on this host, and that is now fine.
      probe: (bin) => bin !== "codex",
      verify: async () => ({ ok: true, said: { id: "check.cred.accepted" } }),
    });
  };

  const stale = (await withLogin(new Date(Date.now() - 9 * 24 * 3600_000).toISOString())).find(
    (c) => c.name === "codex-refresher",
  )!;
  expect(stale.ok).toBe(false);
  expect(stale.fix).toContain("API key");

  const fresh = (await withLogin(new Date().toISOString())).find((c) => c.name === "codex-refresher")!;
  expect(fresh.ok).toBe(true);
  // And it says where the renewal happens, so nobody re-adds the host requirement.
  expect(fresh.detail).toContain("utility container");
});

test("the other credential modes need nothing on this host", async () => {
  // A pasted `sk-ant-oat01-` is good for a year and an API key does not expire,
  // so neither has anything to renew. Only the ChatGPT pair does.
  const db = await openMemory();
  await saveAuth(db, { runtime: "codex", mode: "api_key", secret: "sk-x" });
  const checks = await preflight({
    db,
    sandbox: { server: "http://127.0.0.1:1", apiKey: "", image: "x" },
    probe: () => false,
    verify: async () => ({ ok: true, said: { id: "check.cred.accepted" } }),
  });
  expect(checks.find((c) => c.name === "codex-refresher")).toBeUndefined();
});

test("docker installed but not started is not 'running'", async () => {
  // Measured: `DOCKER_HOST=unix:///nonexistent.sock docker --version` exits 0.
  // So the version probe — which is what this check used — reported "running"
  // for Docker Desktop installed and never launched, the most common first-run
  // state there is. The boss then got a blocker saying "多半是 docker 没起，
  // 自检那栏会说是哪个" and a self-check saying it was up.
  const asked: string[][] = [];
  const checks = await preflight({
    db: await openMemory(),
    sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
    // The daemon is what is asked about, so only `info` decides.
    probe: (bin, argv = ["--version"]) => {
      asked.push([bin, ...argv]);
      return bin === "docker" && argv[0] === "--version";
    },
    verify: async () => ({ ok: true, said: { id: "check.cred.accepted" } }),
  });
  const docker = checks.find((c) => c.name === "docker")!;
  expect(asked).toContainEqual(["docker", "info"]);
  expect(docker.ok).toBe(false);
  // And the two failures are told apart, because they send the boss to
  // different places: a download, or one click.
  expect(docker.detail).toContain("installed, but the daemon is not answering");
  expect(docker.fix).toContain("Start Docker Desktop");
});

/**
 * The credential self-check, split from the call that makes it.
 *
 * Both halves have their own way of being wrong and neither is visible from the
 * panel: the wrong header 401s exactly like the wrong key, and reading any
 * non-2xx as "your token is bad" sends the boss to re-paste a credential that
 * was fine while a gateway was down.
 */

test("claude's two credential kinds travel in their own headers", () => {
  // An hour was spent once on a message saying a key was not accepted when the
  // key was never presented — the same class of bug, one module over.
  const key = modelProbe("claude", { runtime: "claude", mode: "api_key", secret: "sk-ant-x" });
  expect(key.headers["x-api-key"]).toBe("sk-ant-x");
  expect(key.headers.Authorization).toBeUndefined();
  expect(key.headers["anthropic-version"]).toBe("2023-06-01");

  const oauth = modelProbe("claude", { runtime: "claude", mode: "oauth_token", secret: "sk-ant-oat01-x" });
  expect(oauth.headers.Authorization).toBe("Bearer sk-ant-oat01-x");
  expect(oauth.headers["x-api-key"]).toBeUndefined();
  // The version header is required whichever way the credential travels.
  expect(oauth.headers["anthropic-version"]).toBe("2023-06-01");
});

test("each runtime asks its own provider unless a gateway is configured", () => {
  expect(modelProbe("claude", { runtime: "claude", mode: "api_key", secret: "k" }).url).toBe(
    "https://api.anthropic.com/v1/models?limit=1",
  );
  expect(modelProbe("codex", { runtime: "codex", mode: "api_key", secret: "k" }).url).toBe(
    "https://api.openai.com/v1/models?limit=1",
  );
  // Hand-edited yaml, so a trailing slash is normal — and `https://gw//v1/models`
  // is a 404 on some proxies, which would then read as a broken credential.
  expect(
    modelProbe("codex", { runtime: "codex", mode: "api_key", secret: "k", baseUrl: "https://gw.example.com/" }).url,
  ).toBe("https://gw.example.com/v1/models?limit=1");
  // codex over a gateway still carries Bearer; only claude's api_key mode differs.
  expect(
    modelProbe("codex", { runtime: "codex", mode: "api_key", secret: "k", baseUrl: "https://gw/" }).headers
      .Authorization,
  ).toBe("Bearer k");
});

test("only 401 and 403 are read as the credential being refused", () => {
  expect(credentialVerdict(200)).toEqual({ ok: true, said: { id: "check.cred.accepted" } });
  expect({ "401": credentialVerdict(401).ok, "403": credentialVerdict(403).ok }).toEqual({
    "401": false,
    "403": false,
  });

  // Everything else is unverified, not refused. A 500 or a 429 from a gateway
  // says nothing about the token, and calling it bad costs the boss a re-paste
  // and leaves the real outage unreported. The status is a **value** in the
  // sentence rather than text spliced into it, so the panel can say it in nine
  // languages and still name the number.
  for (const status of [429, 500, 502, 404]) {
    const v = credentialVerdict(status);
    expect(v.ok).toBe(true);
    expect(v.said).toEqual({ id: "check.cred.unverified", values: { status } });
  }
});

/**
 * The other half of `lang.test.ts`'s placeholder guard, which covers `ev.` only.
 *
 * It has to be checked on the rows, not the output: ICU renders an unfilled
 * `{path}` as the empty string, so `no skills ticked at ` reads like a sentence
 * somebody wrote. The evidence is already gone by the time there is a string.
 */
/**
 * `values` is the union of what `makeCheck`'s call sites in `preflight.ts` pass.
 * `makeCheck` is the only place a `Check` is built, so a name missing here is a
 * name no check can fill.
 */
test("no placeholder in a host check's sentence goes unfilled", () => {
  const values = new Set([
    "mode",
    "status",
    "days",
    "error",
    "server",
    "good",
    "stale",
    "image",
    "count",
    "path",
    "config",
    "missing",
    "line",
  ]);
  const holes = (row: string): string[] => [...row.matchAll(/\{\s*(\w+)/g)].map((m) => m[1]!);
  const unfilled = MESSAGE_IDS.filter((id) => id.startsWith("check.")).flatMap((id) =>
    holes(MESSAGES.en[id])
      .filter((hole) => !values.has(hole))
      .map((hole) => `${id}: {${hole}}`),
  );
  expect(unfilled).toEqual([]);
});
