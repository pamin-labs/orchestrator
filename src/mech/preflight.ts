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
    fix: "Install Docker (or Colima/Podman with a docker socket) and start it.",
  });

  const server = await reachable(`http://${input.sandbox.server}`, input.sandbox.apiKey);
  out.push({
    name: "opensandbox-server",
    ok: server.ok,
    detail: server.detail,
    fix: `uvx opensandbox-server --config ~/.sandbox.toml (listening on ${input.sandbox.server}), with [egress] mode = "dns+nft"`,
  });

  // The version the example config ships (v1.1.4) 403s every scoped package
  // fetch while a credential is bound, and the symptom is "this project cannot
  // install its dependencies" — which nobody traces back to a sidecar version.
  // Checked by image tag rather than by probing, because probing it means
  // creating a sandbox on every boot (docs/decisions/005).
  const egress = probe("docker") ? egressImages() : [];
  const stale = egress.filter((tag) => !newEnough(tag));
  out.push({
    name: "egress sidecar",
    ok: egress.length > 0 && stale.length === 0,
    detail: egress.length === 0 ? "no opensandbox/egress image pulled" : stale.length ? `${stale.join(", ")} is too old` : egress.join(", "),
    fix: "docker pull opensandbox/egress:v1.1.6, and point [egress] image at it. v1.1.4 breaks scoped npm/bun installs whenever a credential is bound.",
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
      name: `${runtime} credentials`,
      ok: Boolean(row),
      detail: row ? row.mode : "not configured",
      fix:
        runtime === "claude"
          ? "Run `claude setup-token` and paste the token into Settings. It lasts a year."
          : "Paste an API key (or the contents of ~/.codex/auth.json) into Settings.",
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
