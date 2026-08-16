import { expect, test } from "bun:test";
import { openMemory } from "../src/db.ts";
import { saveAuth } from "../src/mech/sandbox/auth.ts";
import { preflight } from "../src/mech/ops/preflight.ts";

test("a ChatGPT login is called out when it is old, not when the host lacks codex", async () => {
  // This used to check `probe("codex")`. Since 007 step 7 the renewal runs real
  // codex inside the **utility container** — codex is in the agent image because
  // turns run it — so the host needs nothing, and a check asserting otherwise was
  // reporting a requirement that had stopped existing.
  //
  // What can still go wrong is the login going stale with nothing able to renew
  // it, and that failure is silent and hours late: every codex turn 401s looking
  // like an expired account.
  const db = openMemory();
  const withLogin = (lastRefresh: string) => {
    saveAuth(db, {
      runtime: "codex",
      mode: "chatgpt",
      secret: JSON.stringify({ tokens: { refresh_token: "r" }, last_refresh: lastRefresh }),
    });
    return preflight({
      db,
      sandbox: { server: "http://127.0.0.1:1", apiKey: "", image: "x" },
      // No codex on this host, and that is now fine.
      probe: (bin) => bin !== "codex",
      verify: async () => ({ ok: true, detail: "ok" }),
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
  expect(fresh.detail).toContain("工具容器");
});

test("the other credential modes need nothing on this host", async () => {
  // A pasted `sk-ant-oat01-` is good for a year and an API key does not expire,
  // so neither has anything to renew. Only the ChatGPT pair does.
  const db = openMemory();
  saveAuth(db, { runtime: "codex", mode: "api_key", secret: "sk-x" });
  const checks = await preflight({
    db,
    sandbox: { server: "http://127.0.0.1:1", apiKey: "", image: "x" },
    probe: () => false,
    verify: async () => ({ ok: true, detail: "ok" }),
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
    db: openMemory(),
    sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
    // The daemon is what is asked about, so only `info` decides.
    probe: (bin, argv = ["--version"]) => {
      asked.push([bin, ...argv]);
      return bin === "docker" && argv[0] === "--version";
    },
    verify: async () => ({ ok: true, detail: "" }),
  });
  const docker = checks.find((c) => c.name === "docker")!;
  expect(asked).toContainEqual(["docker", "info"]);
  expect(docker.ok).toBe(false);
  // And the two failures are told apart, because they send the boss to
  // different places: a download, or one click.
  expect(docker.detail).toContain("没启动");
  expect(docker.fix).toContain("启动");
});
