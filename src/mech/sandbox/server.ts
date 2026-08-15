import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Ctx } from "../../api.ts";
import { loadAuth, SANDBOX_KEY, saveAuth } from "./auth.ts";
import { allowedHostPaths, coveredBy, runningServer, specFor } from "./sandbox.ts";

/**
 * Starting opensandbox-server, and knowing when not to.
 *
 * A user should need an environment, not a runbook. Every container this system
 * opens goes through one server process, and asking someone to start it by hand
 * in a second terminal before anything works is a setup step that exists only
 * because nothing was doing it for them.
 *
 * But it is a **shared, machine-wide** process. It may already be running, it may
 * be serving something else, and its config may be somebody's. So the rule is
 * narrow and one-directional:
 *
 *   absent            we start one, with our own config, and remember it is ours
 *   present, usable   we use it and never touch it — it may not be ours
 *   present, not      we report it and hand over a button. Never an automatic
 *                     restart: killing a process we did not start takes down
 *                     whatever else was using it, and "I cannot drive it" is not
 *                     evidence that nobody can.
 *
 * The third case is the one worth being strict about. A restart there is
 * indistinguishable, from here, from a restart of the user's own work.
 */

/** Recorded so a later boot can tell our process from one that was already there. */
const PID_KEY = "sandbox_server_pid";
const ARGV_KEY = "sandbox_server_argv";

export type ServerState =
  /** Running, drivable, and this orchestrator started it. */
  | { kind: "ours"; pid: string }
  /** Running and drivable, started by someone else. Left alone. */
  | { kind: "theirs"; pid: string }
  /** Running and not drivable. Reported, never restarted automatically. */
  | { kind: "stuck"; pid: string; why: string }
  /** We started one just now. */
  | { kind: "started"; pid: string; config: string }
  /** Nothing running and we could not start one. */
  | { kind: "down"; why: string };

const get = (ctx: Ctx, k: string): string | null =>
  ctx.db.query<{ v: string }, [string]>("SELECT v FROM setting WHERE k = ?").get(k)?.v ?? null;

const put = (ctx: Ctx, k: string, v: string | null): void => {
  if (v === null) ctx.db.run("DELETE FROM setting WHERE k = ?", [k]);
  else ctx.db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [k, v]);
};

/**
 * Can we actually drive it, rather than: is the port open.
 *
 * A server with an api_key we do not have answers on the socket and refuses
 * every real call, so "listening" is the wrong question and answering it green
 * is how a whole fleet 401s under a healthy-looking check.
 */
async function drivable(server: string, key: string): Promise<{ ok: boolean; why: string }> {
  try {
    const res = await fetch(`http://${server}/v1/sandboxes?page_size=1`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      // Short on purpose: this is a socket on this machine, so it answers
      // quickly or it is not there — and the settings page waits on it.
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) return { ok: true, why: "" };
    if (res.status === 401 || res.status === 403) return { ok: false, why: "服务器开了鉴权，我们的密钥它不认" };
    return { ok: false, why: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, why: String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

/** Where our own config lives when we are the one starting the server. */
export const ourConfigPath = (home = homedir()): string => join(home, ".orch-cache", "sandbox.toml");

/**
 * The config we start a server with.
 *
 * Written once and then left alone: a user who edits it should keep their edits,
 * and the only value that has to agree with us is the key. `allowed_host_paths`
 * is the one line that has bitten this project before — a path missing from it
 * does not fail loudly, it mounts an empty directory — so the staged skills
 * directory goes in at creation and `driftingPaths` reports it later if the
 * config and our mounts stop agreeing.
 */
export function writeConfig(ctx: Ctx, key: string, path = ourConfigPath()): string {
  if (existsSync(path)) return path;
  const [host, port] = (ctx.config.sandbox?.server ?? "127.0.0.1:8080").split(":");
  const skills = resolve(ctx.config?.skillsDir ?? join(homedir(), ".orch-cache/skills"));
  // The parent, not the directory itself: the server takes prefixes, and a
  // sibling cache directory added later should not need this file edited again.
  const allowed = [...new Set([dirname(skills), "/var/tmp/orch-cache"])];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# Written by orchestrator. Yours to edit — it is only created if absent.
[server]
host = "${host}"
port = ${Number(port) || 8080}
api_key = "${key}"
max_sandbox_timeout_seconds = 86400

[runtime]
type = "docker"

[storage]
allowed_host_paths = [${allowed.map((p) => `"${p}"`).join(", ")}]

[egress]
# v1.1.4 403s every scoped package fetch while a credential is bound (005).
image = "opensandbox/egress:v1.1.6"
mode = "dns+nft"
`,
    { mode: 0o600 },
  );
  return path;
}

/**
 * A key we can hand to a server we are about to start.
 *
 * Generated rather than left blank: an unauthenticated server on this machine is
 * one any local process can exec into, and the containers it holds are bound to
 * real credentials. Stored where every other secret is, so `connection()` finds
 * it without anyone copying anything.
 */
function ourKey(ctx: Ctx): string {
  const held = loadAuth(ctx.db, SANDBOX_KEY)?.secret;
  if (held) return held;
  const made = `orch-${crypto.randomUUID().replaceAll("-", "")}`;
  saveAuth(ctx.db, { runtime: SANDBOX_KEY, mode: "api_key", secret: made });
  return made;
}

/** Ready enough to create a sandbox, or the reason it never got there. */
async function waitUp(server: string, key: string, ms = 30_000): Promise<{ ok: boolean; why: string }> {
  const until = Date.now() + ms;
  let last = "no answer yet";
  while (Date.now() < until) {
    const r = await drivable(server, key);
    if (r.ok) return r;
    last = r.why;
    await Bun.sleep(400);
  }
  return { ok: false, why: last };
}

/**
 * What is there, without changing anything.
 *
 * Split from `ensureServer` because a GET must not start a process. The settings
 * page polls this, and the first version had the panel spawning a server as a
 * side effect of being looked at — which also hung the test that opens it.
 */
export async function inspectServer(ctx: Ctx): Promise<ServerState> {
  const server = ctx.config.sandbox?.server ?? "127.0.0.1:8080";
  const key = loadAuth(ctx.db, SANDBOX_KEY)?.secret || ctx.config.sandbox?.apiKey || "";
  const live = runningServer();
  if (live) {
    const r = await drivable(server, key);
    const mine = get(ctx, PID_KEY) === live.pid;
    if (r.ok) return mine ? { kind: "ours", pid: live.pid } : { kind: "theirs", pid: live.pid };
    return { kind: "stuck", pid: live.pid, why: r.why };
  }
  // Not visible to `ps` is not the same as absent: it may be on another machine
  // or in a container, and one that answers is one to use.
  if ((await drivable(server, key)).ok) return { kind: "theirs", pid: "?" };
  return { kind: "down", why: Bun.which("uvx") ? "没在跑" : "没有 uvx —— opensandbox-server 是个 Python 包，装 uv 才起得来" };
}

/**
 * Make sure there is a server, without ever taking one over.
 *
 * Called at boot and from the one button that says start. Safe to call again:
 * everything it does is conditional on what is actually running right now.
 */
export async function ensureServer(ctx: Ctx): Promise<ServerState> {
  const server = ctx.config.sandbox?.server ?? "127.0.0.1:8080";
  const key = loadAuth(ctx.db, SANDBOX_KEY)?.secret || ctx.config.sandbox?.apiKey || "";

  const live = runningServer();
  if (live) {
    const r = await drivable(server, key);
    // Ours only if we are the ones who recorded this pid. A pid recorded by a
    // previous boot still counts — the process outlives us and re-adopting it
    // is right — but a *different* pid means ours died and this is somebody's.
    const mine = get(ctx, PID_KEY) === live.pid;
    if (r.ok) return mine ? { kind: "ours", pid: live.pid } : { kind: "theirs", pid: live.pid };
    return { kind: "stuck", pid: live.pid, why: r.why };
  }

  // Nothing running. Before spawning: if a server would answer anyway, it is on
  // another machine or in a container and `ps` cannot see it — use it.
  if ((await drivable(server, key)).ok) return { kind: "theirs", pid: "?" };

  if (!Bun.which("uvx")) {
    return { kind: "down", why: "没有 uvx —— opensandbox-server 是个 Python 包，装 uv 才起得来" };
  }
  const startKey = ourKey(ctx);
  const config = writeConfig(ctx, startKey);
  const argv = ["uvx", "opensandbox-server", "--config", config];
  try {
    const p = Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] });
    p.unref();
    put(ctx, PID_KEY, String(p.pid));
    put(ctx, ARGV_KEY, JSON.stringify(argv));
    const up = await waitUp(server, startKey);
    if (!up.ok) return { kind: "down", why: `起来了但驱动不了：${up.why}` };
    return { kind: "started", pid: String(p.pid), config };
  } catch (e) {
    return { kind: "down", why: `起不来：${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
}

/** The argv we started it with, for the panel's restart button. Ours only. */
export function ourArgv(ctx: Ctx): string[] | null {
  const live = runningServer();
  if (!live || get(ctx, PID_KEY) !== live.pid) return null;
  try {
    const argv = JSON.parse(get(ctx, ARGV_KEY) ?? "[]");
    return Array.isArray(argv) && argv.length ? argv : live.argv;
  } catch {
    return live.argv;
  }
}

/**
 * Host paths our mounts need that the running server will not allow.
 *
 * The silent one. A mount of a path missing from `allowed_host_paths` does not
 * fail — it succeeds and delivers an empty directory, so the only symptom is
 * every agent having no skills while the process is healthy and nothing errors.
 */
export function driftingPaths(ctx: Ctx): { want: string[]; config: string } | null {
  const allowed = allowedHostPaths();
  if (!allowed) return null;
  const want = [
    resolve(ctx.config?.skillsDir ?? join(homedir(), ".orch-cache/skills")),
    ...Object.values(specFor(ctx, null).cacheDirs),
  ].filter((p) => p && !coveredBy(allowed.paths, p));
  return want.length ? { want: [...new Set(want)], config: allowed.config } : null;
}
