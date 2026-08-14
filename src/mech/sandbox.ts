import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
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
 * project. Two columns rather than a join table: there are exactly two owners
 * and there is no third in sight.
 */
export type Scope = { grp: number } | { project: number };

const holder = (s: Scope) => ("grp" in s ? { table: "grp", id: s.grp } : { table: "project", id: s.project });

function owner(ctx: Ctx, scope: Scope): { sandboxId: string | null; projectId: number } {
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
  const h = holder(scope);
  ctx.db.run(`UPDATE ${h.table} SET sandbox_id = ? WHERE id = ?`, [id, h.id]);
}

/**
 * The scope's sandbox, created on first use and reconnected after a restart.
 *
 * The id column is the durable half; the Sandbox object is not. A restarted
 * orchestrator reconnects to a sandbox that is still running its TTL out, which
 * is what keeps a turn's session — and therefore its cached prefix — alive
 * across a restart.
 */
export async function ensureSandbox(ctx: Ctx, scope: Scope): Promise<Sandbox> {
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
  const sb = await Sandbox.create({
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
    // `grp-1`, not `grp:1`: metadata values must be alphanumeric plus `-_.`, and
    // a colon is a 400 at creation — which fails the group, not the label.
    volumes: Object.entries(spec.cacheDirs).map(([mountPath, hostPath], i) => ({
      name: `cache-${i}`,
      host: { path: hostPath },
      mountPath,
    })),
    metadata: { owner: `${holder(scope).table}-${holder(scope).id}` },
  });
  live.set(sb.id, sb);
  remember(ctx, scope, sb.id);
  await provision(sb);
  // A credential the CLI can only read from a file. See `filesFor` for why codex
  // is the exception to everything else here.
  const files = filesFor(ctx.db);
  if (Object.keys(files).length) {
    await sb.files.createDirectories([{ path: CODEX_HOME }]).catch(() => {});
    await sb.files
      .writeFiles(Object.entries(files).map(([path, data]) => ({ path, data, mode: 600 })))
      .catch(() => {});
  }
  // The real tokens go to the sidecar, never inside. Bound at creation because
  // `resume` rebuilds the sidecar with an empty vault, and a sandbox with no
  // vault answers 401 rather than saying the vault is missing.
  const { credentials } = await vaultBindings(ctx.db, ctx.config.dataDir ?? "data");
  if (credentials.length) {
    await sb.credentialVault
      .create({
        credentials: credentials.map((c) => ({ name: c.name, source: { type: "inline" as const, value: c.value } })),
        bindings: credentials.map((c) => ({
          name: c.name,
          match: { schemes: ["https" as const], hosts: c.hosts },
          auth: c.header
            ? { type: "apiKey" as const, name: c.header, credential: c.name }
            : { type: "bearer" as const, credential: c.name },
        })),
      })
      .catch(() => {
        // Reported by preflight, not swallowed here — but a group that cannot
        // bind must still be a group, or one bad config wedges the whole fleet.
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

/** Where a group's checkout lives inside its sandbox. */
export const WORK = "/work";

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
  await sb.files.writeFiles([
    { path: "/opt/orch/cli.ts", data: cli, mode: FILE_MODE },
    { path: "/usr/local/bin/orch", data: '#!/bin/sh\nexec bun run /opt/orch/cli.ts "$@"\n', mode: EXEC_MODE },
  ]);
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
}

const driver = (ctx: Ctx): SandboxDriver => ctx.sandbox ?? REAL;

export interface ExecOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
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
      const parts = buf.split("\n");
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
  await sb.files.writeFiles([{ path, data, mode: FILE_MODE }]);
}

/** Binary write, for the same reason as `getBytes`. */
async function realPutBytes(ctx: Ctx, scope: Scope, path: string, data: Uint8Array): Promise<void> {
  const sb = await ensureSandbox(ctx, scope);
  await sb.files.writeFiles([{ path, data, mode: FILE_MODE }]);
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
    bindings: creds.map((c) => ({
      name: c.name,
      match: { schemes: ["https" as const], hosts: c.hosts },
      auth: c.header
        ? { type: "apiKey" as const, name: c.header, credential: c.name }
        : { type: "bearer" as const, credential: c.name },
    })),
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

export const execIn = (ctx: Ctx, scope: Scope, cmd: string, opts?: ExecOpts) => driver(ctx).exec(ctx, scope, cmd, opts);
export const execLines = (ctx: Ctx, scope: Scope, cmd: string, opts?: ExecOpts) => driver(ctx).lines(ctx, scope, cmd, opts);
export const putFile = (ctx: Ctx, scope: Scope, path: string, data: string) => driver(ctx).put(ctx, scope, path, data);
export const getFile = (ctx: Ctx, scope: Scope, path: string) => driver(ctx).get(ctx, scope, path);
export const getBytes = (ctx: Ctx, scope: Scope, path: string) => driver(ctx).getBytes(ctx, scope, path);
export const putBytes = (ctx: Ctx, scope: Scope, path: string, data: Uint8Array) => driver(ctx).putBytes(ctx, scope, path, data);
export const bindCredentials = (ctx: Ctx, scope: Scope, creds: Credential[]) => driver(ctx).bind(ctx, scope, creds);
export const killSandbox = (ctx: Ctx, scope: Scope) => driver(ctx).kill(ctx, scope);
export const renewSandbox = (ctx: Ctx, scope: Scope) => driver(ctx).renew(ctx, scope);
