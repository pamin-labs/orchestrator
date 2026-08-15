import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join, resolve } from "node:path";
import { ConnectionConfig, Sandbox, type Volume } from "@alibaba-group/opensandbox";
import type { Ctx } from "../api.ts";
import { ROOT } from "../config.ts";
import type { ResourceExec } from "./lease.ts";
import { CODEX_HOME, filesFor, loadAuth, SANDBOX_KEY, vaultBindings } from "./auth.ts";
import { shq } from "./shq.ts";
import type { TurnRunner } from "../runtime/claude.ts";

/**
 * One sandbox per group. The boundary.
 *
 * Everything an agent runs — its turn, its gates, its leases, its git — runs in
 * here, and nothing in here can reach the host. That is the whole point:
 * decision 001 measured that the host sandbox is deny-only, so "only this
 * checkout is writable" was never expressible and every path nobody thought to
 * deny stayed writable. A container inverts it. The host offers a finite set of
 * actions through `orch` and nothing else, which is hard constraint 2 turned
 * from the sandbox's only gap into its only interface.
 *
 * This file is the only place that knows OpenSandbox exists. See
 * docs/decisions/005 for what was measured, including the several places where
 * the observed behaviour contradicts that project's docs.
 */

/** Reconnecting on every call would build a new undici pool each time. */
const live = new Map<string, Sandbox>();

export interface SandboxSpec {
  image: string;
  /** Kubernetes-style quantities, e.g. "4" and "8Gi". */
  cpu: string;
  memory: string;
  ttlSeconds: number;
  /**
   * Domains the group may NOT reach. Everything else is open.
   *
   * A blocklist rather than an allowlist because the allowlist is the thing that
   * cannot be enumerated — every registry, every docs site, every package a
   * project happens to need. Measured (005): credential injection still works
   * under `defaultAction: allow`, contradicting the vault docs, so open egress
   * costs nothing in credential safety. The real tokens are never in here.
   */
  denyDomains: string[];
  /**
   * Host directories shared by every sandbox of this project, by mount path.
   *
   * For package-manager caches, and only those. Measured on this repo, a second
   * group's `bun install`: 2.9s cold against 1.2s with the cache shared — small
   * here because the repo is small, and the whole point on a monorepo where the
   * install is minutes.
   *
   * Off by default, and the reason is this repo's own worst outage: every
   * worktree shared one `node_modules` through a symlink, two gates installed at
   * once, and the group read `Failed to link jiti: EEXIST` as its own build
   * being broken. A package cache is not that — bun's and npm's are
   * content-addressed and built for concurrent readers — but the shape is close
   * enough that it should be something a project turns on deliberately.
   *
   * The sandbox server must also list the host path under `allowed_host_paths`,
   * or creation fails outright.
   */
  cacheDirs: Record<string, string>;
}

/** `1` is the SDK default and makes a typecheck 3.7x slower (005). */
function defaultCpu(): string {
  return String(Math.max(2, Math.floor(cpus().length / 4)));
}

/** Only reached by unit tests that build a Ctx without a config block. */
const DEFAULTS = {
  server: "127.0.0.1:8080",
  apiKey: "",
  image: "ghcr.io/orch/agent:1",
  cpu: "",
  memory: "8Gi",
  ttlSeconds: 86400,
  denyDomains: [] as string[],
  cacheDirs: {} as Record<string, string>,
};

/** Config, then the project's override. Adding a knob is a yaml key. */
export function specFor(ctx: Ctx, projectId: number | null): SandboxSpec {
  const base = ctx.config.sandbox ?? DEFAULTS;
  let over: Partial<SandboxSpec> = {};
  if (projectId) {
    const row = ctx.db
      .query<{ config_json: string }, [number]>("SELECT config_json FROM project WHERE id = ?")
      .get(projectId);
    try {
      over = JSON.parse(row?.config_json ?? "{}").sandbox ?? {};
    } catch {
      over = {};
    }
  }
  // `||`, not `??`: an empty string is how the yaml says "you decide", and it is
  // never a usable value for any of these.
  return {
    image: over.image || base.image,
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
 * Generating one here and asking the boss to copy it into the server's file is
 * how a whole night went: the panel had a key, the server had another, and every
 * turn, gate and diff came back 401 as "Authentication credentials are invalid",
 * which reads as a model problem. The server owns this value. We are its client,
 * so we read it.
 *
 * Where a running server was pointed is not ours to know — it takes `--config`
 * and may be started from anywhere — so this looks in the three places one is
 * conventionally found, in the order the server itself would.
 *
 * A regex rather than a TOML parser: one key, one line, and a dependency for
 * that is a dependency for that.
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

export function serverKeyOnDisk(home = homedir()): { key: string; path: string } | null {
  for (const path of configPaths(home)) {
    const key = keyInConfig(path);
    if (key) return { key, path };
  }
  return null;
}

/**
 * `api_key` out of one config file, or null.
 *
 * A regex rather than a TOML parser: one key, one line, and a dependency for
 * that is a dependency for that. The `^\s*` matters — the example config ships
 * the line commented out, and taking that would store a value the server is not
 * using and lock the fleet out just as thoroughly as a generated one.
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
 * Three questions have three different answers and only this one separates
 * them: **absent** (restart it), **present but refusing** (a restart makes a
 * restart loop), and **present, healthy, and holding stale config** (needs a
 * restart, and nothing else notices). `preflight`'s `reachable()` answers the
 * middle one over HTTP; this answers the first.
 *
 * ponytail: shells out to `ps`, splits argv on whitespace, and resolves a
 * relative `--config` against the process's own working directory (`/proc` on
 * Linux, `lsof` on macOS). A path with a space in it comes back wrong — the fix
 * is the server publishing its own config path over its API, not a shell parser
 * here.
 */
export function runningServer(): { pid: string; argv: string[]; config: string | null } | null {
  try {
    const ps = Bun.spawnSync(["ps", "-Ao", "pid=,args="], { stdout: "pipe" }).stdout.toString();
    // Not this process's own `grep`-alike, and not a test harness mentioning it.
    const line = ps.split("\n").find((l) => /opensandbox-server/.test(l) && !/\bps -Ao\b/.test(l));
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
 * The silent one of the three. A mount of a path missing from this list fails
 * creation outright, which is loud — but the config being *out of step with
 * ours* is not: the process is healthy, nothing errors, and the only symptom is
 * an empty directory inside every container. That is the incident this exists
 * for, and it is why the answer is not "restart" but "add this line".
 *
 * Same regex-not-a-parser trade as `keyInConfig`, and the same `^[ \t]*` for the
 * same reason: the example config ships the line commented out.
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

/**
 * Restart the server the way it was started.
 *
 * Only ever from an argv we have **seen**, never one we composed: how the boss
 * runs it (`uvx`, a venv, a wrapper, extra flags) is theirs, and inventing a
 * command line would start a second, differently-configured server beside the
 * one that is wedged.
 *
 * Everything it was running dies with it — every container, and with them every
 * turn in flight. That is why the deliberate one is a button with hard
 * constraint 5's evidence beside it, and the automatic one below is narrow.
 */
export async function restartServer(argv: string[]): Promise<string | null> {
  if (!argv.length) return "nothing recorded about how this server was started";
  const live = runningServer();
  if (live) {
    try {
      process.kill(Number(live.pid), "SIGTERM");
    } catch (e) {
      return `could not stop pid ${live.pid}: ${(e as Error)?.message ?? e}`;
    }
    // It has containers to let go of. SIGKILL after, or a wedged process never
    // releases the port and the restart lands on an address already in use.
    for (let i = 0; i < 50 && runningServer(); i++) await new Promise((r) => setTimeout(r, 100));
    if (runningServer()) {
      try {
        process.kill(Number(live.pid), "SIGKILL");
      } catch {}
    }
  }
  try {
    Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }).unref();
    return null;
  } catch (e) {
    return `could not start ${argv[0]}: ${(e as Error)?.message ?? e}`;
  }
}

function processCwd(pid: string): string | null {
  try {
    const link = `/proc/${pid}/cwd`;
    if (existsSync(link)) return readlinkSync(link);
  } catch {
    // Not Linux, or not permitted.
  }
  try {
    const out = Bun.spawnSync(["lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"], { stdout: "pipe" }).stdout.toString();
    return out.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
  } catch {
    return null;
  }
}

function connection(ctx: Ctx): ConnectionConfig {
  const [host, port] = (ctx.config.sandbox ?? DEFAULTS).server.split(":");
  // Set from the panel first, then the environment, then the yaml. The yaml is
  // committed, so a key that lives there is a key that leaks; the panel writes
  // it to the same store every other credential uses.
  const key = loadAuth(ctx.db, SANDBOX_KEY)?.secret || (ctx.config.sandbox ?? DEFAULTS).apiKey;
  return new ConnectionConfig({
    domain: `${host}:${port ?? 8080}`,
    protocol: "http",
    apiKey: key || undefined,
    // The SDK default is 30s, which an image pull blows straight through.
    requestTimeoutSeconds: 600,
  });
}

/**
 * Who owns a sandbox.
 *
 * A group is the usual answer. Standing roles — Architect, CoS, Dispatcher —
 * have no group and still must not run on the host, so they share one per
 * project.
 *
 * `util` is the third, and it is not a sandbox in the 005 sense. 007 narrows
 * that decision by one word: **the boundary is a container that runs an agent**.
 * This one runs none, checks out no working tree, and executes nothing that came
 * out of a repository — it is a peer of the server that happens not to occupy
 * the host's PATH. So it is the only container bound for GitHub *writes*, while
 * every group's binding is scoped to the two request paths a fetch uses
 * (`readOnlyGitPaths`). One per orchestrator, not per project: what it holds is
 * the login, and there is one of those.
 */
export type Scope = { grp: number } | { project: number } | { util: true };

/** The utility container. Written out so no caller invents a second spelling. */
export const UTIL: Scope = { util: true };
export const isUtil = (s: Scope): s is { util: true } => "util" in s;

/** It owns no row, so its id lives beside the other server-scope settings. */
const UTIL_ID = "util_sandbox_id";
const UTIL_AT = "util_sandbox_at";

export function utilSandbox(db: Ctx["db"]): { id: string | null; at: number } {
  const get = (k: string) => db.query<{ v: string }, [string]>("SELECT v FROM setting WHERE k = ?").get(k)?.v ?? null;
  return { id: get(UTIL_ID), at: Number(get(UTIL_AT) ?? 0) };
}

const holder = (s: Scope) =>
  isUtil(s) ? { table: "setting", id: 0 } : "grp" in s ? { table: "grp", id: s.grp } : { table: "project", id: s.project };

function owner(ctx: Ctx, scope: Scope): { sandboxId: string | null; projectId: number | null } {
  if (isUtil(scope)) return { sandboxId: utilSandbox(ctx.db).id, projectId: null };
  const h = holder(scope);
  if (h.table === "grp") {
    const row = ctx.db
      .query<{ sandbox_id: string | null; project_id: number }, [number]>(
        "SELECT sandbox_id, project_id FROM grp WHERE id = ?",
      )
      .get(h.id);
    if (!row) throw new Error(`no group ${h.id}`);
    return { sandboxId: row.sandbox_id, projectId: row.project_id };
  }
  const row = ctx.db
    .query<{ sandbox_id: string | null }, [number]>("SELECT sandbox_id FROM project WHERE id = ?")
    .get(h.id);
  if (!row) throw new Error(`no project ${h.id}`);
  return { sandboxId: row.sandbox_id, projectId: h.id };
}

function remember(ctx: Ctx, scope: Scope, id: string | null): void {
  // The timestamp is what makes a stale binding visible. A sidecar is loaded
  // with the credentials that existed at this moment and never again, so a
  // sandbox older than the newest credential is one nobody has rebound.
  const at = id ? Date.now() : null;
  if (isUtil(scope)) {
    const put = (k: string, v: string | null) =>
      v === null
        ? ctx.db.run("DELETE FROM setting WHERE k = ?", [k])
        : ctx.db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [k, v]);
    put(UTIL_ID, id);
    put(UTIL_AT, at === null ? null : String(at));
    return;
  }
  const h = holder(scope);
  ctx.db.run(`UPDATE ${h.table} SET sandbox_id = ?, sandbox_at = ? WHERE id = ?`, [id, at, h.id]);
}

/** The remote this scope's container may reach, for the read-only binding. */
function remoteOf(ctx: Ctx, projectId: number | null): string | null {
  if (projectId == null) return null;
  return (
    ctx.db.query<{ remote: string | null }, [number]>("SELECT remote FROM project WHERE id = ?").get(projectId)
      ?.remote ?? null
  );
}

/**
 * The scope's sandbox, created on first use and reconnected after a restart.
 *
 * The id column is the durable half; the Sandbox object is not. A restarted
 * orchestrator reconnects to a sandbox that is still running its TTL out, which
 * is what keeps a turn's session — and therefore its cached prefix — alive
 * across a restart.
 */
/**
 * Nothing can open a container right now.
 *
 * docker not running, `opensandbox-server` down, the key rejected. Preflight
 * reports all three — and only as a console warning, so the fleet still finds
 * out the expensive way: every group dispatches, `ensureSandbox` throws, the
 * turn fails, the watchdog requeues it once and then files a blocker. Ten
 * groups, ten blockers, one fact.
 *
 * So it is a hold, the same shape as the rate-limit and offline ones: the first
 * group discovers the wall and the rest are simply not dispatched. Short,
 * because the alternative to re-probing is staying down after docker comes
 * back, and because a failure that was actually about one project's config
 * should not hold everyone for long.
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

function markDown(ctx: Ctx, e: unknown, now = Date.now()): void {
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
      `开不了容器，所有 turn 先挂起：${String((e as Error)?.message ?? e).slice(0, 200)}\n` +
      `多半是 docker 没起或者 opensandbox-server 没在跑 —— 设置页的自检那一栏会说是哪个。好了自动继续。`,
  });
}

function markUp(ctx: Ctx): void {
  if (saidDown) {
    ctx.bus?.emit({ author: "orchestrator", kind: "state_change", body: "容器又能开了，挂起的活自动继续" });
  }
  downUntil = 0;
  saidDown = false;
}

export async function ensureSandbox(ctx: Ctx, scope: Scope): Promise<Sandbox> {
  try {
    const sb = await openSandbox(ctx, scope);
    markUp(ctx);
    return sb;
  } catch (e) {
    markDown(ctx, e);
    throw e;
  }
}

async function openSandbox(ctx: Ctx, scope: Scope): Promise<Sandbox> {
  const { sandboxId, projectId } = owner(ctx, scope);

  if (sandboxId) {
    const cached = live.get(sandboxId);
    if (cached) return cached;
    try {
      const sb = await Sandbox.connect({ connectionConfig: connection(ctx), sandboxId });
      live.set(sandboxId, sb);
      return sb;
    } catch {
      // Expired or killed. Fall through and make a new one rather than wedging
      // the owner on a sandbox id that will never answer again.
      remember(ctx, scope, null);
    }
  }

  const spec = specFor(ctx, projectId);
  const cacheVolumes = Object.entries(spec.cacheDirs).map(([mountPath, hostPath], i) => ({
    name: `cache-${i}`,
    host: { path: hostPath },
    mountPath,
  }));
  const make = (volumes: Volume[]) =>
    Sandbox.create({
      connectionConfig: connection(ctx),
      image: spec.image,
      timeoutSeconds: spec.ttlSeconds,
      resource: { cpu: spec.cpu, memory: spec.memory },
      // Required for credential injection; without it the tokens would have to be
      // real inside the sandbox, and the failure mode is a 401 rather than an
      // obvious "vault off". Preflight asserts the server side of this.
      credentialProxy: { enabled: true },
      networkPolicy: {
        defaultAction: "allow",
        egress: spec.denyDomains.map((target) => ({ action: "deny" as const, target })),
      },
      volumes,
      // `grp-1`, not `grp:1`: metadata values must be alphanumeric plus `-_.`, and
      // a colon is a 400 at creation — which fails the group, not the label.
      metadata: { owner: isUtil(scope) ? "util" : `${holder(scope).table}-${holder(scope).id}` },
    });

  // The boss's own skills, staged into one dereferenced directory on the host
  // (`stageSkills`) and mounted where each CLI looks for them, so the agent finds
  // and invokes a skill by itself instead of waiting to be handed one. Read-only:
  // what the boss ticks is the whole contract, and a group editing the set every
  // other group mounts is not part of it.
  // Not the utility container: nothing in there reads a skill, because nothing
  // in there is an agent.
  const skills = isUtil(scope) ? [] : skillMounts(ctx);
  let sb: Sandbox;
  let skillsMounted = skills.length > 0;
  try {
    sb = await make([...cacheVolumes, ...skills]);
  } catch (e) {
    // The server mounts host paths only from its own `allowed_host_paths`, and a
    // path missing from it fails creation outright — which would take every
    // group down for a feature no group needs to run. So: one retry without the
    // skills, said out loud with the exact path to allow. Not a silent fallback
    // (005) — the fleet keeps working and the boss is told what is switched off.
    if (!skills.length || !isPathNotAllowed(e)) throw e;
    ctx.bus?.emit({
      grpId: "grp" in scope ? scope.grp : null,
      author: "orchestrator",
      kind: "state_change",
      severity: "blocker",
      body:
        `技能没挂进沙盒：opensandbox-server 的 allowed_host_paths 不含 ${skills[0]!.host?.path}。` +
        `加上它再重开这个组的容器；在那之前 agent 只能用你在输入框里点名的技能。`,
    });
    skillsMounted = false;
    sb = await make(cacheVolumes);
  }
  live.set(sb.id, sb);
  remember(ctx, scope, sb.id);
  // The utility container gets no mailbox and no `orch`: nothing in it is an
  // agent, so the one interface an agent is allowed would be surface with no
  // user — in the container that holds the real tokens.
  if (!isUtil(scope)) await provision(sb);
  // Mounted is not the same as readable. Once per host path per process, and
  // only when a mount was actually accepted — the fallback above has already
  // said its piece, and "mounted but empty" would be a false description of a
  // container that was built without the mount at all.
  if (skillsMounted) {
    await checkSkillsMount(ctx, sb, skills[0]!.host!.path, skills[0]!.mountPath).catch(() => {});
  }
  // Remembered before this line, so the restore below re-enters here and finds
  // the sandbox it is restoring into rather than building a second one.
  // A credential the CLI can only read from a file. See `filesFor` for why codex
  // is the exception to everything else here.
  const files = filesFor(ctx.db);
  if (Object.keys(files).length) {
    await sb.files.createDirectories([{ path: CODEX_HOME }]).catch(() => {});
    await writeInto(
      sb,
      Object.entries(files).map(([path, data]) => ({ path, data, mode: 600 })),
    ).catch(() => {});
  }
  // The real tokens go to the sidecar, never inside. Bound at creation because
  // `resume` rebuilds the sidecar with an empty vault, and a sandbox with no
  // vault answers 401 rather than saying the vault is missing.
  //
  // `repo` is what makes a group container's GitHub binding read-only: with it,
  // the token is injected on the two paths a fetch uses and on nothing else, so
  // `git push` inside a group leaves with the decoy and GitHub refuses it. The
  // utility container passes nothing and keeps the whole token.
  const { credentials } = await vaultBindings(ctx.db, ctx.config.dataDir ?? "data", {
    repo: isUtil(scope) ? null : remoteOf(ctx, projectId),
  });
  if (credentials.length) {
    await sb.credentialVault
      .create({
        credentials: credentials.map((c) => ({ name: c.name, source: { type: "inline" as const, value: c.value } })),
        bindings: credentials.map((c) => ({ name: c.name, match: matchFor(c), auth: authFor(c) })),
      })
      .catch((e: unknown) => {
        // Said here, because nothing else can say it. This used to claim
        // preflight would report it: preflight runs at boot, and this is a call
        // against a container that did not exist then — it never had a chance.
        //
        // What follows from a silent miss is deterministic and points at the
        // wrong person. No bindings means the decoys stay decoys, every model
        // call 401s, `isAuthFailure` matches, and `handleAuthFailure` pauses the
        // group telling the boss to re-mint a token — so they replace a
        // credential that was never the problem and the new one fails the same
        // way. The group staying alive is right; not naming it is not.
        ctx.bus?.emit({
          grpId: "grp" in scope ? scope.grp : null,
          author: "orchestrator",
          kind: "state_change",
          severity: "blocker",
          body:
            `这个容器的凭据没绑上，里面的假值会原样发出去 —— 接下来每次模型调用都会 401，` +
            `而那不是 token 的问题，重新登录也没用。原因：${(e as Error)?.message ?? e}`.slice(0, 400),
        });
      });
  }
  // A container this fresh has no clone and nothing installed. Imported here
  // rather than at the top because `start.ts` reads this module too, and the
  // cycle only resolves if neither side needs the other while it is loading.
  if ("grp" in scope) {
    const { restoreWorkspace } = await import("./start.ts");
    await restoreWorkspace(ctx, scope.grp).catch((e: unknown) => {
      ctx.bus.emit({
        grpId: scope.grp,
        author: "orchestrator",
        kind: "state_change",
        severity: "warn",
        body: `沙盒重建了，但工作区没装回去：${(e as Error)?.message ?? e}`,
      });
    });
  }
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
function isPathNotAllowed(e: unknown): boolean {
  return /not under any allowed prefix|allowed_host_paths/i.test(String(e));
}

/** Where a group's checkout lives inside its sandbox. */
export const WORK = "/work";

/** Host paths already checked this process; every sandbox mounts the same one. */
const mountChecked = new Set<string>();

/**
 * Did the skills mount actually bring the skills.
 *
 * A bind mount of a host path the container runtime cannot reach does not fail —
 * it succeeds and delivers an **empty directory**. Measured on this machine:
 * `/var/tmp/orch-cache/skills` holds 179 skills, `docker run -v` on that exact
 * path sees 0, and inside the container the mount shows as an overlay with
 * `lowerdir=/` rather than the host directory. macOS runs docker in a VM, and
 * `/var/tmp` there is the VM's, not the Mac's; a path under `$HOME` binds fine.
 *
 * So every agent ran with no skills at all, `skillMounts` returned two correct
 * mounts, creation succeeded, the degrade path never fired, and preflight
 * reported "179 staged" — because it counts them on the host, which is the one
 * place they definitely are. Nothing anywhere was wrong.
 *
 * One `ls` per host path per process, and only when the host directory has
 * something in it: a boss who has ticked no skills gets no noise.
 */
async function checkSkillsMount(ctx: Ctx, sb: Sandbox, hostPath: string, at: string): Promise<void> {
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
  const inside = Number((e?.logs?.stdout ?? []).map((m) => m.text).join("").trim());
  if (!Number.isFinite(inside) || inside > 0) return;
  ctx.bus?.emit({
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
 * The staged skills, mounted where each CLI already looks.
 *
 * HOME is `/root` in the image, so both are the container's user scope. One host
 * directory, two mount paths: a skill is a directory with a SKILL.md either way,
 * and neither CLI cares which of the two directories the boss installed it into.
 */
export function skillMounts(ctx: Ctx): Volume[] {
  // Absolute, and on the server's own allowlist: it reads this as its own
  // filesystem path, rejects anything not starting with `/`, and rejects
  // anything outside `allowed_host_paths` — which is why this is not under
  // `dataDir`. A repo checkout is never on that list.
  const path = resolve(ctx.config?.skillsDir ?? "/var/tmp/orch-cache/skills");
  if (!existsSync(path)) return [];
  return [
    { name: "skills-claude", host: { path }, mountPath: "/root/.claude/skills", readOnly: true },
    { name: "skills-codex", host: { path }, mountPath: `${CODEX_HOME}/skills`, readOnly: true },
  ];
}

/** The agent's only way out: a request is a file here, the answer is another. */
export const MAILBOX_DIR = "/var/orch";

/**
 * Everything the agent needs before its first turn: a mailbox and an `orch`.
 *
 * The CLI is copied in as source rather than installed, for the same reason the
 * host shim is generated rather than compiled — it always matches the running
 * orchestrator, so a route added this morning is not missing from a sandbox
 * started yesterday.
 */
async function provision(sb: Sandbox): Promise<void> {
  const cli = readFileSync(join(ROOT, "src/orch/cli.ts"), "utf8");
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
}

/**
 * Every upload into a container, with one retry.
 *
 * The upload is an HTTP POST to a port on this same machine, and it resets. Live,
 * from the boss's terminal:
 *
 *   error: The socket connection was closed unexpectedly.
 *     path: "http://127.0.0.1:51394/proxy/44772/files/upload", code: "ECONNRESET"
 *
 * No stack, because nothing was awaiting it — and bun treats an unhandled
 * rejection as fatal, so one flaky local socket to one container took the whole
 * fleet down. The backstop in `server.ts` is what stops that being fatal; this is
 * what stops it happening.
 *
 * One retry, which is what a reset local socket is worth: the far end is a
 * container on this machine, not a network, so a reset is the transport hiccuping
 * rather than anything being wrong with the request. A second failure is not a
 * flake, so it throws — with the paths in the message, because the SDK's error
 * carries a URL that says `files/upload` and nothing about which file.
 *
 * Every caller that writes into a container goes through here. Fixing it at the
 * four call sites instead would leave the fifth one somebody adds next month.
 */
export async function writeInto(
  sb: Sandbox,
  files: Parameters<Sandbox["files"]["writeFiles"]>[0],
): Promise<void> {
  try {
    await sb.files.writeFiles(files);
  } catch {
    try {
      await sb.files.writeFiles(files);
    } catch (e) {
      const where = files.map((f) => f.path).join(", ");
      throw new Error(`could not write ${where} into the container: ${(e as Error)?.message ?? e}`);
    }
  }
}

/**
 * Everything the rest of the system does to a sandbox.
 *
 * Injected on `Ctx` the same way `git`, `gh` and `ask` are, and for the same
 * reason: a unit test has no container to talk to, and the alternative — every
 * one of these swallowing its own connection error — is how a silent failure
 * gets to look exactly like success (docs/decisions/001).
 */
export interface SandboxDriver {
  exec(ctx: Ctx, scope: Scope, cmd: string, opts?: ExecOpts): Promise<ExecOutcome>;
  lines(ctx: Ctx, scope: Scope, cmd: string, opts?: ExecOpts): AsyncGenerator<string, { code: number; err: string }, void>;
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
   * Read from the sidecar's own matcher rather than assumed: a pattern ending in
   * `*` is a **prefix**, anything else is compared for equality, and the query
   * string is cut off before the comparison. So a leading wildcard matches
   * nothing at all, and a trailing one — the shape the upstream guide suggests,
   * `/owner/repo.git` plus a star — is useless here, because a prefix does not
   * stop at `/` and would readmit `git-receive-pack`.
   * The path filter is ANDed with the host one and evaluated before it.
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
    ? ({ type: "apiKey" as const, name: c.header, credential: c.name })
    : ({ type: "bearer" as const, credential: c.name });

const driver = (ctx: Ctx): SandboxDriver => ctx.sandbox ?? REAL;

export interface ExecOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Stderr, a line at a time, for callers that are watching rather than parsing.
   *
   * `execLines` yields stdout only, because the agent adapters parse every
   * yielded line as NDJSON. But `git clone --progress` and every package manager
   * print their progress on stderr — so the two commands that take minutes were
   * the two that said nothing until they finished, which is precisely the case
   * the log exists for. Opt-in, so the NDJSON readers are untouched.
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
    workingDirectory: o.cwd,
    timeoutSeconds: o.timeoutMs ? Math.ceil(o.timeoutMs / 1000) : undefined,
    envs: o.env,
  };
}

/**
 * Run one command to completion.
 *
 * ~1s of overhead per call (005), so this is for turns, gates and leases — not
 * for anything chatty. The files API is the cheap channel (1-5ms).
 */
async function realExec(ctx: Ctx, scope: Scope, cmd: string, opts: ExecOpts = {}): Promise<ExecOutcome> {
  const sb = await ensureSandbox(ctx, scope);
  const e = await sb.commands.run(cmd, runOpts(opts), undefined, opts.signal);
  const text = (k: "stdout" | "stderr") => (e.logs?.[k] ?? []).map((m) => m.text).join("");
  return { code: e.exitCode ?? -1, out: text("stdout"), err: text("stderr") };
}

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
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let done = false;
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
        onStdout: (m) => {
          queue.push(...split.push(m.text));
          notify?.();
        },
        onStderr: (m) => {
          stderr += m.text;
          // git writes progress with `\r`, not `\n`, so a clone is one very long
          // line until it ends. Split on both, or the watcher sees nothing.
          if (opts.onStderr) for (const l of errSplit.push(m.text)) opts.onStderr(l);
        },
      },
      opts.signal,
    )
    .then((e) => {
      code = e.exitCode ?? -1;
    })
    .catch((e) => {
      stderr += String(e);
    })
    .finally(() => {
      done = true;
      notify?.();
    });

  while (true) {
    while (queue.length) yield queue.shift()!;
    if (done) break;
    await new Promise<void>((r) => {
      notify = r;
    });
    notify = null;
  }
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
    const r = await execIn(ctx, scope, argv.map(shq).join(" "), { cwd: o.cwd, timeoutMs: o.timeoutMs });
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
 * The sandbox's environment holds format-plausible fakes; the sidecar swaps in
 * the real value on the way out. Measured (005): injection REPLACES an
 * `Authorization` header the CLI already set, so the fake never reaches the
 * wire, and `claude` does not validate its token locally — a synthetic one
 * comes back as a server-side 401, which is exactly what makes this work.
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
  const id = owner(ctx, scope).sandboxId;
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
  remember(ctx, scope, null);
}

/** Push the expiry out. A group mid-turn must not be reaped by its own TTL. */
async function realRenew(ctx: Ctx, scope: Scope): Promise<void> {
  const { sandboxId, projectId } = owner(ctx, scope);
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
 * Every caller reads `.code` — `sandboxGit`, `resourceExec`, and through the
 * first, every helper in `worktree.ts`. None of them is in a try/catch, because
 * a command that fails is a code, and that is the contract this function's shape
 * promises. Two things underneath it break that promise: `ensureSandbox`
 * rethrows when no container can be opened, and `commands.run` is a socket.
 *
 * The consequence was not a wrong answer, it was a **stopped agent**. A lease
 * whose exec rejected skipped `finishLease`, which is the only thing that
 * resolves `ctx.waiters.get('lease:N')` — so the route awaited a promise with no
 * timeout while the agent's `orch` polled a reply that would never be written.
 * The guard for exactly this (`126: the gate could not run`) could not fire,
 * because reaching it required a return. Every way to get there is ordinary: a
 * TTL reap, Docker restarting, the 60s hold expiring mid-gate.
 *
 * So a container that cannot be reached is an exit code with the reason in
 * `err`, which is what every caller already knows how to handle. The hold is
 * still set by `ensureSandbox` on its way through, so the fleet still stops
 * dispatching — this only changes what the call already in flight gets back.
 *
 * Here rather than in `realExec`, so the fake driver's failures land the same way.
 */
export async function execIn(ctx: Ctx, scope: Scope, cmd: string, opts?: ExecOpts): Promise<ExecOutcome> {
  try {
    return await driver(ctx).exec(ctx, scope, cmd, opts);
  } catch (e) {
    return { code: EXEC_UNAVAILABLE, out: "", err: `container unavailable: ${(e as Error)?.message ?? e}` };
  }
}

/** `sh`'s "found it, could not run it". The lease guard already speaks it. */
export const EXEC_UNAVAILABLE = 126;
export const execLines = (ctx: Ctx, scope: Scope, cmd: string, opts?: ExecOpts) => driver(ctx).lines(ctx, scope, cmd, opts);
export const putFile = (ctx: Ctx, scope: Scope, path: string, data: string) => driver(ctx).put(ctx, scope, path, data);
export const getFile = (ctx: Ctx, scope: Scope, path: string) => driver(ctx).get(ctx, scope, path);
export const getBytes = (ctx: Ctx, scope: Scope, path: string) => driver(ctx).getBytes(ctx, scope, path);
export const putBytes = (ctx: Ctx, scope: Scope, path: string, data: Uint8Array) => driver(ctx).putBytes(ctx, scope, path, data);
export const bindCredentials = (ctx: Ctx, scope: Scope, creds: Credential[]) => driver(ctx).bind(ctx, scope, creds);
export const killSandbox = (ctx: Ctx, scope: Scope) => driver(ctx).kill(ctx, scope);
export const renewSandbox = (ctx: Ctx, scope: Scope) => driver(ctx).renew(ctx, scope);
