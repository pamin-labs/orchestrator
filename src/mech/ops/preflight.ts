import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DB } from "../../db.ts";
import { loadAuth, SANDBOX_KEY, type RuntimeAuth } from "../sandbox/auth.ts";
import { allowedHostPaths, coveredBy, hasRegistry, hostPathForDaemon, SANDBOX_API_KEY_HEADER } from "../sandbox/sandbox.ts";
import { isStale, parseAuth } from "../sandbox/chatgpt.ts";

/**
 * What has to be true before any agent can run, checked once.
 *
 * Every one of these fails silently if you let it. A missing docker means every
 * group's first turn errors one at a time with the same message; an egress
 * server in `dns` mode means credential injection quietly does not happen and
 * the symptom is a 401 from Anthropic, which reads as a bad token; a runtime
 * with no credential configured looks like an agent that will not answer.
 *
 * Decision 001's lesson, one layer up: every quiet failure looked exactly like
 * success. Nothing here ever falls back to running a turn on the host — there is
 * no host path left to fall back to.
 *
 * It does **not** refuse to start, and said it did for a while. Refusing would
 * take the panel down with it, and the panel is where three of these are fixed —
 * the sandbox key is pasted there, so a server that will not boot without one
 * cannot be given one. What enforces instead is the hold in `sandbox.ts`: with
 * no container to open, turns are not dispatched at all, so the fleet waits
 * rather than each group failing separately. This reports; that gates.
 *
 * `missingBinaries` in server.ts is the only fatal check, and it is down to
 * `git`: the host really does run that one itself.
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
 * It used to GET `/openapi.json` with an `x-api-key` header, and both halves of
 * that were wrong: the doc endpoint is unauthenticated, so a server that
 * rejected every real call reported `reachable`, and the header it authenticates
 * by is `OPEN-SANDBOX-API-KEY`. A panel showing a green tick while every turn,
 * every gate and every diff came back 401 is worse than no check at all.
 *
 * `/v1/sandboxes` is the cheapest authenticated call — a list, no side effect.
 */
async function reachable(url: string, apiKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
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
 * Does the provider accept this credential, right now.
 *
 * Existence was the old check, and a token that expired last week exists. The
 * failure it missed is the expensive one: everything looks configured, and every
 * turn dies at the API with a message the boss sees as an agent problem.
 *
 * `GET /v1/models` on both sides — a list, free, no side effect, and it answers
 * 401 for exactly the thing being asked. A ChatGPT login is checked without a
 * request at all: what expires is inside the JWT it stores.
 *
 * Cached, because the settings page asks on every open and a preflight that
 * costs two round trips per glance is one nobody leaves on.
 */
const seen = new Map<string, { at: number; ok: boolean; detail: string }>();
const CACHE_MS = 5 * 60_000;

async function accepted(runtime: string, auth: RuntimeAuth): Promise<{ ok: boolean; detail: string }> {
  // Hashed, not a tail: a pasted auth.json ends in `"}}` no matter whose login
  // it is, so two different credentials shared a cache entry and the second one
  // was reported with the first one's verdict.
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
 * Every other place a real model credential reached the wire moved into the
 * utility container, where the sidecar substitutes it — the usage poll was the
 * last one. This is the deliberate exception, and the reason is the shape of the
 * check rather than the credential: it runs at boot, before any container is
 * guaranteed to exist, and moving it would make *"can we open a container"* a
 * prerequisite for reporting that we cannot. **A check that needs the thing it
 * checks is not a check.**
 *
 * So: not an oversight, and not something to tidy up on sight of a host `fetch`
 * next to a commit that removed exactly that.
 */
async function ask(runtime: string, auth: RuntimeAuth): Promise<{ ok: boolean; detail: string }> {
  // The refresh token is what matters and it is not ours to test; the access
  // token carries its own expiry, and codex rotates it from the host.
  if (auth.mode === "chatgpt") {
    const exp = jwtExpiry(parseAuth(auth.secret)?.tokens?.access_token);
    if (!exp) return { ok: true, detail: "存着" };
    const days = Math.round((exp - Date.now()) / 86_400_000);
    return exp > Date.now()
      ? { ok: true, detail: days >= 1 ? `还有 ${days} 天` : "快过期了" }
      : { ok: false, detail: "过期了，重新登录一次" };
  }
  // GitHub is not a model provider and has no `/v1/models`. It is checked here
  // anyway, and it is the one credential whose absence is silent everywhere
  // else: the utility container is what pushes every branch, and it pushes with
  // this. With no token it builds, mirrors, and is refused at the last step of
  // every slice — which reads as a git problem rather than as a missing login.
  if (runtime === "github") {
    try {
      const r = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${auth.secret}`, "user-agent": "orchestrator" },
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) return { ok: true, detail: "能用" };
      // 404 included: GitHub answers it for a token that cannot see something,
      // deliberately, so it is not evidence of anything being deleted.
      if (r.status === 401 || r.status === 403 || r.status === 404) return { ok: false, detail: "GitHub 不认这个 token 了" };
      return { ok: true, detail: `没验成（HTTP ${r.status}）` };
    } catch {
      return { ok: true, detail: "连不上，没验" };
    }
  }
  const base = auth.baseUrl?.replace(/\/+$/, "") ?? (runtime === "claude" ? "https://api.anthropic.com" : "https://api.openai.com");
  const headers: Record<string, string> =
    runtime === "claude"
      ? auth.mode === "api_key"
        ? { "x-api-key": auth.secret, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${auth.secret}`, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${auth.secret}` };
  try {
    const r = await fetch(`${base}/v1/models?limit=1`, { headers, signal: AbortSignal.timeout(6000) });
    if (r.ok) return { ok: true, detail: "能用" };
    if (r.status === 401 || r.status === 403) return { ok: false, detail: "对面不认这个凭据" };
    // A gateway that answers something else is not a credential problem, and
    // saying it is would send the boss to re-paste a token that was fine.
    return { ok: true, detail: `没验成（HTTP ${r.status}）` };
  } catch {
    return { ok: true, detail: "连不上，没验" };
  }
}

/** `exp` out of a JWT, in ms. Null when it is not one. */
function jwtExpiry(token?: string): number | null {
  const body = token?.split(".")[1];
  if (!body) return null;
  try {
    const json = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Is the orchestrator itself inside a container?
 *
 * It changes what this pane is even *about*. Three of these checks — docker, uv,
 * the sidecar image — are questions about the machine that runs the sandbox
 * server, and when the orchestrator ships as an image that machine is somebody
 * else's: there is no docker socket in here, `uvx` is not installed and never
 * will be, and pulling the sidecar here would put it in the wrong daemon. Asked
 * anyway, they answer "broken" about a deployment that is working, and every fix
 * they print (`brew install uv`) is a command for a host this process cannot see.
 *
 * `ORCH_IN_CONTAINER` is set by our own Dockerfile. `/.dockerenv` is the fallback
 * for anyone who builds their own image or runs the binary in a container of
 * their own.
 */
export const inContainer = (): boolean =>
  process.env.ORCH_IN_CONTAINER === "1" || existsSync("/.dockerenv");

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
    return p.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
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

export async function preflight(input: PreflightInput): Promise<Check[]> {
  const out: Check[] = [];
  // Injectable so a test can assert both deployments without a container.
  const contained = input.contained ?? inContainer();
  const probe =
    input.probe ??
    ((bin: string, argv: string[] = ["--version"]) => {
      try {
        return Bun.spawnSync([bin, ...argv], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
      } catch {
        return false;
      }
    });

  // `docker info`, not `docker --version`. Measured: with the daemon down —
  // Docker Desktop installed and never launched, the most common first-run state
  // there is — `docker --version` still exits 0, so this check reported
  // "running" while every `ensureSandbox` failed. The blocker the boss got said
  // "多半是 docker 没起，自检那栏会说是哪个", and the self-check then said it was
  // up: pointed at the right page and told the wrong thing on it.
  //
  // Both are asked, because the answers send them to different places: not
  // installed at all is a download, installed but not started is one click.
  const docker = probe("docker", ["info"]);
  const installed = docker || probe("docker");
  if (!contained) out.push({
    name: "docker",
    ok: docker,
    detail: docker ? "running" : installed ? "装了，但没启动（daemon 不理人）" : "not reachable",
    fix: installed
      ? "Docker 装了但没跑起来 —— 启动 Docker Desktop（或 colima start），等它变绿再回来。"
      : "装 Docker（或 Colima / Podman，任何提供 docker socket 的都行）并启动。",
  });

  // Only ever consulted when the server is down, but reported always: the fix
  // for a missing server is `uvx opensandbox-server`, and a machine without uv
  // cannot run that either. Two failures that look identical from the panel.
  const uvx = probe("uvx");
  if (!contained) out.push({
    name: "uv / python",
    ok: uvx,
    detail: uvx ? "uvx available" : "no uvx on PATH",
    fix: "brew install uv —— opensandbox-server 是个 Python 包，没有它就没东西可启动。",
  });

  // The same order `connection()` resolves it in: panel, then environment, then
  // the yaml. Checking a different key than the one the turns use is how a green
  // tick sat next to a fleet that could not open a single container.
  const key = loadAuth(input.db, SANDBOX_KEY)?.secret || input.sandbox.apiKey;
  const server = await reachable(`http://${input.sandbox.server}`, key);
  out.push({
    name: "opensandbox-server",
    ok: server.ok,
    detail: server.detail,
    fix: contained
      ? `这个 orchestrator 跑在容器里，起不了沙盒服务器，也不该起 —— 它要的是宿主的 docker。` +
        `在宿主上跑 uvx opensandbox-server，然后用 ORCH_SANDBOX_SERVER 指过去` +
        `（Docker Desktop 上是 host.docker.internal:8080，Linux 上用宿主 IP 或 --network host）。`
      : `uvx opensandbox-server --config ~/.sandbox.toml，监听 ${input.sandbox.server}，[egress] mode 要是 "dns+nft"`,
  });

  // One row instead of the three above, and only in a container: docker, uv and
  // the sidecar image are facts about the machine running the sandbox server,
  // which is not this one. Said once rather than dropped silently — somebody
  // reading this pane after a `docker run` should learn where those questions
  // went, not wonder whether they are still being asked.
  if (contained) {
    out.push({
      name: "宿主环境",
      ok: true,
      detail: "docker、uv、egress 镜像都归跑沙盒服务器的那台机器管，这儿看不到",
      fix: "那台机器上要有：docker、uvx opensandbox-server、docker pull opensandbox/egress:v1.1.6。",
    });
  }

  // Answering without a key is not a configuration detail: this server creates
  // containers and runs commands inside them, and those containers hold the
  // checkout, the mailbox token and the CLI logins. Anything else on this
  // machine — any process, any page that can reach loopback — can exec into one.
  //
  // Only when it is reachable AND we sent no key. A server that refuses us is
  // already reported above, and one on a Tailscale address with no key is the
  // same exposure to everyone on that network.
  if (server.ok && !key) {
    out.push({
      name: "沙盒服务器鉴权",
      ok: false,
      detail: "服务器没开鉴权，本机任何进程都能进容器",
      fix:
        `在服务器的 TOML 里写 [server] api_key = "…"，重启，然后设置 → 沙盒服务器 → 「从服务器读」。` +
        `容器里有仓库、信箱令牌和 CLI 登录。`,
    });
  }

  // The version the example config ships (v1.1.4) 403s every scoped package
  // fetch while a credential is bound, and the symptom is "this project cannot
  // install its dependencies" — which nobody traces back to a sidecar version.
  // Checked by image tag rather than by probing, because probing it means
  // creating a sandbox on every boot (docs/decisions/005).
  // Which tag the sidecar actually runs is in the sandbox server's own TOML,
  // which is not ours to read — so this reports what is available rather than
  // what is configured. Having a good one is the part we can check; pointing at
  // it is the part the fix line has to say out loud.
  const egress = !contained && probe("docker") ? egressImages() : [];
  const good = egress.filter((t) => newEnough(t));
  const stale = egress.filter((t) => !newEnough(t));
  if (!contained) out.push({
    name: "egress sidecar",
    ok: good.length > 0,
    detail:
      egress.length === 0
        ? "no opensandbox/egress image pulled"
        : good.length === 0
          ? `only ${stale.join(", ")}, which is too old`
          : stale.length
            ? `${good.join(", ")} (also has ${stale.join(", ")} — check [egress] image)`
            : good.join(", "),
    fix: "docker pull opensandbox/egress:v1.1.6，然后把 [egress] image 指过去。v1.1.4 一绑凭据就 403 掉所有 scoped 包。",
  });

  // The image every group's container is made from — reported only when it can
  // fail, which is not the usual case any more.
  //
  // A published one is pulled by the sandbox server the first time it builds a
  // container, so there is nothing here for anybody to do and nothing that can
  // go wrong at this level. A row that is always green is a row nobody reads,
  // and this pane is the one place where a tick has to mean something.
  //
  // A tag with no registry in front of it has nowhere to be pulled from. That
  // one fails every sandbox with a pull error reading like a network problem,
  // which is why this check exists at all.
  const image = input.sandbox.image;
  if (!hasRegistry(image) && !(docker && localImages(image))) {
    out.push({
      name: "agent image",
      ok: false,
      detail: `${image} 不在本机`,
      fix: `docker build -f docker/agent.Dockerfile -t ${image} . —— 没有 registry 前缀的镜像只能本地构建。`,
    });
  }

  // The skills mount, reported the same way as the sidecar image: the server's
  // `allowed_host_paths` is in its own TOML, which is not ours to read, so this
  // says which path has to be in it rather than pretending to have checked. A
  // path that is not allowed fails sandbox creation outright — loudly, but for
  // every group at once, which is a bad way to learn it.
  const staged = resolve(input.skillsDir ?? "/var/tmp/orch-cache/skills");
  const skills = existsSync(staged) ? readdirSync(staged).length : 0;
  out.push({
    name: "skills mount",
    ok: skills > 0,
    detail: skills ? `${skills} staged at ${staged}` : "没有勾选的技能",
    fix: contained
      ? `${staged} 是这个容器里的路径，而挂载是沙盒服务器的 docker 做的 —— 它按自己看到的路径挂。` +
        `两边要用同一个绝对路径（-v <宿主路径>:${staged}），并且写进沙盒服务器的 allowed_host_paths。` +
        `不一致不会报错，只会挂个空目录。`
      : `沙盒服务器的 allowed_host_paths 要包含 ${staged}，否则每个组开容器都会失败。技能在设置里勾。`,
  });

  // The line above says which path has to be allowed. This says whether it is.
  //
  // The failure it catches has no other symptom: a host path missing from
  // `allowed_host_paths` either fails creation outright (loud, and the fallback
  // in `sandbox.ts` says so) or — when the runtime cannot reach the path at all —
  // mounts an empty directory over it, which nothing notices. Both end with
  // agents running without the skills the boss ticked.
  //
  // The fix is one line in a file we can already find, so this prints that line
  // rather than describing it.
  const allowed = allowedHostPaths();
  // As the daemon will read them, not as this process writes them: on Windows
  // the sandbox server is under WSL and the path it must allow is `/mnt/c/...`,
  // so comparing the drive-letter form against its config would report a
  // mismatch that no edit could fix.
  const wanted = [staged, ...Object.values(input.cacheDirs ?? {})].map((p) => hostPathForDaemon(resolve(p)));
  const missing = allowed ? wanted.filter((p) => !coveredBy(allowed.paths, p)) : [];
  out.push({
    name: "allowed_host_paths",
    ok: !allowed || missing.length === 0,
    detail: !allowed
      ? "找不到 opensandbox-server 的配置文件，没法核对"
      : missing.length
        ? `${allowed.config} 不含 ${missing.join(", ")}`
        : `${allowed.config} 覆盖了要挂的 ${wanted.length} 个路径`,
    fix: missing.length
      ? `把这一行写进 ${allowed!.config} 的 [sandbox] 段，然后重启 opensandbox-server：\n` +
        `      allowed_host_paths = [${[...allowed!.paths, ...missing].map((p) => `"${p}"`).join(", ")}]`
      : undefined,
  });

  // Credentials are per runtime and live in the DB, never in an event or a
  // prompt. Whether one *exists* was the whole check, and existing is not the
  // question anyone is asking — a token that expired last week exists.
  const runtimes = new Set(
    input.db
      .query<{ runtime: string }, []>("SELECT DISTINCT runtime FROM agent WHERE runtime IS NOT NULL")
      .all()
      .map((r) => r.runtime),
  );
  runtimes.add("claude");
  runtimes.add("codex");
  // Not a runtime, and here for the same reason the other two are: without it
  // nothing reaches the remote and the failure surfaces four steps later.
  runtimes.add("github");
  for (const runtime of [...runtimes].sort()) {
    const auth = loadAuth(input.db, runtime);
    const live = auth ? await (input.verify ?? accepted)(runtime, auth) : { ok: false, detail: "没配" };
    out.push({
      // `credential:` so a caller that shows both this and its own credential
      // list can drop these rather than printing the same fact twice.
      name: `credential:${runtime}`,
      ok: live.ok,
      detail: auth ? `${auth.mode} · ${live.detail}` : live.detail,
      // Where, not what. This used to say `claude setup-token` and `codex
      // login` — instructions to run a CLI on this machine, from before both
      // logins moved into the utility container. Following them logged the
      // *host* in and stored nothing, and the check kept saying 没配 with no
      // hint that the thing just done was the wrong thing.
      fix:
        runtime === "claude"
          ? "设置页 → Claude → 登录。在工具容器里跑官方的 claude setup-token，本机不用装；页面给的码贴回输入框就存下了。一年有效。"
          : runtime === "github"
            ? "设置页里连一次 GitHub。分支是靠它推上去的 —— 没有它，每个切片都会在最后一步被拒。"
            : "设置页 → codex → 登录，走官方的设备码流程，本机不用装 codex。也可以直接贴一个 API key。",
    });
  }

  // A ChatGPT-account login is the one credential that needs a binary on *this*
  // machine, permanently.
  //
  // It is a pair of tokens codex itself rotates, and the renewal is deliberately
  // done by running the real `codex` rather than posting the refresh token
  // ourselves with the CLI's client id (chatgpt.ts says why). So no `codex` on
  // the host means no renewal — and the failure is silent and delayed: the nudge
  // throws, `renew` returns null, the stored token is kept, and hours later every
  // codex turn 401s looking like an expired account. The other three modes need
  // nothing here: a pasted `sk-ant-oat01-` is good for a year and an API key does
  // not expire.
  const codexAuth = loadAuth(input.db, "codex");
  if (codexAuth?.mode === "chatgpt") {
    // No longer "is codex on this machine" — it moved into the utility container
    // (007 step 7), and codex is in the agent image because turns run it. What
    // is left to check is the thing that would now go wrong: the login itself
    // going stale with nothing able to renew it. `isStale` is codex's own eight
    // days halved, and past that the fleet is running on borrowed time.
    const parsed = parseAuth(codexAuth.secret);
    const stale = !parsed || isStale(parsed);
    out.push({
      name: "codex-refresher",
      ok: !stale,
      detail: stale
        ? "这个 ChatGPT 登录已经旧到该续期了 —— 下一个容器起来时会自动续，续不上就要重新贴 auth.json"
        : "登录还新，续期在工具容器里跑，本机不需要装 codex",
      fix: "续期是在工具容器里跑真 codex 做的。如果一直续不上，去设置页重新贴一次 ~/.codex/auth.json，或者换成 API key —— API key 不需要续期。",
    });
  }

  return out;
}

/** One line per failure, for the console. Empty when everything passed. */
export function report(checks: Check[]): string {
  const bad = checks.filter((c) => !c.ok);
  if (!bad.length) return "";
  return bad.map((c) => `  ✗ ${c.name}: ${c.detail}${c.fix ? `\n      → ${c.fix}` : ""}`).join("\n");
}
