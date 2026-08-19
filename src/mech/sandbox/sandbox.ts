import type { Bus } from "../../platform/persistence/event-bus.ts";
import { eq } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { grp, project } from "../../platform/persistence/schema.ts";
import { errText } from "../../platform/process/text.ts";
import { VERSION } from "../../platform/process/version.ts";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { cpus, homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import {
  ConnectionConfig,
  type ExecutionHandlers,
  type RunCommandOpts,
  Sandbox,
  type Volume,
} from "@alibaba-group/opensandbox";
import type { Ctx } from "../../mech/ctx.ts";
import { ROOT } from "../../platform/config/load.ts";
import { readSetting, writeSetting } from "../../platform/persistence/database.ts";
import type { SandboxSpec } from "../../contracts/config.ts";
import type { ResourceExec } from "../lease.ts";
import { SpanStatusCode } from "@opentelemetry/api";
import pMap from "p-map";
import { scopeAttributes } from "../../platform/observability/metrics.ts";
import { requestContext } from "../../platform/observability/request-context.ts";
import { activeTracer } from "../../platform/observability/traces.ts";
import { CODEX_HOME, filesFor, sandboxKeyFor, vaultBindings } from "./auth.ts";
import { REFRESH_HOME, type CodexHomeIO } from "./chatgpt.ts";
import { shq } from "../../platform/process/shell.ts";
import type { TurnRunner } from "../../runtime/claude.ts";
import { projectConfig } from "../util/rows.ts";

/**
 * One sandbox per group. The boundary.
 *
 * Everything an agent runs — its turn, its gates, its leases, its git — runs in
 * here, and nothing in here can reach the host. The host offers a finite set of
 * actions through `orch` and nothing else, which is hard constraint 2. This file
 * is the only place that knows OpenSandbox exists; see docs/adr/005.
 */

/** Reconnecting on every call would build a new undici pool each time. */
const live = new Map<string, Sandbox>();

/**
 * Which images a group's container may be made from.
 *
 * Two sources: `ghcr.io/pamin-labs/…`, and anything with no registry prefix — a
 * locally built tag can never have been pulled from a registry, so allowing it
 * does not open the door the first rule closes. Everything else here assumes the
 * image is ours; this is the line that makes that true. Refused, not corrected.
 */
/** The one namespace this project publishes to. One home, so the allowlist and
 *  the panel's version list can never disagree about what "ours" means. */
export const PUBLISHED_REPO = "pamin-labs/orch-agent";
// fallow-ignore-next-line security-sink -- `PUBLISHED_REPO` is the module constant one line above; the image reference being checked is the `test` argument, never the pattern.
const PUBLISHED = new RegExp(`^ghcr\\.io/${PUBLISHED_REPO.split("/")[0]}/`, "i");

/**
 * Does this reference name a registry to pull from?
 *
 * A registry is a `.` or a `:` in the first path segment, or a literal `localhost`
 * — Docker's own rule, and the reason `orch/agent:1` is local. Two callers, one
 * rule: what may run, and whether preflight may say "not on this machine" is fine.
 */
export function hasRegistry(ref: string): boolean {
  const image = ref.trim();
  const head = image.split("/")[0]!;
  return image.includes("/") && (head.includes(".") || head.includes(":") || head === "localhost");
}

export function allowedImage(ref: string): boolean {
  const image = ref.trim();
  if (!image) return false;
  if (PUBLISHED.test(image)) return true;
  return !hasRegistry(image);
}

/**
 * A host path, as the daemon that performs the mount will read it.
 *
 * `opensandbox-server` is Linux-only, so on Windows it runs under WSL and the
 * path it is handed is resolved in *that* filesystem: `C:\orch\skills` is
 * `/mnt/c/orch/skills` there. Left untranslated nothing errors — the server
 * rejects it, or mounts an empty directory. Only drive-letter paths are touched.
 */
export function hostPathForDaemon(path: string, os: string = platform()): string {
  if (os !== "win32") return path;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!m) return path.replace(/\\/g, "/");
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`;
}

/** `1` is the SDK default and makes a typecheck 3.7x slower (005). */
function defaultCpu(): string {
  return String(Math.max(2, Math.floor(cpus().length / 4)));
}

/** Config, then the project's override. Adding a knob is a yaml key. */
export function specFor(ctx: Ctx, projectId: number | null): SandboxSpec {
  const base = ctx.config.sandbox;
  const over = projectConfig(ctx.db, projectId).sandbox ?? {};
  // `||`, not `??`: an empty string is how the yaml says "you decide". The image is
  // the one key a project may not freely set — `patchProjectConfig` merges arbitrary
  // keys into `config_json`, so refusing it only in the panel would be a check a
  // request can walk around, and this is where every container is actually built.
  const fallback = base.image;
  const image = over.image || fallback;
  return {
    image: allowedImage(image) ? image : fallback,
    cpu: over.cpu || base.cpu || defaultCpu(),
    memory: over.memory || base.memory,
    ttlSeconds: over.ttlSeconds || base.ttlSeconds,
    denyDomains: over.denyDomains ?? base.denyDomains ?? [],
    cacheDirs: over.cacheDirs ?? base.cacheDirs ?? {},
  };
}

/**
 * The key the sandbox server is actually running with, read from its own config.
 *
 * The server owns this value; we are its client, so we read it rather than
 * generating one and asking the boss to copy it across. Where a running server
 * was pointed is not ours to know — it takes `--config` and may be started from
 * anywhere — so this looks in the three places one is conventionally found.
 */
function configPaths(home = homedir()): string[] {
  return [
    process.env.OPENSANDBOX_CONFIG,
    join(process.cwd(), "sandbox.toml"),
    join(home, ".sandbox.toml"),
    // Last, and the one that actually matters: a server started by hand from
    // wherever, with `--config ./sandbox.toml` relative to a directory nobody
    // will remember. Asking the running process beats asking the boss.
    runningServer()?.config ?? null,
  ].filter((p): p is string => !!p);
}

export function serverKeyOnDisk(home = homedir()): { key: string; path: string; server: string } | null {
  for (const path of configPaths(home)) {
    const key = keyInConfig(path);
    // The address comes out of the same file as the key, so the two cannot be
    // paired wrongly by anything that happens later. `cfg.sandbox.server` is a
    // settings knob; this is the server whose file this key was read from.
    if (key) return { key, path, server: addrInConfig(path) };
  }
  return null;
}

/**
 * `host:port` out of one server config, defaulted the way the server defaults.
 *
 * Same regex-not-a-parser trade as `keyInConfig`, and the same `^[ \t]*` guard:
 * the example config ships both lines commented out, and taking a commented
 * value would name an address the server is not listening on.
 */
export function addrInConfig(path: string): string {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "127.0.0.1:8080";
  }
  const host = /^[ \t]*host[ \t]*=[ \t]*"([^"]+)"/m.exec(text)?.[1] ?? "127.0.0.1";
  const port = /^[ \t]*port[ \t]*=[ \t]*(\d{1,5})/m.exec(text)?.[1] ?? "8080";
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * `api_key` out of one config file, or null.
 *
 * A regex rather than a TOML parser: one key, one line. The `^\s*` matters — the
 * example config ships the line commented out, and taking that would lock the
 * fleet out just as thoroughly as a generated key would.
 */
export function keyInConfig(path: string): string | null {
  try {
    return /^[ \t]*api_key[ \t]*=[ \t]*"([^"]+)"/m.exec(readFileSync(path, "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The opensandbox-server process that is running right now, if there is one.
 *
 * Three states, three different answers: **absent** (restart it), **present but
 * refusing** (a restart makes a restart loop), and **present, healthy, holding
 * stale config** (needs a restart, and nothing else notices). `preflight`'s
 * `reachable()` answers the middle one over HTTP; this answers the first.
 */
// ponytail: shells out to `ps`, splits argv on whitespace, and resolves a relative
// `--config` against the process's own working directory (`/proc` on Linux, `lsof`
// on macOS). A path with a space in it comes back wrong — the fix is the server
// publishing its own config path over its API, not a shell parser here.

/**
 * Is this `ps` line the server, or a process talking about it.
 *
 * Anything that names it as an *argument* (pkill, grep, an editor, a terminal
 * title) is about the server, not the server. Pulled out so it can be checked
 * without a machine in a particular state, which is why that bug survived so long.
 */
export function isServerLine(l: string): boolean {
  if (!/(^|\/|\s)opensandbox-server(\s|$)/.test(l)) return false;
  return !/\b(ps|grep|pkill|pgrep|kill|killall|tail|less|vim|nano|echo|which)\b/.test(l);
}

/**
 * Is this pid still there — without asking `ps`.
 *
 * POSIX signal 0 delivers nothing and only reports whether the process exists.
 * `EPERM` counts as alive — it is there and belongs to somebody else. The known
 * limit is pid reuse, which is why this answers "still", not "which".
 */
export function pidAlive(pid: string): boolean {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // `EPERM` rather than `ESRCH`: it exists and is somebody else's.
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM";
  }
}

export function runningServer(): { pid: string; argv: string[]; config: string | null } | null {
  try {
    const ps = Bun.spawnSync(["ps", "-Ao", "pid=,args="], { stdout: "pipe" }).stdout.toString();
    // The name has to appear as a program being run, not merely somewhere on a
    // command line — see `isServerLine`.
    const line = ps.split("\n").find(isServerLine);
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const pid = parts[0]!;
    const arg = /--config[= ]+(\S+)/.exec(line)?.[1];
    const cwd = arg && !arg.startsWith("/") ? processCwd(pid) : null;
    return {
      pid,
      argv: parts.slice(1),
      config: !arg ? null : arg.startsWith("/") ? arg : cwd ? join(cwd, arg) : null,
    };
  } catch {
    return null;
  }
}

/**
 * The host paths this server will actually mount, and the file that says so.
 *
 * The silent one of the three. A missing path fails creation outright, which is
 * loud — but a config *out of step with ours* is not: the process is healthy,
 * nothing errors, and every container gets an empty directory. Answer: add a line.
 */
export function allowedHostPaths(home = homedir()): { paths: string[]; config: string } | null {
  for (const path of configPaths(home)) {
    try {
      const m = /^[ \t]*allowed_host_paths[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(readFileSync(path, "utf8"));
      if (m) return { paths: [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!), config: path };
    } catch {
      // Not readable, or not there. The next candidate might be.
    }
  }
  return null;
}

/** Is `want` inside one of them? The server allows a prefix, directory-wise. */
export const coveredBy = (allowed: string[], want: string): boolean =>
  allowed.some((a) => want === a.replace(/\/+$/, "") || want.startsWith(a.replace(/\/+$/, "") + "/"));

export type RestartOps = {
  running: typeof runningServer;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep: (ms: number) => Promise<void>;
  start: (argv: string[], log?: string) => void;
};

const restartOps: RestartOps = {
  running: runningServer,
  kill: (pid, signal) => void process.kill(pid, signal),
  sleep: Bun.sleep,
  start: (argv, log) => {
    const out = log ? Bun.file(log) : "ignore";
    Bun.spawn(argv, { stdout: out, stderr: out, stdin: "ignore" }).unref();
  },
};

async function waitForServerExit(ops: RestartOps): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!ops.running()) return true;
    await ops.sleep(100);
  }
  return !ops.running();
}

/**
 * Restart the server the way it was started.
 *
 * Only ever from an argv we have **seen**, never one we composed: how the boss
 * runs it is theirs, and inventing a command line would start a second,
 * differently-configured server beside the wedged one. Everything it was running
 * dies with it, turns in flight included.
 */
export async function restartServer(
  argv: string[],
  log?: string,
  ops: RestartOps = restartOps,
): Promise<string | null> {
  if (!argv.length) return "nothing recorded about how this server was started";
  const live = ops.running();
  if (live) {
    try {
      ops.kill(Number(live.pid), "SIGTERM");
    } catch (e) {
      return `could not stop pid ${live.pid}: ${errText(e)}`;
    }
    // It has containers to let go of. SIGKILL after, or a wedged process never
    // releases the port and the restart lands on an address already in use.
    if (!(await waitForServerExit(ops))) {
      try {
        ops.kill(Number(live.pid), "SIGKILL");
      } catch (e) {
        return `could not force-stop pid ${live.pid}: ${errText(e)}`;
      }
      if (!(await waitForServerExit(ops))) return `pid ${live.pid} is still running after SIGKILL`;
    }
  }
  try {
    // Its output goes somewhere readable, for the same reason the first start's
    // does: a server that comes back up and immediately dies on its config
    // leaves nothing behind otherwise, and the only report left is our own
    // failed probe — which describes the symptom and none of the causes.
    ops.start(argv, log);
    return null;
  } catch (e) {
    return `could not start ${argv[0]}: ${errText(e)}`;
  }
}

/**
 * `lsof -Fn` prints one tagged field per line; `n` is the name we asked for.
 *
 * Tagged rather than columnar precisely so this is a `startsWith` and not a
 * split: a cwd may contain spaces, and every column-counting parse of `lsof`
 * truncates the first path that does.
 */
export const lsofCwd = (out: string): string | null =>
  out
    .split("\n")
    .find((l) => l.startsWith("n"))
    ?.slice(1) ?? null;

function processCwd(pid: string): string | null {
  try {
    const link = `/proc/${pid}/cwd`;
    if (existsSync(link)) return readlinkSync(link);
  } catch {
    // Not Linux, or not permitted.
  }
  try {
    return lsofCwd(Bun.spawnSync(["lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"], { stdout: "pipe" }).stdout.toString());
  } catch {
    return null;
  }
}

function connection(ctx: Ctx): ConnectionConfig {
  const { protocol, authority } = splitAddr(serverAddr(ctx));
  const [host, port] = authority.split(":");
  // Set from the panel first, then the environment, then the yaml. The yaml is
  // committed, so a key that lives there is a key that leaks. Resolved against the
  // address it is about to be sent to: a stored key travels with the address it
  // was stored for, and `sandbox.server` is a knob the panel can move under it.
  const key = sandboxKeyFor(ctx.db, authority, ctx.config.sandbox.apiKey);
  return new ConnectionConfig({
    domain: `${host}:${port ?? 8080}`,
    protocol,
    ...(key ? { apiKey: key } : {}),
    // The SDK default is 30s, which an image pull blows straight through — the
    // same shape of wait, and the same number, as a `git clone`, which is why
    // both read `timeouts.transferMs`.
    requestTimeoutSeconds: Math.ceil(ctx.config.timeouts.transferMs / 1000),
  });
}

/**
 * Who owns a sandbox.
 *
 * A group is the usual answer; standing roles have no group and share one per
 * project. `util` runs no agent, checks out no working tree and executes nothing
 * from a repository, so it is the only container bound for GitHub *writes* — a
 * group's binding is scoped to the paths a fetch uses (`readOnlyGitPaths`).
 */
export type Scope = { grp: number } | { project: number } | { util: true };

/** The utility container. Written out so no caller invents a second spelling. */
export const UTIL: Scope = { util: true };
export const isUtil = (s: Scope): s is { util: true } => "util" in s;

/** It owns no row, so its id lives beside the other server-scope settings. */
const UTIL_ID = "util_sandbox_id";
const UTIL_AT = "util_sandbox_at";

export function utilSandbox(db: Ctx["db"]): { id: string | null; at: number } {
  return { id: readSetting(db, UTIL_ID), at: Number(readSetting(db, UTIL_AT) ?? 0) };
}

const holder = (s: Scope) =>
  isUtil(s)
    ? { table: "setting", id: 0 }
    : "grp" in s
      ? { table: "grp", id: s.grp }
      : { table: "project", id: s.project };

function owner(db: DB, scope: Scope): { sandboxId: string | null; projectId: number | null } {
  if (isUtil(scope)) return { sandboxId: utilSandbox(db).id, projectId: null };
  const h = holder(scope);
  if (h.table === "grp") {
    const row = orm(db)
      .select({ sandbox_id: grp.sandbox_id, project_id: grp.project_id })
      .from(grp)
      .where(eq(grp.id, h.id))
      .get();
    if (!row) throw new Error(`no group ${h.id}`);
    return { sandboxId: row.sandbox_id, projectId: row.project_id };
  }
  const row = orm(db).select({ sandbox_id: project.sandbox_id }).from(project).where(eq(project.id, h.id)).get();
  if (!row) throw new Error(`no project ${h.id}`);
  return { sandboxId: row.sandbox_id, projectId: h.id };
}

function remember(db: DB, scope: Scope, id: string | null): void {
  // The timestamp is what makes a stale binding visible. A sidecar is loaded
  // with the credentials that existed at this moment and never again, so a
  // sandbox older than the newest credential is one nobody has rebound.
  const at = id ? Date.now() : null;
  if (isUtil(scope)) {
    writeSetting(db, UTIL_ID, id);
    writeSetting(db, UTIL_AT, at === null ? null : String(at));
    return;
  }
  const h = holder(scope);
  orm(db)
    .update(binding(h.table))
    .set({ sandbox_id: id, sandbox_at: at })
    .where(eq(binding(h.table).id, h.id))
    .run();
}

/**
 * Which table holds this scope's binding.
 *
 * The UPDATE was assembled from `holder`'s table *name*, which is also a log
 * line's — so a string meant for a person was reaching the statement. Both rows
 * carry the same two columns, so the choice is a table and not a fragment.
 */
const binding = (table: string) => (table === "grp" ? grp : project);

/** The remote this scope's container may reach, for the read-only binding. */
function remoteOf(db: DB, projectId: number | null): string | null {
  if (projectId == null) return null;
  return (
    orm(db).select({ remote: project.remote }).from(project).where(eq(project.id, projectId)).get()?.remote ?? null
  );
}

/**
 * The scope's sandbox, created on first use and reconnected after a restart.
 *
 * The id column is the durable half; the Sandbox object is not. A restarted
 * orchestrator reconnects to a sandbox still running its TTL out, which is what
 * keeps a turn's session — and its cached prefix — alive across a restart.
 */
/**
 * Nothing can open a container right now.
 *
 * docker not running, `opensandbox-server` down, the key rejected. A hold, the
 * same shape as the rate-limit and offline ones: the first group discovers the
 * wall and the rest are simply not dispatched. Short, because the alternative to
 * re-probing is staying down after docker comes back.
 */
const HOLD_MS = 60_000;
let downUntil = 0;
let saidDown = false;

export const sandboxHeld = (now = Date.now()): boolean => downUntil > now;

/** Tests only. */
export function resetSandboxHold(): void {
  downUntil = 0;
  saidDown = false;
}

function markDown<T>(ctx: Ctx, e: T, now = Date.now()): void {
  downUntil = now + HOLD_MS;
  if (saidDown) return;
  saidDown = true;
  // Once per outage, not once per attempt: a held job produces no attempt, and
  // the same line every minute is how a feed stops being read.
  ctx.bus?.emit({
    author: "orchestrator",
    kind: "escalation",
    intent: "inform",
    severity: "blocker",
    body:
      `开不了容器，所有 turn 先挂起：${errText(e, 200)}\n` +
      `多半是 docker 没起或者 opensandbox-server 没在跑 —— 设置页的自检那一栏会说是哪个。好了自动继续。`,
  });
}

function markUp(bus: Bus): void {
  if (saidDown) {
    bus?.emit({ author: "orchestrator", kind: "state_change", body: "容器又能开了，挂起的活自动继续" });
  }
  downUntil = 0;
  saidDown = false;
}

export async function ensureSandbox(ctx: Ctx, scope: Scope): Promise<Sandbox> {
  try {
    const sb = await openSandbox(ctx, scope);
    markUp(ctx.bus);
    return sb;
  } catch (e) {
    markDown(ctx, e);
    throw e;
  }
}

async function reconnect(ctx: Ctx, scope: Scope, sandboxId: string | null): Promise<Sandbox | null> {
  if (!sandboxId) return null;
  const cached = live.get(sandboxId);
  // Deliberately above the span: a cached handle is not a round trip, and a span
  // that fires on the hit would bury the one that fires on the miss.
  if (cached) return cached;
  return activeTracer().startActiveSpan(
    "sandbox.reconnect",
    { attributes: sandboxScope(scope, "project" in scope ? scope.project : null) },
    async (span) => {
      try {
        const sandbox = await Sandbox.connect({ connectionConfig: connection(ctx), sandboxId });
        live.set(sandboxId, sandbox);
        return sandbox;
      } catch (e) {
        // A reconnect that burns its timeout and fails falls through to a fresh
        // `sandbox.create`, so without this span its cost was charged there.
        span.setStatus({ code: SpanStatusCode.ERROR, message: errText(e) });
        remember(ctx.db, scope, null);
        return null;
      } finally {
        span.end();
      }
    },
  );
}

function cacheVolumes(spec: SandboxSpec): Volume[] {
  return Object.entries(spec.cacheDirs).map(([mountPath, hostPath], index) => ({
    name: `cache-${index}`,
    host: { path: hostPathForDaemon(hostPath) },
    mountPath,
  }));
}

function createSandbox(ctx: Ctx, scope: Scope, spec: SandboxSpec, volumes: Volume[]) {
  const ownerName = isUtil(scope) ? "util" : `${holder(scope).table}-${holder(scope).id}`;
  return Sandbox.create({
    connectionConfig: connection(ctx),
    image: spec.image,
    timeoutSeconds: spec.ttlSeconds,
    resource: { cpu: spec.cpu, memory: spec.memory },
    credentialProxy: { enabled: true },
    networkPolicy: {
      defaultAction: "allow",
      egress: spec.denyDomains.map((target) => ({ action: "deny" as const, target })),
    },
    volumes,
    metadata: { owner: ownerName },
  });
}

async function createMountedSandbox(
  ctx: Ctx,
  scope: Scope,
  spec: SandboxSpec,
  cached: Volume[],
  skills: Volume[],
): Promise<{ sandbox: Sandbox; skillsMounted: boolean }> {
  try {
    return { sandbox: await createSandbox(ctx, scope, spec, [...cached, ...skills]), skillsMounted: skills.length > 0 };
  } catch (error) {
    if (!skills.length || !isPathNotAllowed(error)) throw error;
    ctx.bus?.emit({
      grpId: "grp" in scope ? scope.grp : null,
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body:
        `技能没挂进沙盒：opensandbox-server 的 allowed_host_paths 不含 ${skills[0]!.host?.path}。` +
        `加上它再重开这个组的容器；在那之前 agent 只能用你在输入框里点名的技能。`,
    });
    return { sandbox: await createSandbox(ctx, scope, spec, cached), skillsMounted: false };
  }
}

async function writeLoginFiles(db: DB, sandbox: Sandbox): Promise<void> {
  const files = filesFor(db);
  if (!Object.keys(files).length) return;
  await sandbox.files.createDirectories([{ path: CODEX_HOME }]).catch(() => {});
  await writeInto(
    sandbox,
    Object.entries(files).map(([path, data]) => ({ path, data, mode: 600 })),
  ).catch(() => {});
}

async function installVaultCredentials(
  ctx: Ctx,
  scope: Scope,
  sandbox: Sandbox,
  projectId: number | null,
): Promise<void> {
  const { credentials } = await vaultBindings(ctx.db, codexHomeIO(ctx), {
    repo: isUtil(scope) ? null : remoteOf(ctx.db, projectId),
  });
  if (!credentials.length) return;
  await sandbox.credentialVault
    .create({
      credentials: credentials.map((credential) => ({
        name: credential.name,
        source: { type: "inline" as const, value: credential.value },
      })),
      bindings: credentials.map((credential) => ({
        name: credential.name,
        match: matchFor(credential),
        auth: authFor(credential),
      })),
    })
    .catch((error: unknown) => {
      ctx.bus?.emit({
        grpId: "grp" in scope ? scope.grp : null,
        author: "orchestrator",
        kind: "state_change",
        severity: "blocker",
        body:
          `这个容器的凭据没绑上，里面的假值会原样发出去 —— 接下来每次模型调用都会 401，` +
          `而那不是 token 的问题，重新登录也没用。原因：${errText(error, 400)}`,
      });
    });
}

async function restoreGroupWorkspace(ctx: Ctx, scope: Scope): Promise<void> {
  if (!("grp" in scope) || !ctx.restoreWorkspace) return;
  await ctx.restoreWorkspace(scope.grp).catch((error: unknown) => {
    ctx.bus.emit({
      grpId: scope.grp,
      author: "orchestrator",
      kind: "state_change",
      severity: "warn",
      body: `沙盒重建了，但工作区没装回去：${errText(error)}`,
    });
  });
}

/**
 * What a sandbox span is about.
 *
 * A group's container is scoped to the group and its project; a project-scoped
 * one names only the project; the utility container belongs to neither and
 * writes NULL to all three columns rather than being filed under something.
 */
export function sandboxScope(scope: Scope, projectId: number | null) {
  return scopeAttributes({ grpId: "grp" in scope ? scope.grp : null, projectId });
}

/**
 * Two spans, because these are two different four-minute problems.
 *
 * Building the container is the image, the daemon and the mounts; initialising it
 * is provisioning, credentials and the workspace. Split, the answer is "four
 * minutes building" or "four minutes filling", which point at different fixes.
 */
async function openSandbox(ctx: Ctx, scope: Scope): Promise<Sandbox> {
  const { sandboxId, projectId } = owner(ctx.db, scope);
  const existing = await reconnect(ctx, scope, sandboxId);
  if (existing) return existing;

  const attributes = sandboxScope(scope, projectId);
  const spec = specFor(ctx, projectId);
  const skills = isUtil(scope) ? [] : skillMounts(ctx);
  const created = await activeTracer().startActiveSpan(
    "sandbox.create",
    { attributes: { ...attributes, "sandbox.image": spec.image } },
    async (span) => {
      try {
        return await createMountedSandbox(ctx, scope, spec, cacheVolumes(spec), skills);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errText(error) });
        throw error;
      } finally {
        span.end();
      }
    },
  );
  const sb = created.sandbox;
  live.set(sb.id, sb);
  remember(ctx.db, scope, sb.id);

  await activeTracer().startActiveSpan("sandbox.init", { attributes }, async (span) => {
    try {
      // The utility container gets no mailbox and no `orch`: nothing in it is an
      // agent, so the one interface an agent is allowed would be surface with no
      // user — in the container that holds the real tokens.
      if (!isUtil(scope)) await provision(sb);
      // Mounted is not the same as readable — but only when a mount was actually
      // accepted, since "mounted but empty" would falsely describe a container built
      // without the mount at all. The three share no state and each owns its own
      // failure, so they go together rather than as three round trips on the path a
      // requirement waits on. `Promise.all` and not a floating promise: the sandbox
      // is usable the moment this returns, and a check still in flight would report
      // on a container the next step has already changed.
      await Promise.all([
        created.skillsMounted
          ? checkSkillsMount(ctx.bus, sb, skills[0]!.host!.path, skills[0]!.mountPath).catch(() => {})
          : undefined,
        writeLoginFiles(ctx.db, sb),
        installVaultCredentials(ctx, scope, sb, projectId),
      ]);
      // Remembered before restore so re-entry finds this sandbox instead of building another.
      await restoreGroupWorkspace(ctx, scope);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(error) });
      throw error;
    } finally {
      span.end();
    }
  });
  return sb;
}

/**
 * File modes, as the API wants them: the octal digits, not the value.
 *
 * `0o644` is 420 in decimal, the SDK sends the number as a string, and the
 * server parses that string as octal — so it rejects "420" outright and would
 * have silently meant something else if it had not. Writing the digits is the
 * only form that survives the round trip.
 */
export const FILE_MODE = 644;
const EXEC_MODE = 755;

/** The one creation failure worth degrading for rather than failing the group. */
function isPathNotAllowed<T>(e: T): boolean {
  return /not under any allowed prefix|allowed_host_paths/i.test(String(e));
}

/**
 * The refresher's hands, inside the utility container.
 *
 * **Never a group's.** This is the real refresh token — the one credential 007
 * kept off every agent — and the utility container has no agent, no mailbox and
 * no `orch` in it. Lives here rather than in `chatgpt.ts`: that file must not
 * import this one, or `sandbox.ts` -> `auth.ts` -> `chatgpt.ts` closes a cycle.
 */
function codexHomeIO(ctx: Ctx): CodexHomeIO {
  return {
    read: (path) => getFile(ctx, UTIL, path),
    write: (path, data) => putFile(ctx, UTIL, path, data),
    remove: async (path) => void (await execIn(ctx, UTIL, `rm -f ${shq(path)}`)),
    run: async (argv) => {
      const r = await execIn(ctx, UTIL, `codex ${argv.map(shq).join(" ")}`, {
        timeoutMs: ctx.config.timeouts.tokenRefreshMs,
        env: { CODEX_HOME: REFRESH_HOME },
      });
      return r.code === 0;
    },
  };
}

/** Where a group's checkout lives inside its sandbox. */
export const WORK = "/work";

/** Host paths already checked this process; every sandbox mounts the same one. */
const mountChecked = new Set<string>();

/** Only what the check reads, so it can be driven without a container. */
export interface Counter {
  commands: { run(cmd: string): Promise<{ logs?: { stdout?: { text: string }[] } }> };
}

/**
 * Did the skills mount actually bring the skills.
 *
 * A bind mount of a host path the container runtime cannot reach does not fail —
 * it succeeds and delivers an **empty directory**. macOS runs docker in a VM, so
 * `/var/tmp` there is the VM's; a path under `$HOME` binds fine.
 */
export async function checkSkillsMount(bus: Bus, sb: Counter, hostPath: string, at: string): Promise<void> {
  if (mountChecked.has(hostPath)) return;
  mountChecked.add(hostPath);
  let onHost = 0;
  try {
    onHost = readdirSync(hostPath).length;
  } catch {
    return; // Nothing staged; `skillMounts` would not have mounted it.
  }
  if (!onHost) return;
  const e = await sb.commands.run(`ls ${shq(at)} | wc -l`).catch(() => null);
  // A container that could not answer is not a container with an empty mount.
  // `Number("")` is 0, so folding the two together raised this blocker — naming
  // a mount problem, with a fix about `allowed_host_paths` — every time the exec
  // itself failed, which on the create path is the likelier of the two.
  if (!e) return;
  const inside = Number(
    (e.logs?.stdout ?? [])
      .map((m) => m.text)
      .join("")
      .trim(),
  );
  if (!Number.isFinite(inside) || inside > 0) return;
  bus?.emit({
    author: "orchestrator",
    kind: "state_change",
    severity: "blocker",
    body:
      `技能挂进去了但里面是空的：宿主 ${hostPath} 有 ${onHost} 个，容器里 ${at} 有 0 个。\n` +
      `容器运行时读不到宿主这个路径，绑上去就是个空目录 —— macOS 上 docker 跑在虚拟机里，` +
      `虚拟机外的路径（/var/tmp 这类）不会被共享进去。把 skillsDir 指到一个能共享的位置` +
      `（$HOME 下面的就行），让 opensandbox-server 的 allowed_host_paths 也包含它，然后重启它。` +
      `在那之前 agent 一个技能都用不上。`,
  });
}

/**
 * Where the boss's staged skills land inside a container.
 *
 * **Not** either CLI's own skills directory: a read-only mount straight onto them
 * is not a directory anything can add to, so a repository's own skills were
 * undeliverable. This is a staging path nothing reads directly, and `SKILL_SYNC`
 * builds each CLI's real directory from symlinks into it — ordinary filesystem.
 */
export const STAGED_SKILLS = "/opt/orch/skills";

/**
 * How `SKILL_SYNC` reports a repository's own skills back out.
 *
 * The linking happens in the container and the *listing* has to reach the host,
 * or the settings page cannot show a repo's skills and `/name` cannot resolve one.
 * One line per skill, on the exec already probing the checkout; the head of the
 * file rides along base64'd, because `frontmatterDescription` reads YAML.
 */
export const SKILL_LINE = "ORCHSKILL";

/**
 * The staged skills, mounted where `SKILL_SYNC` will link them from.
 *
 * One mount now, not two: both CLIs' directories are built from it rather than
 * being it.
 */
export function skillMounts(ctx: Ctx): Volume[] {
  // Absolute, and on the server's own allowlist: it reads this as its own
  // filesystem path, rejects anything not starting with `/`, and rejects
  // anything outside `allowed_host_paths` — which is why this is not under
  // `dataDir`. A repo checkout is never on that list.
  const path = resolve(ctx.config.skillsDir);
  if (!existsSync(path)) return [];
  return [{ name: "skills", host: { path: hostPathForDaemon(path) }, mountPath: STAGED_SKILLS, readOnly: true }];
}

/**
 * Both CLIs' skill directories, rebuilt from what is on disk right now.
 *
 * **codex has no project-local skills directory at all**, and claude's is
 * `.claude/skills` under its working directory, so a repo's `.codex/skills` and
 * `.agents/skills` reach nobody unless linked here. Symlinks, not copies — that is
 * what makes this affordable every turn. Never fails its caller.
 */
export const SKILL_SYNC = `{
mkdir -p /root/.claude/skills ${CODEX_HOME}/skills
find /root/.claude/skills ${CODEX_HOME}/skills -maxdepth 1 -type l -delete
for s in ${STAGED_SKILLS}/*/; do
  [ -f "$s/SKILL.md" ] || continue
  n=$(basename "$s")
  ln -sfn "\${s%/}" /root/.claude/skills/"$n"
  ln -sfn "\${s%/}" ${CODEX_HOME}/skills/"$n"
done
for base in .claude .codex .agents; do
  for s in ${WORK}/$base/skills/*/; do
    [ -f "$s/SKILL.md" ] || continue
    n=$(basename "$s")
    [ "$base" = ".claude" ] || ln -sfn "\${s%/}" /root/.claude/skills/"$n"
    ln -sfn "\${s%/}" ${CODEX_HOME}/skills/"$n"
    echo "${SKILL_LINE} $base/skills/$n/SKILL.md $(head -c 800 "$s/SKILL.md" | base64 | tr -d '\\n')"
  done
done
} 2>/dev/null`;

/**
 * The one header opensandbox-server reads a key from.
 *
 * Not `Authorization: Bearer`. The server checks this header and nothing else
 * (`middleware/auth.py`), so sending the wrong one is indistinguishable from
 * holding the wrong key — 401 both ways, and the message says the key was
 * rejected when it was never presented. Exported so the two probes cannot drift.
 */
export const SANDBOX_API_KEY_HEADER = "OPEN-SANDBOX-API-KEY";

/**
 * Split an address into scheme and authority.
 *
 * The server does not have to be on this machine — the SDK only ever speaks HTTP
 * to it. `https` matters for one case: over Tailscale the transport is already
 * WireGuard, but over the open internet the api_key and every container payload
 * would cross in the clear, so the scheme is honoured rather than assumed.
 */
export function splitAddr(addr: string): { protocol: "http" | "https"; authority: string } {
  const m = /^(https?):\/\/(.+)$/i.exec(addr.trim());
  if (!m) return { protocol: "http", authority: addr.trim() };
  const protocol = m[1]?.toLowerCase();
  return { protocol: protocol === "https" ? "https" : "http", authority: m[2]!.replace(/\/+$/, "") };
}

/**
 * Reachable only from this machine, or from a network that encrypts itself.
 *
 * The Tailscale range (100.64.0.0/10, the CGNAT block it uses) and `*.ts.net` are
 * safe because that transport is WireGuard. Everything else on plain HTTP is a
 * real exposure and is reported, never blocked: it may be a private VLAN we cannot
 * see from here, and refusing it would be this side deciding what it cannot know.
 */
export function remoteInClear(addr: string): boolean {
  const { protocol, authority } = splitAddr(addr);
  if (protocol === "https") return false;
  // The platform's parser, not a `:\d+$` strip: it lowercases, removes the port,
  // and keeps an IPv6 literal inside its brackets. Stripping by hand turned
  // `[::1]:8080` into `[::1` and reported loopback as an exposure. An authority
  // it cannot parse is one we cannot vouch for.
  const host = URL.parse(`http://${authority}`)?.hostname;
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.startsWith("127.") || host === "[::1]") return false;
  if (host.endsWith(".ts.net")) return false;
  return !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
}

/**
 * Which server to drive.
 *
 * Settable from the panel, because "there is already one on 8080 and it is not
 * ours" is a normal thing to walk into and the only two ways out are its key or
 * a different address. A yaml-only knob makes the second one an edit-and-restart.
 */
export function serverAddr(ctx: Ctx): string {
  // One place. The `sandbox_server_addr` row this used to consult first is
  // `cfg.sandbox.server` since migration 039, so the config already carries
  // whatever the panel set.
  return ctx.config.sandbox.server.trim();
}

/** The agent's only way out: a request is a file here, the answer is another. */
export const MAILBOX_DIR = "/var/orch";

/**
 * The CLI as one self-contained file, which is the shape a container can run.
 *
 * Built here rather than read, because `src/orch/cli.ts` is only sometimes a
 * bundle: the release archive ships one at that path, and a checkout ships the
 * source, which since the API split imports five modules and `hono/client` that
 * no container has. `orch` was dead in every sandbox started from a checkout —
 * the agent's only interface — and the one test that would have said so was
 * skipping. Building both shapes keeps one code path, and costs about 7ms.
 */
export async function agentCli(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(ROOT, "src/orch/cli.ts")],
    target: "bun",
    define: { __ORCH_VERSION__: JSON.stringify(VERSION) },
  });
  const [output] = built.outputs;
  if (!built.success || !output) throw new Error(`cannot build the agent CLI: ${built.logs.join("; ")}`);
  return await output.text();
}

/**
 * Everything the agent needs before its first turn: a mailbox and an `orch`.
 *
 * The CLI is copied in as source rather than installed, for the same reason the
 * host shim is generated rather than compiled — it always matches the running
 * orchestrator, so a route added this morning is not missing from a sandbox
 * started yesterday.
 */
async function provision(sb: Sandbox): Promise<void> {
  const cli = await agentCli();
  await sb.files.createDirectories([
    { path: `${MAILBOX_DIR}/req` },
    { path: `${MAILBOX_DIR}/res` },
    { path: "/opt/orch" },
    { path: WORK },
  ]);
  await writeInto(sb, [
    { path: "/opt/orch/cli.ts", data: cli, mode: FILE_MODE },
    { path: "/usr/local/bin/orch", data: '#!/bin/sh\nexec bun run /opt/orch/cli.ts "$@"\n', mode: EXEC_MODE },
  ]);
  // The boss's own skills, before the first turn. Every container with a checkout
  // gets this again on that checkout's probe, which is where a repository's own
  // join in; re-running it is also what ticking a skill triggers.
  await sb.commands.run(SKILL_SYNC).catch(() => {});
}

/** Re-link every live container's skills. What a tick of the skills list does. */
export async function relinkSkills(): Promise<void> {
  await pMap(live.values(), (sb) => sb.commands.run(SKILL_SYNC).catch(() => {}), { concurrency: EXEC_FANOUT });
}

/**
 * Ask a project's own containers what its checkout ships, and build nothing.
 *
 * **The project's own container first, not as a fallback**: a project that has
 * landed everything has no groups at all, and the indexer clones into the project
 * container. `reconnect`, not `ensureSandbox` — a settings click must never cost a
 * `sandbox.create`. Null means nobody answered, *not* "this repository ships none".
 */
export async function listProjectSkills(ctx: Ctx, projectId: number): Promise<string | null> {
  const groups = ctx.db
    .query<{ id: number }, [number]>("SELECT id FROM grp WHERE project_id = ? ORDER BY id DESC")
    .all(projectId);
  const scopes: Scope[] = [{ project: projectId }, ...groups.map((g) => ({ grp: g.id }))];
  for (const scope of scopes) {
    const { sandboxId } = owner(ctx.db, scope);
    if (!sandboxId) continue;
    const sb = await reconnect(ctx, scope, sandboxId);
    if (!sb) continue;
    const probe = await sb.commands.run(`${SKILL_SYNC}; test -d ${WORK}/.git && echo yes`).catch(() => null);
    const out = stdoutText(probe);
    if (out.includes("yes")) return out;
  }
  return null;
}

/**
 * Every upload into a container, with one retry.
 *
 * The upload is an HTTP POST to a port on this same machine, and it resets. One
 * retry is what that is worth: the far end is a container here, not a network. A
 * second failure is not a flake, so it throws. Every caller comes through here.
 */
export async function writeInto(
  sb: { files: Pick<Sandbox["files"], "writeFiles"> },
  files: Parameters<Sandbox["files"]["writeFiles"]>[0],
): Promise<void> {
  try {
    await sb.files.writeFiles(files);
  } catch {
    try {
      await sb.files.writeFiles(files);
    } catch (e) {
      const where = files.map((f) => f.path).join(", ");
      throw new Error(`could not write ${where} into the container: ${errText(e)}`, { cause: e });
    }
  }
}

/**
 * Everything the rest of the system does to a sandbox.
 *
 * Injected on `Ctx` the same way `git`, `gh` and `ask` are: a unit test has no
 * container to talk to, and the alternative — each of these swallowing its own
 * connection error — is how a silent failure looks like success (docs/adr/001).
 */
export interface SandboxDriver {
  exec(ctx: Ctx, scope: Scope, cmd: string, opts?: ExecOpts): Promise<ExecOutcome>;
  lines(
    ctx: Ctx,
    scope: Scope,
    cmd: string,
    opts?: ExecOpts,
  ): AsyncGenerator<string, { code: number; err: string }, void>;
  put(ctx: Ctx, scope: Scope, path: string, data: string): Promise<void>;
  get(ctx: Ctx, scope: Scope, path: string): Promise<string | null>;
  getBytes(ctx: Ctx, scope: Scope, path: string): Promise<Uint8Array | null>;
  putBytes(ctx: Ctx, scope: Scope, path: string, data: Uint8Array): Promise<void>;
  bind(ctx: Ctx, scope: Scope, creds: Credential[]): Promise<void>;
  kill(ctx: Ctx, scope: Scope): Promise<void>;
  renew(ctx: Ctx, scope: Scope): Promise<void>;
}

export interface Credential {
  name: string;
  value: string;
  hosts: string[];
  /** Header name for an apiKey-style credential; omit for `Authorization: Bearer`. */
  header?: string;
  /**
   * Request paths this credential may be injected on. Absent means all of them.
   *
   * Read from the sidecar's own matcher: a pattern ending in `*` is a **prefix**,
   * anything else is compared for equality, and the query string is cut off first.
   * So a leading wildcard matches nothing, and a trailing one would readmit
   * `git-receive-pack`. ANDed with the host match, and evaluated before it.
   */
  paths?: string[];
}

/** Both bind sites, so a binding cannot be built two ways. */
const matchFor = (c: Credential) => ({
  schemes: ["https" as const],
  hosts: c.hosts,
  ...(c.paths ? { paths: c.paths } : {}),
});

const authFor = (c: Credential) =>
  c.header
    ? { type: "apiKey" as const, name: c.header, credential: c.name }
    : { type: "bearer" as const, credential: c.name };

const driver = (ctx: Ctx): SandboxDriver => ctx.sandbox ?? REAL;

export interface ExecOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Stderr, a line at a time, for callers that are watching rather than parsing.
   *
   * `execLines` yields stdout only, because the agent adapters parse every yielded
   * line as NDJSON. But `git clone --progress` and every package manager print
   * progress on stderr, so the two commands that take minutes were the two that
   * said nothing until they finished. Opt-in, so the NDJSON readers are untouched.
   */
  onStderr?: (line: string) => void;
}

export interface ExecOutcome {
  code: number;
  out: string;
  err: string;
}

function runOpts(o: ExecOpts) {
  return {
    ...(o.cwd === undefined ? {} : { workingDirectory: o.cwd }),
    ...(o.timeoutMs ? { timeoutSeconds: Math.ceil(o.timeoutMs / 1000) } : {}),
    ...(o.env ? { envs: o.env } : {}),
  };
}

/**
 * Run one command to completion.
 *
 * ~1s of overhead per call (005), so this is for turns, gates and leases — not
 * for anything chatty. The files API is the cheap channel (1-5ms).
 */
/**
 * One bash session per container: `run()` costs a second, `runInSession` costs 5ms.
 * The numbers, the fallback ladder and why snapshots were refused are in ADR 032.
 *
 * **The cwd is pinned on every call**, never inherited. A session keeps its cwd, so
 * a `cd /work && …` inside one command would otherwise decide where the *next*
 * command with no `cwd` of its own runs.
 */
/** What the session path needs of a container: an id and three commands. Narrower
 *  than `Sandbox`, so a test can call it without building the files API. */
export interface Runner {
  id: string;
  commands: {
    run(cmd: string, opts?: RunCommandOpts, handlers?: ExecutionHandlers, signal?: AbortSignal): Promise<ExecLike>;
    createSession(opts?: { workingDirectory?: string }): Promise<string>;
    runInSession(
      id: string,
      cmd: string,
      opts?: { workingDirectory?: string; timeoutSeconds?: number },
      handlers?: ExecutionHandlers,
      signal?: AbortSignal,
    ): Promise<ExecLike>;
  };
}

/** Only the two fields read off an execution: the code, and the two log streams. */
export interface ExecLike {
  /** `null` as well as absent: the SDK's own `Execution` uses null for "no code yet". */
  exitCode?: number | null | undefined;
  logs?: { stdout?: { text: string }[] | undefined; stderr?: { text: string }[] | undefined } | undefined;
}

interface Session {
  id: string;
  /** Where the session starts, asked once, so `cwd`-less commands match `run()`. */
  home: string;
}
const sessions = new Map<string, Session>();

/** Tests only: forget every session, so one case cannot inherit another's. */
export const forgetSessions = (): void => sessions.clear();

async function sessionFor(sb: Runner): Promise<Session | null> {
  const have = sessions.get(sb.id);
  if (have) return have;
  try {
    const id = await sb.commands.createSession();
    const pwd = await sb.commands.runInSession(id, "pwd");
    const home = (pwd.logs?.stdout ?? []).map(oneLine).join("").trim();
    if (!home) return null;
    const made = { id, home };
    sessions.set(sb.id, made);
    return made;
  } catch {
    // A server too old for sessions, or one that refuses: `run()` still works and
    // is what every call did until now.
    return null;
  }
}

/**
 * A session's stdout and stderr are the same pipe — `readlink /proc/self/fd/{1,2}`
 * answers with one inode — so each command redirects its own stderr to a file and
 * reads it back after a marker. Taking the merged stream would put git's warnings
 * back into NUL-delimited `STATUS_Z` output. Evidence in ADR 032.
 *
 * The status is set by a **subshell**: a bare `exit` ends the session. The marker is
 * emitted by `printf` because a shell argument cannot carry the control byte; if it
 * fails to appear the whole output is stdout, which is the old merged behaviour.
 */
const ERR_MARK = "\u0001orch-stderr\u0001";
const ERR_MARK_PRINTF = "\\001orch-stderr\\001";
/** Exported for the live probe and its unit test; not part of the module's API. */
export const wrapForSession = (cmd: string, file: string): string =>
  `{ ${cmd} ; } 2>${file} ; __orch_rc=$? ; printf '${ERR_MARK_PRINTF}' ; cat ${file} ; rm -f ${file} ; ( exit $__orch_rc )`;

/** Split what the session returned back into the two streams `run()` would have. */
export function unwrap(raw: string): { out: string; err: string } {
  const at = raw.indexOf(ERR_MARK);
  if (at < 0) return { out: raw, err: "" };
  // One trailing newline, because `run()` strips one per message and the marker
  // arrives glued to the last line of stdout rather than after it.
  return { out: raw.slice(0, at).replace(/\n$/, ""), err: raw.slice(at + ERR_MARK.length) };
}

/**
 * Run one command, in the session when the session can carry it.
 *
 * `runInSession` takes `workingDirectory` and `timeoutSeconds` and **not `envs`**,
 * so a command with environment goes the one-shot way. Two callers need that: the
 * codex refresher and the login, both of which set `CODEX_HOME`.
 */
/** Exported for the test that pins the fallback ladder; not part of the module's API. */
export async function runIn(sb: Runner, cmd: string, opts: ExecOpts): Promise<ExecOutcome> {
  const shape = (e: ExecLike, k: "stdout" | "stderr") => (e.logs?.[k] ?? []).map(oneLine).join("\n");
  const plain = async (): Promise<ExecOutcome> => {
    const e = await sb.commands.run(cmd, runOpts(opts), undefined, opts.signal);
    return { code: e.exitCode ?? -1, out: shape(e, "stdout"), err: shape(e, "stderr") };
  };
  if (opts.env) return plain();
  const session = await sessionFor(sb);
  if (!session) return plain();
  const inSession = async (s: Session): Promise<ExecOutcome> => {
    // Named for the session, not for the command: one session runs one command at
    // a time, so the file cannot be in use by another of its own runs, and a
    // per-command name would leave litter behind every failure.
    const e = await sb.commands.runInSession(
      s.id,
      wrapForSession(cmd, `/tmp/orch-stderr-${s.id}`),
      {
        workingDirectory: opts.cwd ?? s.home,
        ...(opts.timeoutMs ? { timeoutSeconds: Math.ceil(opts.timeoutMs / 1000) } : {}),
      },
      undefined,
      opts.signal,
    );
    return { code: e.exitCode ?? -1, ...unwrap(shape(e, "stdout")) };
  };
  try {
    return await inSession(session);
  } catch {
    // A session dies with its container, and with its own shell. Forget it and try
    // once through a fresh one, then stop trying: `run()` is the behaviour that
    // was here before sessions and it still works.
    sessions.delete(sb.id);
    const again = await sessionFor(sb);
    if (!again) return plain();
    try {
      return await inSession(again);
    } catch {
      return plain();
    }
  }
}

async function realExec(ctx: Ctx, scope: Scope, cmd: string, opts: ExecOpts = {}): Promise<ExecOutcome> {
  return runIn(await ensureSandbox(ctx, scope), cmd, opts);
}

/**
 * One log message is one line, and its newline is gone. Put it back.
 *
 * Measured against the running server: it splits on line boundaries and on CR,
 * strips the terminator, never splits a long line, and delivers a blank line as the
 * two-character newline string. So joining on newlines is safe, and each message is
 * stripped first — or every blank line doubles.
 */
const oneLine = (m: { text: string }): string => m.text.replace(/\r?\n$/, "");

/**
 * One container's stdout as one string, from the shape the SDK hands back.
 *
 * Takes the null a failed exec becomes, because every caller has the same two
 * cases and folding them here is what keeps the callers down to the line they
 * actually care about.
 */
const stdoutText = (e: { logs?: { stdout?: { text: string }[] } } | null): string =>
  (e?.logs?.stdout ?? []).map(oneLine).join("\n");

/**
 * Reassemble lines from chunks that split anywhere.
 *
 * SSE frames do not respect line boundaries and both agent CLIs emit NDJSON, so
 * a chunk that lands mid-object has to be held, not parsed. Pulled out of the
 * stream so it can be checked without a container.
 */
export function lineSplitter(): { push: (chunk: string) => string[]; rest: () => string } {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      // `\r` too: git reports clone progress by rewriting one line with carriage
      // returns, so a two-minute clone is a single unterminated line otherwise.
      // NDJSON is unaffected — JSON escapes control characters, so a raw `\r`
      // never appears inside an object.
      const parts = buf.split(/\r\n|[\r\n]/);
      buf = parts.pop() ?? "";
      return parts.map((p) => p.trim()).filter(Boolean);
    },
    rest: () => buf.trim(),
  };
}

/**
 * Callbacks on one side, an async generator on the other, one promise between.
 *
 * The SDK delivers output by calling a handler; the turn adapters consume it by
 * iterating. The bridge is where a stream quietly stops being one — so it is
 * separate, and checked. `Promise.withResolvers()` replaces a nullable `let` that
 * every producer had to remember to null-check before calling.
 */
export function lineQueue(): {
  push(lines: string[]): void;
  end(): void;
  drain(): AsyncGenerator<string, void, void>;
} {
  const queue: string[] = [];
  let gate = Promise.withResolvers<void>();
  let done = false;
  return {
    push(lines) {
      queue.push(...lines);
      gate.resolve();
    },
    end() {
      done = true;
      gate.resolve();
    },
    async *drain() {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        // Everything already pushed is delivered before the end is honoured: a
        // command that prints its last line and exits in the same tick would
        // otherwise lose that line.
        if (done) return;
        await gate.promise;
        // Re-arm *after* the await, so a line pushed while the consumer was busy
        // has already resolved the gate it is about to wait on — no lost wakeup.
        gate = Promise.withResolvers<void>();
      }
    },
  };
}

/**
 * Run a command and hand back its stdout a line at a time.
 *
 * Both agent CLIs emit NDJSON on stdout and the adapters parse it as it
 * arrives, so the stream has to stay a stream: buffering a whole turn would
 * kill the live timeline and, for a long turn, the memory too. SSE chunks split
 * anywhere, hence the reassembly here.
 */
async function* realLines(
  ctx: Ctx,
  scope: Scope,
  cmd: string,
  opts: ExecOpts = {},
): AsyncGenerator<string, { code: number; err: string }, void> {
  const sb = await ensureSandbox(ctx, scope);
  const q = lineQueue();
  const split = lineSplitter();
  const errSplit = lineSplitter();
  let stderr = "";
  let code = -1;

  const finished = sb.commands
    .run(
      cmd,
      runOpts(opts),
      {
        // Handlers only: accumulating a whole turn's NDJSON in the Execution
        // object as well would double the memory for no reader.
        skipAccumulation: true,
        // `+ "\n"` on both, for the reason in `oneLine`: the server hands over one
        // line per message with the terminator removed, so a splitter fed the raw
        // text holds **everything** and emits it once, at the end, as one run-on
        // line — for an NDJSON turn, the whole stream as one unparseable string.
        onStdout: (m) => q.push(split.push(`${oneLine(m)}\n`)),
        onStderr: (m) => {
          stderr += `${oneLine(m)}\n`;
          // git writes progress with `\r`, not `\n`, so a clone is one very long
          // line until it ends. The server splits on that too, and eats it.
          if (opts.onStderr) for (const l of errSplit.push(`${oneLine(m)}\n`)) opts.onStderr(l);
        },
      },
      opts.signal,
    )
    .then((e) => {
      code = e.exitCode ?? -1;
    })
    .catch((e: unknown) => {
      stderr += String(e);
    })
    .finally(() => q.end());

  yield* q.drain();
  await finished;
  const tail = split.rest();
  if (tail) yield tail;
  return { code, err: stderr };
}

/**
 * What a gate or a lease runs against. See `ResourceExec` in lease.ts.
 *
 * The template is still tokenised to argv and quoted here rather than handed to
 * a shell as one string, so an argument's metacharacters stay inert — that is
 * hard constraint 2, and it matters more now that `orch` is the only interface.
 */
export function resourceExec(ctx: Ctx, scope: Scope): ResourceExec {
  return async (argv, o) => {
    const signal = requestContext.getStore()?.signal;
    const r = await execIn(ctx, scope, argv.map(shq).join(" "), {
      cwd: o.cwd,
      ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) throw signal.reason;
    return { code: r.code, out: r.out + r.err };
  };
}

/** What the turn adapters run against. See `TurnRunner` in runtime/claude.ts. */
export function runnerFor(ctx: Ctx, scope: Scope): TurnRunner {
  return {
    put: (path, data) => putFile(ctx, scope, path, data),
    lines: (cmd, opts) => execLines(ctx, scope, cmd, opts),
  };
}

async function realPut(ctx: Ctx, scope: Scope, path: string, data: string): Promise<void> {
  const sb = await ensureSandbox(ctx, scope);
  await writeInto(sb, [{ path, data, mode: FILE_MODE }]);
}

/** Binary write, for the same reason as `getBytes`. */
async function realPutBytes(ctx: Ctx, scope: Scope, path: string, data: Uint8Array): Promise<void> {
  const sb = await ensureSandbox(ctx, scope);
  await writeInto(sb, [{ path, data, mode: FILE_MODE }]);
}

/** Binary read. A git bundle is not text and must not go through a decoder. */
async function realGetBytes(ctx: Ctx, scope: Scope, path: string): Promise<Uint8Array | null> {
  const sb = await ensureSandbox(ctx, scope);
  try {
    return await sb.files.readBytes(path);
  } catch {
    return null;
  }
}

async function realGet(ctx: Ctx, scope: Scope, path: string): Promise<string | null> {
  const sb = await ensureSandbox(ctx, scope);
  try {
    return await sb.files.readFile(path);
  } catch {
    return null;
  }
}

/**
 * Bind the real credentials to the sidecar.
 *
 * The sandbox's environment holds format-plausible fakes; the sidecar swaps in the
 * real value on the way out. Measured (005): injection REPLACES an `Authorization`
 * header the CLI already set, and `claude` does not validate its token locally —
 * a synthetic one comes back as a server-side 401, which is what makes this work.
 */
async function realBind(ctx: Ctx, scope: Scope, creds: Credential[]): Promise<void> {
  if (!creds.length) return;
  const sb = await ensureSandbox(ctx, scope);
  await sb.credentialVault.create({
    credentials: creds.map((c) => ({ name: c.name, source: { type: "inline" as const, value: c.value } })),
    bindings: creds.map((c) => ({ name: c.name, match: matchFor(c), auth: authFor(c) })),
  });
}

/**
 * Kill the sandbox and forget it.
 *
 * `pause` looks like the cheaper move and is not: it is a real `docker pause`,
 * so the container, its sidecar and its disk all stay (005). Only kill frees
 * anything, which is why a dissolved group kills rather than pauses.
 */
async function realKill(ctx: Ctx, scope: Scope): Promise<void> {
  const id = owner(ctx.db, scope).sandboxId;
  if (!id) return;
  const sb = live.get(id);
  try {
    if (sb) await sb.kill();
    else await (await Sandbox.connect({ connectionConfig: connection(ctx), sandboxId: id })).kill();
  } catch {
    // Already gone by TTL or by hand. Clearing the column is the point.
  }
  await sb?.close().catch(() => {});
  live.delete(id);
  // The session belonged to that container and does not outlive it.
  sessions.delete(id);
  remember(ctx.db, scope, null);
}

/** Push the expiry out. A group mid-turn must not be reaped by its own TTL. */
async function realRenew(ctx: Ctx, scope: Scope): Promise<void> {
  const { sandboxId, projectId } = owner(ctx.db, scope);
  if (!sandboxId) return;
  const sb = live.get(sandboxId);
  if (!sb) return;
  await sb.renew(specFor(ctx, projectId).ttlSeconds).catch(() => {});
}

/** Every sandbox this process is connected to. The mailbox poller's worklist. */
export function liveSandboxes(): Sandbox[] {
  return [...live.values()];
}

/** Drop cached connections. Tests and shutdown; nothing in the hot path. */
export async function closeAll(): Promise<void> {
  for (const sb of live.values()) await sb.close().catch(() => {});
  live.clear();
}

/** The one that actually talks to OpenSandbox. Wired on Ctx at server start. */
export const REAL: SandboxDriver = {
  exec: realExec,
  lines: realLines,
  put: realPut,
  get: realGet,
  getBytes: realGetBytes,
  putBytes: realPutBytes,
  bind: realBind,
  kill: realKill,
  renew: realRenew,
};

/**
 * `sh -c` a command in a container. **This never rejects.**
 *
 * Every caller reads `.code` and none is in a try/catch, because a command that
 * fails is a code — the contract this shape promises. Two things underneath break
 * it: `ensureSandbox` rethrows when no container opens, and `commands.run` is a
 * socket. So that is an exit code with the reason in `err`, not a rejection.
 */
export async function execIn(ctx: Ctx, scope: Scope, cmd: string, opts?: ExecOpts): Promise<ExecOutcome> {
  // The command itself is never an attribute — it carries repository paths and
  // file names, which `docs/standards/observability.md` forbids on labels — so
  // the scope is what identifies it. The group's project, not just the group: a
  // span whose `project_id` is NULL is invisible to the panel's project scope.
  const attributes = sandboxScope(scope, projectOf(ctx.db, scope));
  return activeTracer().startActiveSpan("sandbox.exec", { attributes }, async (span) => {
    try {
      const out = await driver(ctx).exec(ctx, scope, cmd, opts);
      // This function is documented as never rejecting, so a span that errored
      // only on a throw could never error at all. An unreachable container has to
      // look like a failure in the panel as well as to the caller.
      if (out.code === EXEC_UNAVAILABLE) span.setStatus({ code: SpanStatusCode.ERROR, message: out.err });
      return out;
    } catch (e) {
      const err = `container unavailable: ${errText(e)}`;
      span.setStatus({ code: SpanStatusCode.ERROR, message: err });
      return { code: EXEC_UNAVAILABLE, out: "", err };
    } finally {
      span.end();
    }
  });
}

/** Which project a scope belongs to, so a span can be filtered by one. */
function projectOf(db: DB, scope: Scope): number | null {
  if ("project" in scope) return scope.project;
  if (!("grp" in scope)) return null;
  return (
    db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(scope.grp)?.project_id ??
    null
  );
}

/** `sh`'s "found it, could not run it". The lease guard already speaks it. */
export const EXEC_UNAVAILABLE = 126;

/**
 * How many containers may be reached at once when something fans out over them.
 *
 * Four, derived rather than picked: `cfg.sandbox.cpu` left empty means a quarter of
 * the host's cores, and that cap is **per container** — so N execs in a fan-out
 * contend on the host, where N caps sum. Four is one host's worth.
 */
export const EXEC_FANOUT = 4;
/**
 * A container round trip, with the span every one of them owes.
 *
 * The delegations beside `execIn` are one-line passthroughs, which is exactly why
 * the span belongs here rather than at each caller: the tenth gets it by being
 * written in this shape. Never the path or the command as an attribute — both
 * carry repository and file names, which observability.md keeps off labels.
 */
function roundTrip<T>(name: string, ctx: Ctx, scope: Scope, run: () => Promise<T>): Promise<T> {
  const attributes = sandboxScope(scope, projectOf(ctx.db, scope));
  return activeTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await run();
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errText(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

/**
 * The streaming exec, which is a generator and so cannot use `roundTrip`.
 *
 * A promise wrapper would end the span when the generator was *handed over*, so it
 * is ended in a `finally` around the loop instead — which also covers a caller who
 * breaks out early or throws.
 */
export async function* execLines(
  ctx: Ctx,
  scope: Scope,
  cmd: string,
  opts?: ExecOpts,
): AsyncGenerator<string, { code: number; err: string }, void> {
  const attributes = sandboxScope(scope, projectOf(ctx.db, scope));
  const span = activeTracer().startSpan("sandbox.exec_lines", { attributes });
  try {
    const outcome = yield* driver(ctx).lines(ctx, scope, cmd, opts);
    if (outcome.code === EXEC_UNAVAILABLE) span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.err });
    return outcome;
  } catch (e) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: errText(e) });
    throw e;
  } finally {
    span.end();
  }
}
export const putFile = (ctx: Ctx, scope: Scope, path: string, data: string) =>
  roundTrip("sandbox.put_file", ctx, scope, () => driver(ctx).put(ctx, scope, path, data));
export const getFile = (ctx: Ctx, scope: Scope, path: string) =>
  roundTrip("sandbox.get_file", ctx, scope, () => driver(ctx).get(ctx, scope, path));
export const getBytes = (ctx: Ctx, scope: Scope, path: string) =>
  roundTrip("sandbox.get_bytes", ctx, scope, () => driver(ctx).getBytes(ctx, scope, path));
export const putBytes = (ctx: Ctx, scope: Scope, path: string, data: Uint8Array) =>
  roundTrip("sandbox.put_bytes", ctx, scope, () => driver(ctx).putBytes(ctx, scope, path, data));
export const bindCredentials = (ctx: Ctx, scope: Scope, creds: Credential[]) =>
  roundTrip("sandbox.bind_credentials", ctx, scope, () => driver(ctx).bind(ctx, scope, creds));
export const killSandbox = (ctx: Ctx, scope: Scope) =>
  roundTrip("sandbox.kill", ctx, scope, () => driver(ctx).kill(ctx, scope));
export const renewSandbox = (ctx: Ctx, scope: Scope) =>
  roundTrip("sandbox.renew", ctx, scope, () => driver(ctx).renew(ctx, scope));
