import { msg } from "@lingui/core/macro";
import { existsSync, readdirSync } from "node:fs";
import { activeTracer } from "../../platform/observability/traces.ts";
import { resolve } from "node:path";
import { readSetting, type DB } from "../../platform/persistence/database.ts";
import { loadAuth, sandboxKeyFor, type RuntimeAuth } from "../sandbox/auth.ts";
import {
  allowedHostPaths,
  coveredBy,
  hasRegistry,
  hostPathForDaemon,
  SANDBOX_API_KEY_HEADER,
} from "../sandbox/sandbox.ts";
import { isStale, parseAuth } from "../sandbox/chatgpt.ts";
import { decode } from "hono/jwt";
import { z } from "zod";
import { isNotNull } from "drizzle-orm";
import { plural } from "@lingui/core/macro";
import type { Said } from "../../contracts/said.ts";
import { renderSaid } from "../../platform/text/lang.ts";
import { agent, grp, project } from "../../platform/persistence/schema.ts";
import { DEFAULTS_FOR_CHECK as DEFAULTS, type Config } from "../../platform/config/load.ts";

/**
 * What has to be true before any agent can run, checked once. Every one of these
 * fails silently if you let it.
 *
 * This reports; it does **not** refuse to start, because the panel is where
 * three of them are fixed — a server that will not boot without a sandbox key
 * cannot be given one. The hold in `sandbox.ts` is what gates: with no container
 * to open, turns are not dispatched at all. `missingBinaries` in server.ts is
 * the only fatal check.
 */

export interface Check {
  name: string;
  ok: boolean;
  /** English, rendered from `MESSAGES.en`. `/readyz`, the console and the panel's fallback read this. */
  detail: string;
  /** How the boss fixes it. */
  fix?: string;
  /** The same sentence as a key and its values, for a panel that holds ten catalogues. */
  said: Said;
  fixSaid?: Said;
}

/**
 * One check, said twice: English for the log, the descriptor for the panel.
 *
 * `/readyz` is read by monitoring and `report()` writes a log, so both stay
 * English whatever the panel is set to — `renderSaid("en", …)` is the same door
 * the event bus renders through, and English is the `message` the macro hashed.
 */
export function makeCheck(name: string, ok: boolean, said: Said, fix?: Said): Check {
  return {
    name,
    ok,
    detail: renderSaid("en", said),
    said,
    ...(fix ? { fix: renderSaid("en", fix), fixSaid: fix } : {}),
  };
}

/**
 * Can we actually drive this server, not merely reach it.
 *
 * `/v1/sandboxes` is the cheapest *authenticated* call — a list, no side effect.
 * An unauthenticated endpoint answers for a server that rejects every real call.
 */
/**
 * What the server says it is holding, when it answers at all.
 *
 * Read from the reply this probe already makes, rather than asked for
 * separately: the reachability check calls `/v1/sandboxes` and threw the body
 * away, so counting what is out there costs nothing it was not already paying.
 */
const SandboxList = z.looseObject({
  items: z
    .array(z.looseObject({ id: z.string(), metadata: z.looseObject({ owner: z.string().optional() }).optional() }))
    .optional(),
});

/** Above any fleet this is meant for. A page of twenty answered "is it up" and
 *  would answer "how many are stranded" with a number that is always twenty. */
const LIST_PAGE = 500;

async function reachable(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<Verdict & { held?: { id: string; owner: string }[] }> {
  try {
    // fallow-ignore-next-line security-sink -- the one caller builds `url` from `cfg.sandbox.server`, the address the boss set for their own sandbox server, and `sandboxKeyFor` is what makes "the key stored for that same address" true rather than assumed: a stored key carries the address it was accepted by, and is withheld when the two disagree.
    const res = await fetch(`${url}/v1/sandboxes?page_size=${LIST_PAGE}`, {
      headers: apiKey ? { [SANDBOX_API_KEY_HEADER]: apiKey } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const body = SandboxList.safeParse(await res.json().catch(() => null)).data;
      const held = (body?.items ?? [])
        .filter((s) => s.metadata?.owner)
        .map((s) => ({ id: s.id, owner: s.metadata?.owner ?? "" }));
      return { ok: true, said: msg`reachable`, held };
    }
    // The two the boss can act on, said in their own words.
    if (res.status === 401) {
      const why = await res.text().catch(() => "");
      return {
        ok: false,
        said: why.includes("MISSING")
          ? msg`server requires an API key and none was sent`
          : msg`server rejected the API key`,
      };
    }
    return { ok: false, said: msg`HTTP ${{ status: res.status }}` };
  } catch (e) {
    return { ok: false, said: msg`cannot reach it: ${{ error: String(e).slice(0, 120) }}` };
  }
}

/**
 * Does the provider accept this credential, right now — not whether one exists,
 * because a token that expired last week exists.
 *
 * `GET /v1/models` on both sides: free, no side effect, and it answers 401 for
 * exactly the thing being asked. A ChatGPT login needs no request at all — what
 * expires is inside the JWT it stores. Cached, because the settings page asks on
 * every open.
 */
const seen = new Map<string, { at: number; ok: boolean; said: Said }>();

const accepted: Verify = async (runtime, auth, cfg = DEFAULTS) => {
  // Hashed, not a tail: a pasted auth.json ends in `"}}` no matter whose login
  // it is, so a tail collides and reports one credential's verdict for another.
  const key = `${runtime}:${auth.mode}:${Bun.hash(auth.secret)}:${auth.baseUrl ?? ""}`;
  const hit = seen.get(key);
  // The same window the reachability probe re-asks on: both are "we asked this
  // recently enough", which is why they are one setting.
  if (hit && Date.now() - hit.at < cfg.intervals.recheckMs) return { ok: hit.ok, said: hit.said };

  const out = await ask(runtime, auth, cfg.timeouts.credentialCheckMs);
  seen.set(key, { at: Date.now(), ...out });
  return out;
};

/**
 * These are host `fetch`es carrying the real token, and they stay that way.
 *
 * Every other model credential reaches the wire from inside the utility
 * container. This is the deliberate exception: it runs at boot, before any
 * container is guaranteed to exist, and moving it would make "can we open a
 * container" a prerequisite for reporting that we cannot. **A check that needs
 * the thing it checks is not a check.**
 */
async function ask(runtime: string, auth: RuntimeAuth, timeoutMs: number): Promise<Verdict> {
  if (auth.mode === "chatgpt") return chatgptAccepted(auth);
  if (runtime === "github") return githubAccepted(auth, timeoutMs);
  return modelAccepted(runtime, auth, timeoutMs);
}

function chatgptAccepted(auth: RuntimeAuth): Verdict {
  const mode = auth.mode;
  // The refresh token is what matters and it is not ours to test; the access
  // token carries its own expiry, and codex rotates it from the host.
  const exp = jwtExpiry(parseAuth(auth.secret)?.tokens?.access_token);
  if (!exp) return { ok: true, said: msg`${{ mode }} · stored` };
  const days = Math.round((exp - Date.now()) / 86_400_000);
  if (exp <= Date.now()) return { ok: false, said: msg`${{ mode }} · expired — sign in again` };
  return {
    ok: true,
    said: days >= 1 ? msg`${{ mode }} · ${{ days }} days left` : msg`${{ mode }} · expires within a day`,
  };
}

async function githubAccepted(auth: RuntimeAuth, timeoutMs: number): Promise<Verdict> {
  const mode = auth.mode;
  // GitHub is not a model provider and has no `/v1/models`. A missing credential
  // otherwise surfaces only when the utility container tries to push a branch.
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${auth.secret}`, "user-agent": "orchestrator" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return { ok: true, said: msg`${{ mode }} · accepted` };
    // GitHub deliberately uses 404 for resources a token cannot see.
    if ([401, 403, 404].includes(response.status))
      return { ok: false, said: msg`${{ mode }} · GitHub no longer accepts this token` };
    return { ok: true, said: msg`${{ mode }} · not verified (HTTP ${{ status: response.status }})` };
  } catch {
    return { ok: true, said: msg`${{ mode }} · unreachable, not verified` };
  }
}

/**
 * Where to ask, and how to present the credential while asking.
 *
 * An OAuth token travels as `Authorization: Bearer`; an API key as `x-api-key`.
 * Sending the wrong one is 401 either way, so a check built on the wrong header
 * reports "not accepted" about a credential that was never presented.
 *
 * A gateway's own address wins over both defaults, trailing slashes trimmed:
 * `https://gw/` produces `https://gw//v1/models`, which some proxies 404.
 */
export function modelProbe(runtime: string, auth: RuntimeAuth): { url: string; headers: Record<string, string> } {
  const base =
    auth.baseUrl?.replace(/\/+$/, "") ??
    (runtime === "claude" ? "https://api.anthropic.com" : "https://api.openai.com");
  const headers: Record<string, string> =
    runtime === "claude"
      ? {
          ...(auth.mode === "api_key" ? { "x-api-key": auth.secret } : { Authorization: `Bearer ${auth.secret}` }),
          "anthropic-version": "2023-06-01",
        }
      : { Authorization: `Bearer ${auth.secret}` };
  return { url: `${base}/v1/models?limit=1`, headers };
}

/**
 * What the answer says about the credential, and only about the credential.
 *
 * A gateway that answers something else is not a credential problem, and saying
 * it is would send the boss to re-paste a token that was fine. Only 401 and 403
 * are the token; everything else is reported as unverified, which is what it is.
 */
export function credentialVerdict(status: number, mode: string): Verdict {
  if (status >= 200 && status < 300) return { ok: true, said: msg`${{ mode }} · accepted` };
  if (status === 401 || status === 403)
    return { ok: false, said: msg`${{ mode }} · the provider rejected this credential` };
  return { ok: true, said: msg`${{ mode }} · not verified (HTTP ${{ status }})` };
}

async function modelAccepted(runtime: string, auth: RuntimeAuth, timeoutMs: number): Promise<Verdict> {
  const mode = auth.mode;
  const { url, headers } = modelProbe(runtime, auth);
  try {
    // fallow-ignore-next-line security-sink -- `modelProbe` builds the URL from the provider default or `runtime_auth.base_url`, and the secret it sends is the one stored in that same row; the gateway and the credential are set together by the boss and cannot be substituted for each other.
    return credentialVerdict((await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })).status, auth.mode);
  } catch {
    return { ok: true, said: msg`${{ mode }} · unreachable, not verified` };
  }
}

/** `exp` out of a JWT, in ms. Null when it is not one. */
const JwtExpiry = z.object({ exp: z.number() });

function jwtExpiry(token?: string): number | null {
  if (!token) return null;
  try {
    const payload = JwtExpiry.safeParse(decode(token).payload);
    return payload.success ? payload.data.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Is the orchestrator itself inside a container?
 *
 * Three checks — docker, uv, the sidecar image — are about the machine running the
 * sandbox server, which in a container is somebody else's. Asked anyway they answer
 * "broken" about a working deployment, and print fixes for a host this process
 * cannot see.
 *
 * `ORCH_IN_CONTAINER` is our own Dockerfile's; `/.dockerenv` is the fallback.
 */
const inContainer = (): boolean => process.env.ORCH_IN_CONTAINER === "1" || existsSync("/.dockerenv");

export interface PreflightInput {
  db: DB;
  sandbox: { server: string; apiKey: string; image: string };
  /** Where the staged skills live; the server must allow this path. */
  skillsDir?: string;
  /** Host paths mounted into every sandbox of a project; same allowlist applies. */
  cacheDirs?: Record<string, string>;
  /** Injected in tests; defaults to `inContainer()`. */
  contained?: boolean;
  /** Injected in tests. */
  /** `argv` defaults to `--version`; the docker check needs `info` (the daemon, not the binary). */
  probe?: (bin: string, argv?: string[]) => boolean;
  /** Injected in tests: the real one asks the provider whether it still works. */
  verify?: Verify;
  /**
   * The live `Config`, for the three waits in here. Reads the shipped defaults
   * when absent, so a test need not build one.
   */
  cfg?: Config;
}

/**
 * How a credential is verified. `cfg` is optional so a test's two-argument spy
 * still satisfies it — the real one reads two timeouts out of it.
 */
export type Verify = (runtime: string, auth: RuntimeAuth, cfg?: Config) => Promise<Verdict>;

/** What one credential probe found, before the mode is folded into it. */
export interface Verdict {
  ok: boolean;
  said: Said;
}

/** Is this exact image:tag on this machine? */
function localImages(ref: string): boolean {
  try {
    const p = Bun.spawnSync(["docker", "image", "inspect", ref], { stdout: "ignore", stderr: "ignore" });
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

/** Tags of the egress images on this machine. */
function egressImages(): string[] {
  try {
    const p = Bun.spawnSync(["docker", "images", "--format", "{{.Tag}}", "opensandbox/egress"], { stdout: "pipe" });
    return p.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** v1.1.6 is the first release with the scoped-package fix. */
export function newEnough(tag: string, min = [1, 1, 6]): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  if (!m) return true; // `latest`, a digest, something hand-built: not ours to judge
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (got[i]! > min[i]!) return true;
    if (got[i]! < min[i]!) return false;
  }
  return true;
}

type Probe = (bin: string, argv?: string[]) => boolean;

const defaultProbe: Probe = (bin, argv = ["--version"]) => {
  try {
    return Bun.spawnSync([bin, ...argv], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
};

function dockerCheck(docker: boolean, installed: boolean): Check {
  return makeCheck(
    "docker",
    docker,
    docker ? msg`running` : installed ? msg`installed, but the daemon is not answering` : msg`not reachable`,
    installed
      ? msg`Start Docker Desktop, or run colima start, and wait for it to report running.`
      : msg`Install Docker — or Colima, or Podman, anything that provides a docker socket — and start it.`,
  );
}

function hostToolChecks(contained: boolean, probe: Probe): { checks: Check[]; docker: boolean } {
  if (contained) return { checks: [], docker: false };
  const docker = probe("docker", ["info"]);
  const installed = docker || probe("docker");
  const uvx = probe("uvx");
  return {
    docker,
    checks: [
      dockerCheck(docker, installed),
      makeCheck(
        "uv / python",
        uvx,
        uvx ? msg`uvx available` : msg`no uvx on PATH`,
        msg`Run brew install uv. opensandbox-server is a Python package, so without uv there is nothing to start.`,
      ),
    ],
  };
}

function sandboxServerCheck(input: PreflightInput, contained: boolean, server: Verdict): Check {
  return makeCheck(
    "opensandbox-server",
    server.ok,
    server.said,
    contained
      ? msg`Run uvx opensandbox-server on the host, not here: this orchestrator is inside a container and the sandbox server needs the host's docker. Then point ORCH_SANDBOX_SERVER at it — host.docker.internal:8080 on Docker Desktop, the host IP or --network host on Linux.`
      : msg`Run uvx opensandbox-server --config ~/.sandbox.toml listening on ${{ server: input.sandbox.server }}, with [egress] mode = "dns+nft".`,
  );
}

function hostEnvironmentCheck(contained: boolean): Check | null {
  if (!contained) return null;
  return makeCheck(
    "host environment",
    true,
    msg`docker, uv and the egress image belong to the machine running the sandbox server, not to this one`,
    msg`On that machine: install docker, run uvx opensandbox-server, and docker pull opensandbox/egress:v1.1.6.`,
  );
}

/**
 * Sandboxes the server is holding that nothing here claims.
 *
 * Ours by the `owner` label we set, and unclaimed by every column that can name
 * one: a group's, a project's, and the utility id in `setting`. Anything else on
 * that server belongs to somebody else and is not counted.
 */
export async function strandedCheck(db: DB, held: { id: string; owner: string }[] | undefined): Promise<Check | null> {
  // No list means the server did not answer, which is already a row of its own.
  if (!held?.length) return null;
  const claimed = new Set<string>();
  for (const row of await db.select({ id: grp.sandbox_id }).from(grp).where(isNotNull(grp.sandbox_id))) {
    if (row.id) claimed.add(row.id);
  }
  for (const row of await db.select({ id: project.sandbox_id }).from(project).where(isNotNull(project.sandbox_id))) {
    if (row.id) claimed.add(row.id);
  }
  const util = await readSetting(db, "util_sandbox_id");
  if (util) claimed.add(util);

  const ours = held.filter((s) => /^(grp|project)-\d+$|^util$/.test(s.owner));
  const stranded = ours.filter((s) => !claimed.has(s.id));
  if (stranded.length === 0) return null;
  return makeCheck(
    "stranded sandboxes",
    false,
    msg`${plural({ n: stranded.length }, { one: "# container is", other: "# containers are" })} running that nothing here is using`,
    msg`They were ours and are no longer claimed by any group, project or the utility slot — each holds memory until its TTL expires. A restart does not reclaim them; delete them on the sandbox server.`,
  );
}

function sandboxAuthCheck(serverOk: boolean, key: string): Check | null {
  if (!serverOk || key) return null;
  return makeCheck(
    "sandbox server auth",
    false,
    msg`the server asks for no API key, so any process on this machine can enter a container`,
    msg`Set [server] api_key = "…" in the server's TOML, restart it, then Settings → Sandbox server → Read from server. The containers hold the checkout, the mailbox token and the CLI logins.`,
  );
}

/** Tag lists are values, joined here because a docker tag is not a translated word. */
function egressDetail(good: string[], stale: string[]): Said {
  if (good.length === 0 && stale.length === 0) return msg`no opensandbox/egress image pulled`;
  if (good.length === 0) return msg`only ${{ stale: stale.join(", ") }}, which is too old`;
  if (stale.length > 0)
    return msg`${{ good: good.join(", ") }} (also has ${{ stale: stale.join(", ") }} — check [egress] image)`;
  return msg`${{ good: good.join(", ") }}`;
}

function egressCheck(contained: boolean, probe: Probe): Check | null {
  if (contained) return null;
  const egress = probe("docker") ? egressImages() : [];
  const good = egress.filter((tag) => newEnough(tag));
  const stale = egress.filter((tag) => !newEnough(tag));
  return makeCheck(
    "egress sidecar",
    good.length > 0,
    egressDetail(good, stale),
    msg`Run docker pull opensandbox/egress:v1.1.6, then point [egress] image at it. v1.1.4 403s every scoped package as soon as a credential is bound.`,
  );
}

function agentImageCheck(image: string, docker: boolean): Check | null {
  if (hasRegistry(image) || (docker && localImages(image))) return null;
  return makeCheck(
    "agent image",
    false,
    msg`${{ image }} is not on this machine`,
    msg`Run docker build -f docker/agent.Dockerfile -t ${{ image }} . — an image with no registry prefix can only be built locally.`,
  );
}

function skillsMountCheck(input: PreflightInput, contained: boolean): { check: Check; staged: string } {
  const staged = resolve(input.skillsDir ?? "/var/tmp/orch-cache/skills");
  const skills = existsSync(staged) ? readdirSync(staged).length : 0;
  return {
    staged,
    check: makeCheck(
      "skills mount",
      skills > 0,
      skills ? msg`${{ count: skills }} staged at ${{ path: staged }}` : msg`no skills ticked`,
      contained
        ? msg`${{ path: staged }} is a path inside this container, and the mount is made by the sandbox server's docker, which resolves it on its own filesystem. Use one absolute path on both sides (-v <host path>:${{ path: staged }}) and add it to the sandbox server's allowed_host_paths. A mismatch does not fail; it mounts an empty directory.`
        : msg`Add ${{ path: staged }} to the sandbox server's allowed_host_paths, or every group fails to open a container. Tick the skills in Settings.`,
    ),
  };
}

function allowedPathsCheck(input: PreflightInput, staged: string): Check {
  const allowed = allowedHostPaths();
  const wanted = [staged, ...Object.values(input.cacheDirs ?? {})].map((path) => hostPathForDaemon(resolve(path)));
  const missing = allowed ? wanted.filter((path) => !coveredBy(allowed.paths, path)) : [];
  const detail: Said = !allowed
    ? msg`no opensandbox-server config file found, so there is nothing to check against`
    : missing.length
      ? msg`${{ config: allowed.config }} does not list ${{ missing: missing.join(", ") }}`
      : msg`${{ config: allowed.config }} covers all ${{ count: wanted.length }} paths to be mounted`;
  const fix: Said | undefined =
    allowed && missing.length
      ? msg`Put this line in the [sandbox] section of ${{ config: allowed.config }}, then restart opensandbox-server: allowed_host_paths = [${{ line: [...allowed.paths, ...missing].map((path) => `"${path}"`).join(", ") }}]`
      : undefined;
  return makeCheck("allowed_host_paths", !allowed || missing.length === 0, detail, fix);
}

function credentialFix(runtime: string): Said {
  if (runtime === "claude")
    return msg`Settings → Claude → sign in. It runs the official claude setup-token inside the utility container, so nothing is installed here; paste the code that page gives you back into the input and it is stored. Good for a year.`;
  if (runtime === "github")
    return msg`Connect GitHub once in Settings. Branches are pushed with it — without one, every slice is refused at its last step.`;
  return msg`Settings → codex → sign in, which runs the official device-code flow; codex is not installed here. Pasting an API key works too.`;
}

async function credentialRuntimes(db: DB): Promise<string[]> {
  const rows = await db.selectDistinct({ runtime: agent.runtime }).from(agent).where(isNotNull(agent.runtime));
  const runtimes = new Set(rows.flatMap(({ runtime }) => (runtime === null ? [] : [runtime])));
  runtimes.add("claude");
  runtimes.add("codex");
  runtimes.add("github");
  return [...runtimes].sort();
}

async function credentialCheck(input: PreflightInput, runtime: string): Promise<Check> {
  const name = `credential:${runtime}`;
  const auth = await loadAuth(input.db, runtime);
  if (!auth) return makeCheck(name, false, msg`not configured`, credentialFix(runtime));
  const live = await (input.verify ?? accepted)(runtime, auth, input.cfg ?? DEFAULTS);
  // `mode` is interpolated where each sentence is written — `api_key` is an
  // identifier the panel prints, not a word it translates, and merging it into
  // somebody else's `values` afterwards was a second place to keep in step.
  return makeCheck(name, live.ok, live.said, credentialFix(runtime));
}

async function codexRefresherCheck(db: DB): Promise<Check | null> {
  const auth = await loadAuth(db, "codex");
  if (auth?.mode !== "chatgpt") return null;
  const parsed = parseAuth(auth.secret);
  const stale = !parsed || isStale(parsed);
  return makeCheck(
    "codex-refresher",
    !stale,
    stale
      ? msg`this ChatGPT login is old enough to need renewing — the next container renews it, and if that keeps failing the auth.json has to be pasted again`
      : msg`the login is fresh; renewal runs inside the utility container, so codex is not needed here`,
    msg`Renewal runs the real codex inside the utility container. If it keeps failing, paste ~/.codex/auth.json again in Settings, or switch to an API key — an API key never needs renewing.`,
  );
}

export async function preflight(input: PreflightInput): Promise<Check[]> {
  // Timed for what is inside it: three network probes with 3–6s timeouts and
  // three `spawnSync` calls that **block the event loop**, which shows up as
  // every *other* span being slow. Covers the readiness ticker; the HTTP route
  // was already timed.
  return activeTracer().startActiveSpan("preflight.check", async (span) => {
    try {
      return await preflightInner(input);
    } finally {
      span.end();
    }
  });
}

async function preflightInner(input: PreflightInput): Promise<Check[]> {
  const out: Check[] = [];
  // Injectable so a test can assert both deployments without a container.
  const contained = input.contained ?? inContainer();
  const probe = input.probe ?? defaultProbe;

  // `docker info`, not `docker --version`: with the daemon down the binary still
  // exits 0, so `--version` reports "running" while every `ensureSandbox` fails.
  // Both are asked, because the answers send the boss to different places: not
  // installed at all is a download, installed but not started is one click.
  const hostTools = hostToolChecks(contained, probe);
  const docker = hostTools.docker;
  out.push(...hostTools.checks);

  // The same order `connection()` resolves it in: panel, then environment, then
  // the yaml. Checking a different key than the one the turns use is how a green
  // tick sat next to a fleet that could not open a single container.
  const key = await sandboxKeyFor(input.db, input.sandbox.server, input.sandbox.apiKey);
  const server = await reachable(`http://${input.sandbox.server}`, key, (input.cfg ?? DEFAULTS).timeouts.sandboxPingMs);
  out.push(sandboxServerCheck(input, contained, server));

  // One row instead of the three above, and only in a container. Said once
  // rather than dropped silently, so the pane shows where those questions went.
  const hostEnvironment = hostEnvironmentCheck(contained);
  if (hostEnvironment) out.push(hostEnvironment);

  // Answering without a key is not a configuration detail: the containers hold
  // the checkout, the mailbox token and the CLI logins, so any process that can
  // reach loopback can exec into one. Only when reachable AND we sent no key — a
  // server that refuses us is already reported above.
  const sandboxAuth = sandboxAuthCheck(server.ok, key);
  if (sandboxAuth) out.push(sandboxAuth);

  // Containers nobody can reach any more. The only reason the last batch was
  // found is that a machine ran out of memory: 48 of them against a `grp` table
  // with no rows, each holding ~250 MB with a 24-hour TTL, and not one word
  // about it anywhere in the panel.
  const stranded = await strandedCheck(input.db, server.held);
  if (stranded) out.push(stranded);

  // v1.1.4 — the version the example config ships — 403s every scoped package
  // fetch while a credential is bound, and the symptom reads as "this project
  // cannot install its dependencies". Checked by image tag rather than by
  // probing, because probing means creating a sandbox on every boot (adr/005).
  // Which tag the sidecar runs is in the server's own TOML, not ours to read, so
  // this reports what is available and the fix line says to point at it.
  const egress = egressCheck(contained, probe);
  if (egress) out.push(egress);

  // Reported only when it can fail: a published image is pulled by the sandbox
  // server on first build, and a row that is always green is a row nobody reads.
  // A tag with no registry in front of it has nowhere to be pulled from, and
  // fails every sandbox with a pull error that reads like a network problem.
  const agentImage = agentImageCheck(input.sandbox.image, docker);
  if (agentImage) out.push(agentImage);

  // Says which path has to be in the server's `allowed_host_paths` rather than
  // pretending to have checked it. A path that is not allowed fails sandbox
  // creation for every group at once.
  const skillsMount = skillsMountCheck(input, contained);
  out.push(skillsMount.check);

  // The line above says which path has to be allowed; this says whether it is.
  // The quiet half is why it exists: when the runtime cannot reach the path it
  // mounts an empty directory over it, which nothing notices, and agents run
  // without the skills the boss ticked. Prints the fix line rather than
  // describing it. Paths compare as the daemon sees them (WSL `/mnt/c/...`).
  out.push(allowedPathsCheck(input, skillsMount.staged));

  // Credentials are per runtime and live in the DB, never in an event or a
  // prompt.
  const runtimes = await credentialRuntimes(input.db);
  out.push(...(await Promise.all(runtimes.map((runtime) => credentialCheck(input, runtime)))));

  // A ChatGPT-account login is a pair of tokens codex itself rotates, renewed by
  // running the real `codex` rather than posting the refresh token ourselves
  // (chatgpt.ts says why). The failure is silent and delayed: `renew` returns
  // null, the stored token is kept, and hours later every codex turn 401s looking
  // like an expired account. The other modes need nothing here.
  const codexRefresher = await codexRefresherCheck(input.db);
  if (codexRefresher) out.push(codexRefresher);

  return out;
}

/** One line per failure, for the console. Empty when everything passed. */
export function report(checks: Check[]): string {
  const bad = checks.filter((c) => !c.ok);
  if (!bad.length) return "";
  return bad.map((c) => `  ✗ ${c.name}: ${c.detail}${c.fix ? `\n      → ${c.fix}` : ""}`).join("\n");
}
