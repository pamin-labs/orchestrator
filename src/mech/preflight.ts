import type { DB } from "../db.ts";

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
 * success. So this refuses to start rather than degrading, and it never falls
 * back to running turns on the host — there is no host path left to fall back to.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** How the boss fixes it. Shown verbatim. */
  fix?: string;
}

async function reachable(url: string, apiKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${url}/openapi.json`, {
      headers: apiKey ? { "x-api-key": apiKey } : {},
      signal: AbortSignal.timeout(3000),
    });
    return { ok: res.ok, detail: res.ok ? "reachable" : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 120) };
  }
}

export interface PreflightInput {
  db: DB;
  sandbox: { server: string; apiKey: string; image: string };
  /** Injected in tests. */
  probe?: (bin: string) => boolean;
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

  const server = await reachable(`http://${input.sandbox.server}`, input.sandbox.apiKey);
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

  // Credentials are per runtime and live in the DB, never in an event or a
  // prompt. The value is not read here — only whether one exists.
  const runtimes = new Set(
    input.db
      .query<{ runtime: string }, []>("SELECT DISTINCT runtime FROM agent WHERE runtime IS NOT NULL")
      .all()
      .map((r) => r.runtime),
  );
  runtimes.add("claude");
  runtimes.add("codex");
  for (const runtime of [...runtimes].sort()) {
    const row = input.db
      .query<{ mode: string }, [string]>("SELECT mode FROM runtime_auth WHERE runtime = ?")
      .get(runtime);
    out.push({
      // `credential:` so a caller that shows both this and its own credential
      // list can drop these rather than printing the same fact twice.
      name: `credential:${runtime}`,
      ok: Boolean(row),
      detail: row ? row.mode : "没配",
      fix:
        runtime === "claude"
          ? "claude setup-token，把吐出来的 token 存进凭据。一年有效。"
          : "codex login，或者贴一个 API key。",
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
