import { errText } from "../../platform/process/text.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Ctx } from "../../mech/ctx.ts";
import { loadAuth, sandboxKeyFor, SANDBOX_KEY, saveAuth } from "./auth.ts";
import { putSetting } from "../../platform/config/settings.ts";
import { readSetting, writeSetting } from "../../platform/persistence/database.ts";
import {
  allowedHostPaths,
  coveredBy,
  runningServer,
  SANDBOX_API_KEY_HEADER,
  serverAddr,
  splitAddr,
  specFor,
} from "./sandbox.ts";
import { jsonOr } from "../../contracts/json.ts";
import { z } from "zod";

/**
 * Starting opensandbox-server, and knowing when not to.
 *
 * A **shared, machine-wide** process, possibly already serving somebody else.
 * Absent, we start one with our own config and remember it is ours; present and
 * usable, we never touch it; present and not, we report it and hand over a
 * button — never an automatic restart: "I cannot drive it" is not "nobody can".
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

/**
 * Four answers, not two.
 *
 * "Can we drive it" was one boolean and it collapsed the two cases that need
 * different actions: a server refusing our key is **not** a server that is down,
 * and starting a second one just fails to bind. `auth` is the one case we must
 * never act on — a server holding a key we were not given is somebody else's.
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
    // fallow-ignore-next-line security-sink -- the destination is `cfg.sandbox.server`, the address the boss set for their own sandbox server, and the key sent with it is the key stored for that same address. No request field reaches it.
    const res = await fetch(`${protocol}://${authority}/v1/sandboxes?page_size=1`, {
      // `OPEN-SANDBOX-API-KEY`, not `Authorization: Bearer` — the server reads
      // that one header and nothing else (`middleware/auth.py`), and sending the
      // wrong one is indistinguishable from a wrong key: 401 either way.
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
 * docs/design/ui.md: say it once, and let the control next to it do the
 * explaining. These sentences sit directly above the controls that are the
 * ways out of each case.
 */
function say(p: Probe, server: string): string {
  switch (p.kind) {
    case "auth":
      return `${server} 上那个服务器不是我们起的，密钥对不上 —— 填它的 api_key，或者换个地址。`;
    case "http":
      return `${server} 上有东西在应答，但不是沙盒服务器（HTTP ${p.status}）—— 换个地址。`;
    case "none":
      return p.why;
    case "ok":
      return "";
  }
}

/** Where our own config lives when we are the one starting the server. */
const ourConfigPath = (home = homedir()): string => join(home, ".orch-cache", "sandbox.toml");

/**
 * Set one key inside one TOML section.
 *
 * Section-aware, because `mode` appears in two sections and a file-wide `^mode =`
 * takes the first one. Commented lines count as the key: the example ships
 * `# api_key = "…"`, and treating that as absent leaves the server with no key
 * while we send one. Appends key or section when truly absent; not a parser.
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
  // fallow-ignore-next-line security-sink -- `at` is a source literal whose one placeholder is `key`, already run through a regex-metacharacter escape on the line above; the six callers pass fixed TOML key names.
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
 * A config file is that package's schema, not ours, and every required field a
 * later version adds would break a hand-written one — as one did on a clean
 * machine. `init-config --example docker` renders it; `patchConfig` agrees only
 * the values that must agree with us. Created once: a user's edits are kept.
 */
async function writeConfig(ctx: Ctx, key: string, path = ourConfigPath()): Promise<string> {
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  const gen = Bun.spawnSync(["uvx", "opensandbox-server", "init-config", path, "--example", "docker"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // Read it rather than ask whether it exists and then read it: the two-step
  // form is `js/file-system-race`, and the read has to succeed anyway. Its
  // failure carries the same message, since "missing" and "unreadable" are both
  // `init-config` not having produced a usable config.
  let generated: string;
  try {
    generated = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `opensandbox-server init-config failed: ${(gen.stderr.toString() || gen.stdout.toString()).trim().slice(-300)}`,
    );
  }

  const [host, port] = serverAddr(ctx).split(":");
  const skills = resolve(ctx.config.skillsDir);
  // The parent, not the directory itself: the server matches prefixes, and a
  // sibling cache directory added later should not need this file edited again.
  const allowed = [...new Set([dirname(skills), "/var/tmp/orch-cache"])];

  // Written beside the target and renamed onto it: `rename` is atomic within a
  // filesystem, so a server starting while this runs opens the old file or the
  // new one and never half of a truncated write, and two processes racing the
  // `existsSync` above end with one whole config rather than two interleaved.
  // CodeQL calls the second `js/file-system-race`; the fix is a write that does
  // not care whether the check still holds.
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(
    staged,
    `# api_key / host / port / allowed_host_paths / egress set by orchestrator.\n` +
      `# Everything else is opensandbox-server's own example. Yours to edit — only written if absent.\n` +
      patchConfig(generated, { host, port, key, allowed }),
    { mode: 0o600 },
  );
  renameSync(staged, path);
  return path;
}

/**
 * The values in a generated config that have to agree with *us*, and no others.
 *
 * Regex rather than a TOML parser, like `allowedHostPaths` above: six known
 * keys, one line each. `setIn` is section-aware for the reason written on it.
 */
export function patchConfig(
  toml: string,
  at: { host?: string | undefined; port?: string | undefined; key: string; allowed: string[] },
): string {
  let out = toml;
  // Why each: host/port, or we start a server on an address we are not asking;
  // api_key, or the server we just started refuses every call we make;
  // allowed_host_paths is the silent one, where a missing path mounts an empty
  // directory and the only symptom is every agent having no skills; egress
  // image because v1.1.4 403s every scoped package fetch while a credential is
  // bound (005); egress mode because the example's `direct` does not route.
  for (const [section, k, line] of [
    ["server", "host", `host = "${at.host}"`],
    ["server", "port", `port = ${Number(at.port) || 8080}`],
    ["server", "api_key", `api_key = "${at.key}"`],
    ["storage", "allowed_host_paths", `allowed_host_paths = [${at.allowed.map((p) => `"${p}"`).join(", ")}]`],
    ["egress", "image", `image = "opensandbox/egress:v1.1.6"`],
    ["egress", "mode", `mode = "dns+nft"`],
  ] as const) {
    out = setIn(out, section, k, line);
  }
  return out;
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
  // Bound to the address of the server this key is being generated *for*.
  // Stored without it, `sandboxKeyFor` would treat it as belonging nowhere and
  // the server we just started would be talked to unauthenticated.
  saveAuth(ctx.db, {
    runtime: SANDBOX_KEY,
    mode: "api_key",
    secret: made,
    baseUrl: `http://${ctx.config.sandbox.server.trim()}`,
  });
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
export async function waitUp(
  ctx: Ctx,
  proc: { exited: Promise<number> },
  server: string,
  key: string,
  ms = 45_000,
  io: { probe: typeof probe; sleep: (ms: number) => Promise<void> } = { probe, sleep: Bun.sleep },
): Promise<{ ok: boolean; why: string }> {
  let dead: number | null = null;
  void proc.exited.then((code) => (dead = code));
  const until = Date.now() + ms;
  let last = "还没应答";
  while (Date.now() < until) {
    const r = await io.probe(server, key);
    if (r.kind === "ok") return { ok: true, why: "" };
    last = say(r, server);
    // Its own words, not ours. "Unable to connect" is what we observed; the log
    // is what happened, and without it this reports the symptom of a process
    // that died of something specific it already printed.
    if (dead !== null) return { ok: false, why: exited(dead, serverLogTail(ctx)) };
    await io.sleep(400);
  }
  return { ok: false, why: timedOut(ms, last, serverLogTail(ctx)) };
}

const exited = (code: number, tail: string): string =>
  `它自己退了（exit ${String(code)}）${tail ? `：\n${tail}` : "，而且什么都没打印"}`;

const timedOut = (ms: number, last: string, tail: string): string =>
  `等了 ${Math.round(ms / 1000)} 秒还是 ${last}${tail ? `。它打印的是：\n${tail}` : ""}`;

/**
 * What is there, without changing anything.
 *
 * Split from `ensureServer` because a GET must not start a process: the settings
 * page polls this, and spawning a server as a side effect of being looked at
 * also hung the test that opens it.
 */
export async function inspectServer(ctx: Ctx): Promise<ServerState> {
  const server = serverAddr(ctx);
  const key = sandboxKeyFor(ctx.db, ctx.config.sandbox.server, ctx.config.sandbox.apiKey);
  const live = runningServer();
  const p = await probe(server, key);

  if (p.kind === "ok") {
    // Ours only if we recorded this pid. A pid from a previous boot still counts
    // — the process outlives us — but a different one means ours died.
    const mine = !!live && readSetting(ctx.db, PID_KEY) === live.pid;
    return mine ? { kind: "ours", pid: live.pid } : { kind: "theirs", pid: live?.pid ?? "?" };
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
  const plan = startPlan(await inspectServer(ctx), server, !!Bun.which("uvx"));
  if (plan.kind !== "start") return plan;

  const startKey = ourKey(ctx);
  let config: string;
  try {
    config = await writeConfig(ctx, startKey);
  } catch (e) {
    return { kind: "down", why: `写不出配置：${errText(e, 200)}` };
  }
  return startServer(ctx, server, startKey, config);
}

/**
 * Whether we are allowed to start one, given what is already there.
 *
 * Every "no" here is a different sentence, and each of them was a real report
 * once. Kept separate from the spawn so the policy can be read — and checked —
 * without a process being created to read it.
 */
export function startPlan(seen: ServerState, server: string, haveUvx: boolean): ServerState | { kind: "start" } {
  // Anything other than "nothing is there" is somebody's, or ours already.
  // Spawning into a taken address binds nothing, dies, and leaves the probe
  // talking to whatever was already listening — which is what made the first
  // failure unreadable.
  if (seen.kind !== "down") return seen;
  if (!haveUvx) return seen;
  // Only ever start one for an address on this machine. Pointed at a Tailscale
  // peer or a cloud box, "nothing answers" means that host is down — spawning a
  // local server would bind a port nobody is asking about and report success.
  const host = splitAddr(server).authority.replace(/:\d+$/, "").toLowerCase();
  if (host === "localhost" || host.startsWith("127.") || host === "::1" || host === "[::1]") return { kind: "start" };
  return { kind: "down", why: `${server} 不应答 —— 那不是本机地址，起不了，得去那台机器上看。` };
}

/** Spawn one and wait for it, remembering that it is ours. */
async function startServer(ctx: Ctx, server: string, key: string, config: string): Promise<ServerState> {
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
    writeSetting(ctx.db, PID_KEY, String(p.pid));
    writeSetting(ctx.db, ARGV_KEY, JSON.stringify(argv));
    const up = await waitUp(ctx, p, server, key);
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
  if (!live || readSetting(ctx.db, PID_KEY) !== live.pid) return null;
  const argv = jsonOr(readSetting(ctx.db, ARGV_KEY), z.array(z.string()), []);
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
