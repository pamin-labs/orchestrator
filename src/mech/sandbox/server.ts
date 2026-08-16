import { errText } from "../util/text.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Ctx } from "../../ctx.ts";
import { loadAuth, SANDBOX_KEY, saveAuth } from "./auth.ts";
import { putSetting } from "../../settings.ts";
import {
  allowedHostPaths,
  coveredBy,
  runningServer,
  SANDBOX_API_KEY_HEADER,
  serverAddr,
  splitAddr,
  specFor,
} from "./sandbox.ts";
import { jsonOr } from "../util/text.ts";
import { z } from "zod";

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
  | { kind: "down"; why: string; log?: string };

const get = (ctx: Ctx, k: string): string | null =>
  ctx.db.query<{ v: string }, [string]>("SELECT v FROM setting WHERE k = ?").get(k)?.v ?? null;

const put = (ctx: Ctx, k: string, v: string | null): void => {
  if (v === null) ctx.db.run("DELETE FROM setting WHERE k = ?", [k]);
  else ctx.db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [k, v]);
};

/**
 * Four answers, not two.
 *
 * "Can we drive it" was one boolean, and it collapsed the two cases that need
 * different actions. A server on the port that refuses our key is **not** a
 * server that is down: starting a second one just fails to bind, dies, and then
 * the health probe talks to the first one and reports 401 — which is how a
 * clean machine produced *"起来了但驱动不了：Unable to connect"*, a sentence
 * describing neither of the two things that were true.
 *
 * `auth` is also the one case we must never act on. A server holding a key we
 * were not given is, by construction, somebody else's.
 */
type Probe =
  | { kind: "ok" }
  /** Answering, and refusing our key. Someone else's server. */
  | { kind: "auth" }
  /** Answering with something else. Alive, and not usable. */
  | { kind: "http"; status: number }
  /** Nothing on the port. */
  | { kind: "none"; why: string };

async function probe(server: string, key: string): Promise<Probe> {
  try {
    const { protocol, authority } = splitAddr(server);
    const res = await fetch(`${protocol}://${authority}/v1/sandboxes?page_size=1`, {
      // `OPEN-SANDBOX-API-KEY`, not `Authorization: Bearer` — the server reads
      // that one header and nothing else (`middleware/auth.py`). Sending the
      // wrong one is indistinguishable from having the wrong key: 401 either
      // way, and it cost an hour reading a message that said the key was not
      // accepted when the key was never presented.
      headers: key ? { [SANDBOX_API_KEY_HEADER]: key } : {},
      // Short on purpose: this is a socket on this machine, so it answers
      // quickly or it is not there — and the settings page waits on it.
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) return { kind: "ok" };
    if (res.status === 401 || res.status === 403) return { kind: "auth" };
    return { kind: "http", status: res.status };
  } catch (e) {
    return { kind: "none", why: errText(e, 120) };
  }
}

/**
 * What to tell the boss. One line, and it has to name the thing to do next.
 *
 * The first version was three sentences of reasoning — where the server came
 * from, why we did not touch it, both ways out — set as a paragraph above the
 * two controls that are the ways out. docs/design/ui.md's rule applies here as much as
 * anywhere: say it once, and let the control next to it do the explaining.
 */
function say(p: Probe, server: string): string {
  switch (p.kind) {
    case "auth":
      return `${server} 上那个服务器不是我们起的，密钥对不上 —— 填它的 api_key，或者换个地址。`;
    case "http":
      return `${server} 上有东西在应答，但不是沙盒服务器（HTTP ${p.status}）—— 换个地址。`;
    case "none":
      return p.why;
    default:
      return "";
  }
}

/** Where our own config lives when we are the one starting the server. */
const ourConfigPath = (home = homedir()): string => join(home, ".orch-cache", "sandbox.toml");

/**
 * Set one key inside one TOML section.
 *
 * Section-aware, and that is the whole point: a blanket `^mode =` replaced
 * `[ingress] mode` with `dns+nft` and the server refused to start —
 * *"Input should be 'direct' or 'gateway'"* — because `mode` appears in two
 * sections and the first one wins a file-wide match.
 *
 * Commented lines count as the key. The generated example ships
 * `# api_key = "your-secret-api-key"`, and treating that as absent left the
 * server with no key at all while we sent one.
 *
 * Appends to the section when the key is genuinely not there, and appends the
 * section too when that is missing. Still not a TOML parser: six known keys.
 */
export function setIn(toml: string, section: string, key: string, line: string): string {
  const lines = toml.split("\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const head = /^[ \t]*\[([^\]]+)\]/.exec(lines[i]!)?.[1]?.trim();
    if (head === undefined) continue;
    if (start < 0 && head === section) start = i;
    else if (start >= 0) {
      end = i;
      break;
    }
  }
  if (start < 0) return `${toml.replace(/\n*$/, "")}\n\n[${section}]\n${line}\n`;

  const at = /^[ \t]*#?[ \t]*KEY[ \t]*=/.source.replace("KEY", key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(at);
  for (let i = start + 1; i < end; i++) {
    if (re.test(lines[i]!)) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  lines.splice(start + 1, 0, line);
  return lines.join("\n");
}

/**
 * The config we start a server with, generated by the server itself.
 *
 * Hand-writing it was wrong and failed the first time it ran on a clean machine:
 *
 *   pydantic_core.ValidationError: 1 validation error for AppConfig
 *   runtime.execd_image
 *     Field required
 *
 * A config file is that package's schema, not ours, and every required field it
 * adds in a later version would break this the same way. `init-config --example
 * docker` renders one from the packaged example, so the parts we do not care
 * about stay correct without anyone tracking them.
 *
 * Three values are then patched in, and only three — the ones that have to agree
 * with *us*:
 *
 *   api_key             or the server we just started refuses every call we make
 *   allowed_host_paths  the silent one: a path missing from it does not fail,
 *                       it mounts an empty directory, and the only symptom is
 *                       every agent having no skills
 *   egress image        v1.1.4 403s every scoped package fetch while a
 *                       credential is bound (005), and the example may ship it
 *
 * Regex rather than a TOML parser, like `keyInConfig` and `allowedHostPaths`
 * above: three known keys, one line each, and a dependency for that is a
 * dependency for that.
 *
 * Created once. A user who edits it keeps their edits.
 */
async function writeConfig(ctx: Ctx, key: string, path = ourConfigPath()): Promise<string> {
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  const gen = Bun.spawnSync(["uvx", "opensandbox-server", "init-config", path, "--example", "docker"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!existsSync(path)) {
    throw new Error(
      `opensandbox-server init-config failed: ${(gen.stderr.toString() || gen.stdout.toString()).trim().slice(-300)}`,
    );
  }

  const [host, port] = serverAddr(ctx).split(":");
  const skills = resolve(ctx.config.skillsDir);
  // The parent, not the directory itself: the server matches prefixes, and a
  // sibling cache directory added later should not need this file edited again.
  const allowed = [...new Set([dirname(skills), "/var/tmp/orch-cache"])];

  let toml = readFileSync(path, "utf8");
  for (const [section, k, line] of [
    ["server", "host", `host = "${host}"`],
    ["server", "port", `port = ${Number(port) || 8080}`],
    ["server", "api_key", `api_key = "${key}"`],
    ["storage", "allowed_host_paths", `allowed_host_paths = [${allowed.map((p) => `"${p}"`).join(", ")}]`],
    ["egress", "image", `image = "opensandbox/egress:v1.1.6"`],
    ["egress", "mode", `mode = "dns+nft"`],
  ] as const) {
    toml = setIn(toml, section, k, line);
  }

  writeFileSync(
    path,
    `# api_key / host / port / allowed_host_paths / egress set by orchestrator.\n` +
      `# Everything else is opensandbox-server's own example. Yours to edit — only written if absent.\n${toml}`,
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

/** Where the server we start writes its own output. The only thing that can say why. */
export const serverLogPath = (ctx: Ctx): string => join(resolve(ctx.config.dataDir), "opensandbox-server.log");

/** The end of it, which is where a startup failure says what it was. */
export function serverLogTail(ctx: Ctx, lines = 12): string {
  try {
    return readFileSync(serverLogPath(ctx), "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Ready enough to create a sandbox, or the reason it never got there.
 *
 * Watches the process as well as the port. A server that exits on a bad config
 * exits in the first second, and polling alone would spend the whole timeout on
 * a process that is already gone before saying "cannot connect" — which is true,
 * and is not the reason.
 */
async function waitUp(
  ctx: Ctx,
  proc: { exited: Promise<number> },
  server: string,
  key: string,
  ms = 45_000,
): Promise<{ ok: boolean; why: string }> {
  let dead: number | null = null;
  void proc.exited.then((code) => (dead = code));
  const until = Date.now() + ms;
  let last = "还没应答";
  while (Date.now() < until) {
    const r = await probe(server, key);
    if (r.kind === "ok") return { ok: true, why: "" };
    last = say(r, server);
    if (dead !== null) {
      // Its own words, not ours. "Unable to connect" is what we observed; the
      // log is what happened, and without it this reports the symptom of a
      // process that died of something specific it already printed.
      const tail = serverLogTail(ctx);
      return { ok: false, why: `它自己退了（exit ${dead}）${tail ? `：\n${tail}` : "，而且什么都没打印"}` };
    }
    await Bun.sleep(400);
  }
  const tail = serverLogTail(ctx);
  return { ok: false, why: `等了 ${Math.round(ms / 1000)} 秒还是 ${last}${tail ? `。它打印的是：\n${tail}` : ""}` };
}

/**
 * What is there, without changing anything.
 *
 * Split from `ensureServer` because a GET must not start a process. The settings
 * page polls this, and the first version had the panel spawning a server as a
 * side effect of being looked at — which also hung the test that opens it.
 */
export async function inspectServer(ctx: Ctx): Promise<ServerState> {
  const server = serverAddr(ctx);
  const key = loadAuth(ctx.db, SANDBOX_KEY)?.secret || ctx.config.sandbox.apiKey;
  const live = runningServer();
  const p = await probe(server, key);

  if (p.kind === "ok") {
    // Ours only if we recorded this pid. A pid from a previous boot still counts
    // — the process outlives us — but a different one means ours died.
    const mine = !!live && get(ctx, PID_KEY) === live.pid;
    return mine ? { kind: "ours", pid: live!.pid } : { kind: "theirs", pid: live?.pid ?? "?" };
  }
  // Answering at all means the address is taken, whether or not `ps` can see by
  // what. Reported, never restarted.
  if (p.kind !== "none") return { kind: "stuck", pid: live?.pid ?? "?", why: say(p, server) };
  // Nothing answers. `ps` is deliberately not allowed to overrule that: it
  // matches command lines, and a command line that *mentions* the server is not
  // the server. Trusting it here meant one stray `pkill -f opensandbox-server`
  // in a shell made us report "already running" and never start one. The port is
  // the fact; `ps` only ever fills in a pid for a server that answered.
  return {
    kind: "down",
    why: !Bun.which("uvx")
      ? "没有 uvx —— opensandbox-server 是个 Python 包，装 uv 才起得来"
      : live
        ? `没在跑（有个进程看着像它，pid ${live.pid}，但 ${server} 不应答 —— 可能正在启动，也可能挂了）`
        : "没在跑",
  };
}

/**
 * Make sure there is a server, without ever taking one over.
 *
 * Called at boot and from the one button that says start. Safe to call again:
 * everything it does is conditional on what is actually running right now.
 */
export async function ensureServer(ctx: Ctx): Promise<ServerState> {
  const server = serverAddr(ctx);
  const seen = await inspectServer(ctx);
  // Anything other than "nothing is there" is somebody's, or ours already.
  // Spawning into a taken address binds nothing, dies, and leaves the probe
  // talking to whatever was already listening — which is what made the first
  // failure unreadable.
  if (seen.kind !== "down") return seen;
  if (!Bun.which("uvx")) return seen;
  // Only ever start one for an address on this machine. Pointed at a Tailscale
  // peer or a cloud box, "nothing answers" means that host is down — spawning a
  // local server would bind a port nobody is asking about and report success.
  const { authority } = splitAddr(server);
  const host = authority.replace(/:\d+$/, "").toLowerCase();
  if (!(host === "localhost" || host.startsWith("127.") || host === "::1" || host === "[::1]")) {
    return { kind: "down", why: `${server} 不应答 —— 那不是本机地址，起不了，得去那台机器上看。` };
  }

  const startKey = ourKey(ctx);
  let config: string;
  try {
    config = await writeConfig(ctx, startKey);
  } catch (e) {
    return { kind: "down", why: `写不出配置：${errText(e, 200)}` };
  }
  const argv = ["uvx", "opensandbox-server", "--config", config];
  try {
    // Its output goes to a file, not to /dev/null. Discarding it was the reason
    // a failed start could only be reported as "cannot connect" — true, useless,
    // and one layer above the thing that had already said what was wrong.
    const log = serverLogPath(ctx);
    mkdirSync(dirname(log), { recursive: true });
    const out = Bun.file(log);
    const p = Bun.spawn(argv, { stdout: out, stderr: out, stdin: "ignore" });
    p.unref();
    put(ctx, PID_KEY, String(p.pid));
    put(ctx, ARGV_KEY, JSON.stringify(argv));
    const up = await waitUp(ctx, p, server, startKey);
    if (!up.ok) return { kind: "down", why: up.why, log };
    return { kind: "started", pid: String(p.pid), config };
  } catch (e) {
    return { kind: "down", why: `起不来：${errText(e, 160)}` };
  }
}

/**
 * Point us at a different server. Empty clears the override back to the default.
 *
 * Through the settings table like every other config path. It had a row of its
 * own (`sandbox_server_addr`) from before there was one, and migration 039 moved
 * it — a value with two homes has a precedence order that lives only in code.
 */
export function setServerAddr(ctx: Ctx, addr: string): string | null {
  return putSetting(ctx.db, ctx.config, "sandbox.server", addr.trim() || null);
}

/** The argv we started it with, for the panel's restart button. Ours only. */
export function ourArgv(ctx: Ctx): string[] | null {
  const live = runningServer();
  if (!live || get(ctx, PID_KEY) !== live.pid) return null;
  const argv = jsonOr(get(ctx, ARGV_KEY), z.array(z.string()), []);
  return argv.length ? argv : live.argv;
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
  const want = [resolve(ctx.config.skillsDir), ...Object.values(specFor(ctx, null).cacheDirs)].filter(
    (p) => p && !coveredBy(allowed.paths, p),
  );
  return want.length ? { want: [...new Set(want)], config: allowed.config } : null;
}
