import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { allowedHostPaths, coveredBy, restartServer } from "../../src/mech/sandbox/sandbox.ts";
import { preflight } from "../../src/mech/ops/preflight.ts";
import { serverAction, serverBackoffMs, SERVER_RESTART_CAP } from "../../src/mech/ops/watchdog.ts";
import { patchConfig, startPlan, waitUp } from "../../src/mech/sandbox/server.ts";
import { testContext } from "../support/test-context.ts";
import { tempDir } from "../support/temp.ts";

/**
 * The sandbox server is the one host dependency that runs containers, and it
 * fails in three ways that look identical from the panel.
 *
 * The silent one is the reason this file exists: a config whose
 * `allowed_host_paths` does not cover what we mount. The process is healthy,
 * nothing errors, creation may even succeed — and every container gets an empty
 * directory where the skills should be. That is a whole day of agents running
 * with no skills and nothing to see.
 */

function configWith(line: string): string {
  const dir = tempDir("orch-toml-");
  const path = join(dir, "sandbox.toml");
  writeFileSync(path, `[server]\napi_key = "k"\n\n[sandbox]\n# Example: allowed_host_paths = ["/nope"]\n${line}\n`);
  return path;
}

test("the server's own allowlist is read from its own config, and a comment is not it", () => {
  const path = configWith(`allowed_host_paths = ["/var/tmp/orch-cache", "/Users/me/.orch-cache"]`);
  process.env.OPENSANDBOX_CONFIG = path;
  try {
    const found = allowedHostPaths()!;
    expect(found.config).toBe(path);
    // The example line above it is commented out. Taking it would report an
    // allowlist the server is not using — the same trap `keyInConfig` has.
    expect(found.paths).toEqual(["/var/tmp/orch-cache", "/Users/me/.orch-cache"]);
  } finally {
    delete process.env.OPENSANDBOX_CONFIG;
  }
});

test("a mount is covered by a prefix directory, not by string equality", () => {
  const allowed = ["/var/tmp/orch-cache", "/Users/me/.orch-cache/"];
  expect(coveredBy(allowed, "/var/tmp/orch-cache/skills")).toBe(true);
  expect(coveredBy(allowed, "/var/tmp/orch-cache")).toBe(true);
  // A trailing slash in the config is the boss's to write however they like.
  expect(coveredBy(allowed, "/Users/me/.orch-cache/skills")).toBe(true);
  // Not a sibling that merely starts with the same characters.
  expect(coveredBy(allowed, "/var/tmp/orch-cache-other/skills")).toBe(false);
  expect(coveredBy(allowed, "/Users/me/elsewhere")).toBe(false);
});

test("drift is reported with the line to paste, not a description of it", async () => {
  // This is the whole value of the check: one executable sentence. A boss who
  // has to work out the TOML from prose is a boss who leaves it broken.
  const path = configWith(`allowed_host_paths = ["/var/tmp/orch-cache"]`);
  process.env.OPENSANDBOX_CONFIG = path;
  try {
    const checks = await preflight({
      db: openMemory(),
      sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
      skillsDir: "/Users/me/.orch-cache/skills",
      cacheDirs: { "/root/.bun/install/cache": "/Users/me/.orch-cache/bun" },
      probe: () => false,
      verify: async () => ({ ok: true, detail: "" }),
    });
    const c = checks.find((x) => x.name === "allowed_host_paths")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("/Users/me/.orch-cache/skills");
    // Both wanted paths, and what was already there, in one pasteable line.
    expect(c.fix).toContain(
      `allowed_host_paths = ["/var/tmp/orch-cache", "/Users/me/.orch-cache/skills", "/Users/me/.orch-cache/bun"]`,
    );

    const ok = await preflight({
      db: openMemory(),
      sandbox: { server: "127.0.0.1:9", apiKey: "", image: "x" },
      skillsDir: "/var/tmp/orch-cache/skills",
      probe: () => false,
      verify: async () => ({ ok: true, detail: "" }),
    });
    expect(ok.find((x) => x.name === "allowed_host_paths")!.ok).toBe(true);
  } finally {
    delete process.env.OPENSANDBOX_CONFIG;
  }
});

test("a server that is present is never restarted, whatever it is doing", () => {
  // The guarantee this policy exists for. "Present but refusing" — a bad key, a
  // crash loop — is indistinguishable from healthy at this level, and restarting
  // it is how a crash loop becomes a restart loop. So presence ends the question.
  const argv = ["uvx", "opensandbox-server", "--config", "/x.toml"];
  expect(serverAction(true, argv, 0, 1_000_000, 0)).toBe("none");
  expect(serverAction(true, argv, SERVER_RESTART_CAP, 1_000_000, 0)).toBe("none");

  // Absent, and we know how it was started: restart it.
  expect(serverAction(false, argv, 0, 1_000_000, 0)).toBe("restart");

  // Absent, but never seen running: we would be guessing at the command line,
  // and a guess starts a second, differently-configured server.
  expect(serverAction(false, null, 0, 1_000_000, 0)).toBe("none");
  expect(serverAction(false, [], 0, 1_000_000, 0)).toBe("none");

  // Backing off, and then giving up rather than trying forever.
  expect(serverAction(false, argv, 1, 0, 30_000)).toBe("none");
  expect(serverAction(false, argv, SERVER_RESTART_CAP, 1_000_000, 0)).toBe("give_up");
  expect(serverBackoffMs(1)).toBe(30_000);
  expect(serverBackoffMs(3)).toBeGreaterThan(serverBackoffMs(2));
});

const LIVE_SERVER = { pid: "42", argv: ["opensandbox-server"], config: null };

function stuckServer(kill: (signal: "SIGTERM" | "SIGKILL") => void) {
  let starts = 0;
  return {
    ops: {
      running: () => LIVE_SERVER,
      kill: (_pid: number, signal: "SIGTERM" | "SIGKILL") => kill(signal),
      sleep: async () => {},
      start: () => {
        starts++;
      },
    },
    starts: () => starts,
  };
}

test("a failed SIGKILL cannot be reported as a successful restart", async () => {
  const server = stuckServer((signal) => {
    if (signal === "SIGKILL") throw new Error("operation not permitted");
  });

  const error = await restartServer(LIVE_SERVER.argv, undefined, server.ops);

  expect(error).toContain("could not force-stop pid 42");
  expect(error).toContain("operation not permitted");
  expect(server.starts()).toBe(0);
});

test("a process still alive after SIGKILL blocks a second server", async () => {
  const server = stuckServer(() => {});

  const error = await restartServer(LIVE_SERVER.argv, undefined, server.ops);

  expect(error).toBe("pid 42 is still running after SIGKILL");
  expect(server.starts()).toBe(0);
});

test("a process stopped by SIGKILL is replaced exactly once", async () => {
  let alive = true;
  let starts = 0;
  const error = await restartServer(LIVE_SERVER.argv, undefined, {
    running: () => (alive ? LIVE_SERVER : null),
    kill: (_pid, signal) => {
      if (signal === "SIGKILL") alive = false;
    },
    sleep: async () => {},
    start: () => {
      starts++;
    },
  });

  expect(error).toBeNull();
  expect(starts).toBe(1);
});

/**
 * Starting one, and the three ways of not starting one.
 *
 * The rule is one-directional and the whole value is in the "no"s: a server we
 * did not start may be serving something else, and "I cannot drive it" is not
 * evidence that nobody can. Restarting there takes down whatever else was using
 * it, and from here that is indistinguishable from restarting the user's own
 * work.
 */

const HERE = "127.0.0.1:8080";

test("a server that is already there is handed back untouched, whatever state it is in", () => {
  for (const seen of [
    { kind: "ours", pid: "1" },
    { kind: "theirs", pid: "2" },
    { kind: "stuck", pid: "3", why: "密钥对不上" },
  ] as const) {
    expect(startPlan(seen, HERE, true)).toEqual(seen);
  }
});

test("without uvx there is nothing to start, and the reason already says so", () => {
  // opensandbox-server is a Python package. Reporting "could not start" over
  // this would hide the one command that fixes it.
  const down = { kind: "down", why: "没有 uvx —— opensandbox-server 是个 Python 包，装 uv 才起得来" } as const;
  expect(startPlan(down, HERE, false)).toEqual(down);
});

test("a remote address is never started locally, however silent it is", () => {
  // Pointed at a Tailscale peer or a cloud box, "nothing answers" means that
  // host is down. Spawning one here would bind a port nobody is asking about
  // and report success.
  const plan = startPlan({ kind: "down", why: "没在跑" }, "sandbox.tailnet.ts.net:8080", true);
  expect(plan.kind).toBe("down");
  expect(plan.kind === "down" && plan.why).toContain("不是本机地址");
});

test("every shape of a local address is startable, including the IPv6 loopback", () => {
  for (const addr of ["localhost:8080", "127.0.0.1:8080", "127.5.5.5:9", "[::1]:8080", "https://LOCALHOST:8443"]) {
    expect(startPlan({ kind: "down", why: "没在跑" }, addr, true).kind).toBe("start");
  }
});

/**
 * Waiting for one to come up, which is really waiting to find out why it did not.
 *
 * Watching the process as well as the port is the whole point: a server that
 * dies on a bad config dies in the first second, and polling alone would spend
 * the entire timeout before saying "cannot connect" — true, and not the reason.
 */

function waiting(dataDir: string, log?: string) {
  if (log !== undefined) writeFileSync(join(dataDir, "opensandbox-server.log"), log);
  const ctx = testContext();
  ctx.config = { ...ctx.config, dataDir };
  return ctx;
}

const never = async () => ({ kind: "none", why: "Unable to connect" }) as const;

test("a server that dies on its config is reported with what it printed, not with our probe", async () => {
  const dir = tempDir("orch-srv-");
  const ctx = waiting(dir, "pydantic_core.ValidationError: 1 validation error for AppConfig\n");
  const slept: number[] = [];

  const up = await waitUp(ctx, { exited: Promise.resolve(1) }, HERE, "k", 45_000, {
    probe: never,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  expect(up.ok).toBe(false);
  expect(up.why).toContain("exit 1");
  expect(up.why).toContain("ValidationError");
  // And it stops the moment the process is gone rather than sitting out the
  // whole 45 seconds on a process that is already dead.
  expect(slept).toEqual([]);
});

test("a process that died silently says that, rather than leaving a blank where the log goes", async () => {
  const ctx = waiting(tempDir("orch-srv-"));

  const up = await waitUp(ctx, { exited: Promise.resolve(2) }, HERE, "k", 45_000, {
    probe: never,
    sleep: async () => {},
  });

  expect(up.why).toContain("exit 2");
  expect(up.why).toContain("什么都没打印");
});

test("a server that never answers gives up at the deadline and says how long it waited", async () => {
  // Bounded, and it must stay bounded: this runs at boot and the settings page
  // waits on it.
  //
  // The deadline is real time — `waitUp` closes over `Date.now()`, and only its
  // `sleep` is injected — so this test costs whatever deadline it is given. 600ms
  // is the cheapest one that still rounds to the "等了 1 秒" below, and it was
  // 1200ms: the same two assertions for twice the wall clock.
  const ctx = waiting(tempDir("orch-srv-"), "Address already in use\n");
  let probes = 0;

  const up = await waitUp(ctx, { exited: new Promise<number>(() => {}) }, HERE, "k", 600, {
    probe: async () => {
      probes++;
      return { kind: "none", why: "Unable to connect" };
    },
    sleep: async () => {},
  });

  expect(up.ok).toBe(false);
  expect(up.why).toContain("等了 1 秒");
  expect(up.why).toContain("Address already in use");
  expect(probes).toBeGreaterThan(0);
});

test("a server holding somebody else's key is reported as that, not as unreachable", async () => {
  // The sentence this exists to stop: "起来了但驱动不了：Unable to connect",
  // which describes neither of the two things that were true.
  const ctx = waiting(tempDir("orch-srv-"));

  const up = await waitUp(ctx, { exited: Promise.resolve(0) }, HERE, "k", 5000, {
    probe: async () => ({ kind: "auth" }),
    sleep: async () => {},
  });

  expect(up.ok).toBe(false);
  expect(up.why).toContain("exit 0");
});

test("a server that comes up on a later probe is up, and the wait ends there", async () => {
  const ctx = waiting(tempDir("orch-srv-"));
  let n = 0;

  const up = await waitUp(ctx, { exited: new Promise<number>(() => {}) }, HERE, "k", 10_000, {
    probe: async () => (++n < 3 ? { kind: "none" as const, why: "no" } : { kind: "ok" as const }),
    sleep: async () => {},
  });

  expect(up).toEqual({ ok: true, why: "" });
  expect(n).toBe(3);
});

/**
 * The values we patch into a generated config.
 *
 * `init-config --example docker` renders the rest, because a config file is that
 * package's schema and not ours. These six are the ones that have to agree with
 * us, and two of them have already cost a day each.
 */

const EXAMPLE = [
  "[server]",
  'host = "0.0.0.0"',
  "port = 9999",
  '# api_key = "your-secret-api-key"',
  "",
  "[ingress]",
  'mode = "gateway"',
  "",
  "[egress]",
  'image = "opensandbox/egress:v1.1.4"',
  'mode = "direct"',
  "",
].join("\n");

test("the section a key lives in decides which one is written", () => {
  // `mode` appears in [ingress] and [egress], and a file-wide `^mode =` replaced
  // the ingress one with `dns+nft`. The server then refused to start:
  // "Input should be 'direct' or 'gateway'".
  const out = patchConfig(EXAMPLE, { host: "127.0.0.1", port: "8080", key: "k", allowed: ["/Users/me"] });

  expect(out).toContain('[ingress]\nmode = "gateway"');
  expect(out).toContain('mode = "dns+nft"');
  expect(out.match(/mode = "dns\+nft"/g)!.length).toBe(1);
});

test("a commented-out key is the key, not an absent one", () => {
  // The generated example ships `# api_key = "your-secret-api-key"`. Treating
  // that as absent appended a second line and left the server reading the
  // commented one — no key at all, while we sent one.
  const out = patchConfig(EXAMPLE, { host: "127.0.0.1", port: "8080", key: "orch-abc", allowed: [] });

  expect(out).toContain('api_key = "orch-abc"');
  expect(out).not.toContain("your-secret-api-key");
  expect(out.match(/api_key/g)!.length).toBe(1);
});

test("the address we will call is the address the server is told to bind", () => {
  const out = patchConfig(EXAMPLE, { host: "127.0.0.1", port: "8080", key: "k", allowed: [] });

  expect(out).toContain('host = "127.0.0.1"');
  expect(out).toContain("port = 8080");
  expect(out).not.toContain("0.0.0.0");
  // An address with no port at all still produces a valid file rather than
  // `port = NaN`, which the server rejects on load.
  expect(patchConfig(EXAMPLE, { host: "localhost", key: "k", allowed: [] })).toContain("port = 8080");
});

test("the egress image is pinned past the one that 403s every scoped fetch", () => {
  // v1.1.4 403s every scoped package fetch while a credential is bound, and the
  // packaged example may ship exactly that.
  const out = patchConfig(EXAMPLE, { host: "h", port: "1", key: "k", allowed: [] });

  expect(out).toContain('image = "opensandbox/egress:v1.1.6"');
  expect(out).not.toContain("v1.1.4");
});

test("a missing storage section is added rather than dropping the allowlist on the floor", () => {
  // This is the silent one. A path missing from `allowed_host_paths` does not
  // fail the mount — it delivers an empty directory, and the only symptom is
  // every agent having no skills.
  const out = patchConfig(EXAMPLE, { host: "h", port: "1", key: "k", allowed: ["/Users/me", "/var/tmp/orch-cache"] });

  expect(out).toContain('[storage]\nallowed_host_paths = ["/Users/me", "/var/tmp/orch-cache"]');
});
