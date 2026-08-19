import { existsSync, readdirSync } from "node:fs";
import { activeTracer } from "../../platform/observability/traces.ts";
import { resolve } from "node:path";
import type { DB } from "../../platform/persistence/database.ts";
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
  detail: string;
  /** How the boss fixes it. Shown verbatim. */
  fix?: string;
}

/**
 * Can we actually drive this server, not merely reach it.
 *
 * `/v1/sandboxes` is the cheapest *authenticated* call — a list, no side effect.
 * An unauthenticated endpoint answers for a server that rejects every real call.
 */
async function reachable(url: string, apiKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    // fallow-ignore-next-line security-sink -- the one caller builds `url` from `cfg.sandbox.server`, the address the boss set for their own sandbox server, and `sandboxKeyFor` is what makes "the key stored for that same address" true rather than assumed: a stored key carries the address it was accepted by, and is withheld when the two disagree.
    const res = await fetch(`${url}/v1/sandboxes`, {
      headers: apiKey ? { [SANDBOX_API_KEY_HEADER]: apiKey } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return { ok: true, detail: "reachable" };
    // The two the boss can act on, said in their own words.
    if (res.status === 401) {
      const why = await res.text().catch(() => "");
      return {
        ok: false,
        detail: why.includes("MISSING") ? "服务器开了鉴权，我们没带密钥" : "密钥不对，服务器不认",
      };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 120) };
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
const seen = new Map<string, { at: number; ok: boolean; detail: string }>();
const CACHE_MS = 5 * 60_000;

async function accepted(runtime: string, auth: RuntimeAuth): Promise<{ ok: boolean; detail: string }> {
  // Hashed, not a tail: a pasted auth.json ends in `"}}` no matter whose login
  // it is, so a tail collides and reports one credential's verdict for another.
  const key = `${runtime}:${auth.mode}:${Bun.hash(auth.secret)}:${auth.baseUrl ?? ""}`;
  const hit = seen.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ok: hit.ok, detail: hit.detail };

  const out = await ask(runtime, auth);
  seen.set(key, { at: Date.now(), ...out });
  return out;
}

/**
 * These are host `fetch`es carrying the real token, and they stay that way.
 *
 * Every other model credential reaches the wire from inside the utility
 * container. This is the deliberate exception: it runs at boot, before any
 * container is guaranteed to exist, and moving it would make "can we open a
 * container" a prerequisite for reporting that we cannot. **A check that needs
 * the thing it checks is not a check.**
 */
async function ask(runtime: string, auth: RuntimeAuth): Promise<{ ok: boolean; detail: string }> {
  if (auth.mode === "chatgpt") return chatgptAccepted(auth);
  if (runtime === "github") return githubAccepted(auth);
  return modelAccepted(runtime, auth);
}

function chatgptAccepted(auth: RuntimeAuth): { ok: boolean; detail: string } {
  // The refresh token is what matters and it is not ours to test; the access
  // token carries its own expiry, and codex rotates it from the host.
  const exp = jwtExpiry(parseAuth(auth.secret)?.tokens?.access_token);
  if (!exp) return { ok: true, detail: "存着" };
  const days = Math.round((exp - Date.now()) / 86_400_000);
  if (exp <= Date.now()) return { ok: false, detail: "过期了，重新登录一次" };
  return { ok: true, detail: days >= 1 ? `还有 ${days} 天` : "快过期了" };
}

async function githubAccepted(auth: RuntimeAuth): Promise<{ ok: boolean; detail: string }> {
  // GitHub is not a model provider and has no `/v1/models`. A missing credential
  // otherwise surfaces only when the utility container tries to push a branch.
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${auth.secret}`, "user-agent": "orchestrator" },
      signal: AbortSignal.timeout(6000),
    });
    if (response.ok) return { ok: true, detail: "能用" };
    // GitHub deliberately uses 404 for resources a token cannot see.
    if ([401, 403, 404].includes(response.status)) return { ok: false, detail: "GitHub 不认这个 token 了" };
    return { ok: true, detail: `没验成（HTTP ${response.status}）` };
  } catch {
    return { ok: true, detail: "连不上，没验" };
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
export function credentialVerdict(status: number): { ok: boolean; detail: string } {
  if (status >= 200 && status < 300) return { ok: true, detail: "能用" };
  if (status === 401 || status === 403) return { ok: false, detail: "对面不认这个凭据" };
  return { ok: true, detail: `没验成（HTTP ${status}）` };
}

async function modelAccepted(runtime: string, auth: RuntimeAuth): Promise<{ ok: boolean; detail: string }> {
  const { url, headers } = modelProbe(runtime, auth);
  try {
    // fallow-ignore-next-line security-sink -- `modelProbe` builds the URL from the provider default or `runtime_auth.base_url`, and the secret it sends is the one stored in that same row; the gateway and the credential are set together by the boss and cannot be substituted for each other.
    return credentialVerdict((await fetch(url, { headers, signal: AbortSignal.timeout(6000) })).status);
  } catch {
    return { ok: true, detail: "连不上，没验" };
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
  verify?: (runtime: string, auth: RuntimeAuth) => Promise<{ ok: boolean; detail: string }>;
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
  return {
    name: "docker",
    ok: docker,
    detail: docker ? "running" : installed ? "装了，但没启动（daemon 不理人）" : "not reachable",
    fix: installed
      ? "Docker 装了但没跑起来 —— 启动 Docker Desktop（或 colima start），等它变绿再回来。"
      : "装 Docker（或 Colima / Podman，任何提供 docker socket 的都行）并启动。",
  };
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
      {
        name: "uv / python",
        ok: uvx,
        detail: uvx ? "uvx available" : "no uvx on PATH",
        fix: "brew install uv —— opensandbox-server 是个 Python 包，没有它就没东西可启动。",
      },
    ],
  };
}

function sandboxServerCheck(input: PreflightInput, contained: boolean, server: { ok: boolean; detail: string }): Check {
  return {
    name: "opensandbox-server",
    ok: server.ok,
    detail: server.detail,
    fix: contained
      ? `这个 orchestrator 跑在容器里，起不了沙盒服务器，也不该起 —— 它要的是宿主的 docker。` +
        `在宿主上跑 uvx opensandbox-server，然后用 ORCH_SANDBOX_SERVER 指过去` +
        `（Docker Desktop 上是 host.docker.internal:8080，Linux 上用宿主 IP 或 --network host）。`
      : `uvx opensandbox-server --config ~/.sandbox.toml，监听 ${input.sandbox.server}，[egress] mode 要是 "dns+nft"`,
  };
}

function hostEnvironmentCheck(contained: boolean): Check | null {
  if (!contained) return null;
  return {
    name: "宿主环境",
    ok: true,
    detail: "docker、uv、egress 镜像都归跑沙盒服务器的那台机器管，这儿看不到",
    fix: "那台机器上要有：docker、uvx opensandbox-server、docker pull opensandbox/egress:v1.1.6。",
  };
}

function sandboxAuthCheck(serverOk: boolean, key: string): Check | null {
  if (!serverOk || key) return null;
  return {
    name: "沙盒服务器鉴权",
    ok: false,
    detail: "服务器没开鉴权，本机任何进程都能进容器",
    fix:
      `在服务器的 TOML 里写 [server] api_key = "…"，重启，然后设置 → 沙盒服务器 → 「从服务器读」。` +
      `容器里有仓库、信箱令牌和 CLI 登录。`,
  };
}

function egressDetail(good: string[], stale: string[]): string {
  if (good.length === 0 && stale.length === 0) return "no opensandbox/egress image pulled";
  if (good.length === 0) return `only ${stale.join(", ")}, which is too old`;
  if (stale.length > 0) return `${good.join(", ")} (also has ${stale.join(", ")} — check [egress] image)`;
  return good.join(", ");
}

function egressCheck(contained: boolean, probe: Probe): Check | null {
  if (contained) return null;
  const egress = probe("docker") ? egressImages() : [];
  const good = egress.filter((tag) => newEnough(tag));
  const stale = egress.filter((tag) => !newEnough(tag));
  return {
    name: "egress sidecar",
    ok: good.length > 0,
    detail: egressDetail(good, stale),
    fix: "docker pull opensandbox/egress:v1.1.6，然后把 [egress] image 指过去。v1.1.4 一绑凭据就 403 掉所有 scoped 包。",
  };
}

function agentImageCheck(image: string, docker: boolean): Check | null {
  if (hasRegistry(image) || (docker && localImages(image))) return null;
  return {
    name: "agent image",
    ok: false,
    detail: `${image} 不在本机`,
    fix: `docker build -f docker/agent.Dockerfile -t ${image} . —— 没有 registry 前缀的镜像只能本地构建。`,
  };
}

function skillsMountCheck(input: PreflightInput, contained: boolean): { check: Check; staged: string } {
  const staged = resolve(input.skillsDir ?? "/var/tmp/orch-cache/skills");
  const skills = existsSync(staged) ? readdirSync(staged).length : 0;
  return {
    staged,
    check: {
      name: "skills mount",
      ok: skills > 0,
      detail: skills ? `${skills} staged at ${staged}` : "没有勾选的技能",
      fix: contained
        ? `${staged} 是这个容器里的路径，而挂载是沙盒服务器的 docker 做的 —— 它按自己看到的路径挂。` +
          `两边要用同一个绝对路径（-v <宿主路径>:${staged}），并且写进沙盒服务器的 allowed_host_paths。` +
          `不一致不会报错，只会挂个空目录。`
        : `沙盒服务器的 allowed_host_paths 要包含 ${staged}，否则每个组开容器都会失败。技能在设置里勾。`,
    },
  };
}

function allowedPathsCheck(input: PreflightInput, staged: string): Check {
  const allowed = allowedHostPaths();
  const wanted = [staged, ...Object.values(input.cacheDirs ?? {})].map((path) => hostPathForDaemon(resolve(path)));
  const missing = allowed ? wanted.filter((path) => !coveredBy(allowed.paths, path)) : [];
  const detail = !allowed
    ? "找不到 opensandbox-server 的配置文件，没法核对"
    : missing.length
      ? `${allowed.config} 不含 ${missing.join(", ")}`
      : `${allowed.config} 覆盖了要挂的 ${wanted.length} 个路径`;
  const fix =
    allowed && missing.length
      ? `把这一行写进 ${allowed.config} 的 [sandbox] 段，然后重启 opensandbox-server：\n` +
        `      allowed_host_paths = [${[...allowed.paths, ...missing].map((path) => `"${path}"`).join(", ")}]`
      : undefined;
  return { name: "allowed_host_paths", ok: !allowed || missing.length === 0, detail, ...(fix ? { fix } : {}) };
}

function credentialFix(runtime: string): string {
  if (runtime === "claude")
    return "设置页 → Claude → 登录。在工具容器里跑官方的 claude setup-token，本机不用装；页面给的码贴回输入框就存下了。一年有效。";
  if (runtime === "github") return "设置页里连一次 GitHub。分支是靠它推上去的 —— 没有它，每个切片都会在最后一步被拒。";
  return "设置页 → codex → 登录，走官方的设备码流程，本机不用装 codex。也可以直接贴一个 API key。";
}

function credentialRuntimes(db: DB): string[] {
  const runtimes = new Set(
    db
      .query<{ runtime: string }, []>("SELECT DISTINCT runtime FROM agent WHERE runtime IS NOT NULL")
      .all()
      .map(({ runtime }) => runtime),
  );
  runtimes.add("claude");
  runtimes.add("codex");
  runtimes.add("github");
  return [...runtimes].sort();
}

async function credentialCheck(input: PreflightInput, runtime: string): Promise<Check> {
  const auth = loadAuth(input.db, runtime);
  const live = auth ? await (input.verify ?? accepted)(runtime, auth) : { ok: false, detail: "没配" };
  return {
    name: `credential:${runtime}`,
    ok: live.ok,
    detail: auth ? `${auth.mode} · ${live.detail}` : live.detail,
    fix: credentialFix(runtime),
  };
}

function codexRefresherCheck(db: DB): Check | null {
  const auth = loadAuth(db, "codex");
  if (auth?.mode !== "chatgpt") return null;
  const parsed = parseAuth(auth.secret);
  const stale = !parsed || isStale(parsed);
  return {
    name: "codex-refresher",
    ok: !stale,
    detail: stale
      ? "这个 ChatGPT 登录已经旧到该续期了 —— 下一个容器起来时会自动续，续不上就要重新贴 auth.json"
      : "登录还新，续期在工具容器里跑，本机不需要装 codex",
    fix: "续期是在工具容器里跑真 codex 做的。如果一直续不上，去设置页重新贴一次 ~/.codex/auth.json，或者换成 API key —— API key 不需要续期。",
  };
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
  const key = sandboxKeyFor(input.db, input.sandbox.server, input.sandbox.apiKey);
  const server = await reachable(`http://${input.sandbox.server}`, key);
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
  out.push(...(await Promise.all(credentialRuntimes(input.db).map((runtime) => credentialCheck(input, runtime)))));

  // A ChatGPT-account login is a pair of tokens codex itself rotates, renewed by
  // running the real `codex` rather than posting the refresh token ourselves
  // (chatgpt.ts says why). The failure is silent and delayed: `renew` returns
  // null, the stored token is kept, and hours later every codex turn 401s looking
  // like an expired account. The other modes need nothing here.
  const codexRefresher = codexRefresherCheck(input.db);
  if (codexRefresher) out.push(codexRefresher);

  return out;
}

/** One line per failure, for the console. Empty when everything passed. */
export function report(checks: Check[]): string {
  const bad = checks.filter((c) => !c.ok);
  if (!bad.length) return "";
  return bad.map((c) => `  ✗ ${c.name}: ${c.detail}${c.fix ? `\n      → ${c.fix}` : ""}`).join("\n");
}
