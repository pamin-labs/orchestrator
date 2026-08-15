import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DB } from "../db.ts";
import { loadAuth, SANDBOX_KEY, type RuntimeAuth } from "./auth.ts";
import { parseAuth } from "./chatgpt.ts";

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
      headers: apiKey ? { "OPEN-SANDBOX-API-KEY": apiKey } : {},
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

export interface PreflightInput {
  db: DB;
  sandbox: { server: string; apiKey: string; image: string };
  /** Where the staged skills live; the server must allow this path. */
  skillsDir?: string;
  /** Injected in tests. */
  probe?: (bin: string) => boolean;
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
  const probe =
    input.probe ??
    ((bin: string) => {
      try {
        return Bun.spawnSync([bin, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
      } catch {
        return false;
      }
    });

  const docker = probe("docker");
  out.push({
    name: "docker",
    ok: docker,
    detail: docker ? "running" : "not reachable",
    fix: "装 Docker（或 Colima / Podman，任何提供 docker socket 的都行）并启动。",
  });

  // Only ever consulted when the server is down, but reported always: the fix
  // for a missing server is `uvx opensandbox-server`, and a machine without uv
  // cannot run that either. Two failures that look identical from the panel.
  const uvx = probe("uvx");
  out.push({
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
    fix: `uvx opensandbox-server --config ~/.sandbox.toml，监听 ${input.sandbox.server}，[egress] mode 要是 "dns+nft"`,
  });

  // The version the example config ships (v1.1.4) 403s every scoped package
  // fetch while a credential is bound, and the symptom is "this project cannot
  // install its dependencies" — which nobody traces back to a sidecar version.
  // Checked by image tag rather than by probing, because probing it means
  // creating a sandbox on every boot (docs/decisions/005).
  // Which tag the sidecar actually runs is in the sandbox server's own TOML,
  // which is not ours to read — so this reports what is available rather than
  // what is configured. Having a good one is the part we can check; pointing at
  // it is the part the fix line has to say out loud.
  const egress = probe("docker") ? egressImages() : [];
  const good = egress.filter((t) => newEnough(t));
  const stale = egress.filter((t) => !newEnough(t));
  out.push({
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

  // The image every group's container is made from. It is built here, not
  // pulled — there is no registry behind `orch/agent:1` — so a machine that has
  // never built it fails every sandbox with a pull error that reads like a
  // network problem. Checked by tag rather than by creating a sandbox.
  const image = input.sandbox.image;
  const built = docker ? localImages(image) : false;
  out.push({
    name: "agent image",
    ok: built,
    detail: built ? image : `${image} 不在本机`,
    fix: `docker build -f docker/agent.Dockerfile -t ${image} . —— 这个镜像是本地构建的，没有 registry 可拉。`,
  });

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
    fix: `沙盒服务器的 allowed_host_paths 要包含 ${staged}，否则每个组开容器都会失败。技能在设置里勾。`,
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
  for (const runtime of [...runtimes].sort()) {
    const auth = loadAuth(input.db, runtime);
    const live = auth ? await (input.verify ?? accepted)(runtime, auth) : { ok: false, detail: "没配" };
    out.push({
      // `credential:` so a caller that shows both this and its own credential
      // list can drop these rather than printing the same fact twice.
      name: `credential:${runtime}`,
      ok: live.ok,
      detail: auth ? `${auth.mode} · ${live.detail}` : live.detail,
      fix:
        runtime === "claude"
          ? "claude setup-token，把吐出来的令牌存进设置里的账号。一年有效。"
          : "codex login，或者贴一个 API key。",
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
    const hasCodex = probe("codex");
    out.push({
      name: "codex-refresher",
      ok: hasCodex,
      detail: hasCodex ? "在" : "ChatGPT 登录要靠本机的 codex 续期，而这台机器上没有",
      fix: "装上 codex CLI，或者把 codex 换成 API key —— API key 不需要续期",
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
