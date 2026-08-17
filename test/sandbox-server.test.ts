import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../src/platform/persistence/database.ts";
import { allowedHostPaths, coveredBy, restartServer } from "../src/mech/sandbox/sandbox.ts";
import { preflight } from "../src/mech/ops/preflight.ts";
import { serverAction, serverBackoffMs, SERVER_RESTART_CAP } from "../src/mech/ops/watchdog.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "orch-toml-"));
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
