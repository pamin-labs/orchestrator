import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import consola from "consola";
import { ROOT } from "../config/load.ts";
import { errText } from "../process/text.ts";

/**
 * The database nobody asked for, for the deployment that named none.
 *
 * `ORCH_DATABASE_URL` stays bring-your-own; this is what happens when it is
 * unset. The README's quickstart is `curl | tar` and `./orch-server` on a
 * machine that already has Docker, and before this it died on `open()` naming
 * the variable, having never reached `Bun.serve`. So the fallback costs no new
 * dependency and no new container definition — `docker/postgres-compose.yml` is
 * the one `bun run db:up` starts, now shipped inside the archive (ADR 051).
 */

/** The compose file, beside the binary. `ROOT/docker` is why `release.yml` copies it. */
const COMPOSE = join(ROOT, "docker/postgres-compose.yml");

/** Over the healthcheck's own ceiling — 12 retries at 5s — so `--wait` decides, not this. */
const UP_TIMEOUT_MS = 120_000;

const PORT_VAR = "ORCH_POSTGRES_PORT";

/** The container's own port, which is fixed. Only the host side of it moves. */
const CONTAINER_PORT = "5432";

/** How docker is run. Injected by the test, which has none. */
export type Compose = (
  cmd: string[],
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const dockerCompose: Compose = async (cmd, env) => {
  const p = Bun.spawn({ cmd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: UP_TIMEOUT_MS });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/**
 * The password, generated once and kept.
 *
 * `POSTGRES_PASSWORD` is read by the image's initdb and only by that, on an
 * empty volume. One generated per boot therefore authenticates against nothing
 * from the second start onwards, which reads as a corrupt install.
 *
 * `wx` rather than `existsSync` first: two boots racing both see no file, and
 * the exclusive create is what makes one of them read the winner's value.
 */
export function passwordAt(path: string): string {
  const fresh = randomBytes(24).toString("hex");
  try {
    writeFileSync(path, fresh, { mode: 0o600, flag: "wx" });
    return fresh;
  } catch {
    return readFileSync(path, "utf8").trim();
  }
}

/**
 * Every call shares the file, the project and the environment.
 *
 * No `-p`: the project name defaults to the compose file's parent directory,
 * `docker` in both the checkout and the archive, so this and `bun run db:up`
 * are one project rather than two fighting over one `container_name`.
 */
const ask = (argv: string[], dataDir: string, password: string, port: string) => ({
  cmd: ["docker", "compose", "-f", COMPOSE, ...argv],
  env: { ORCH_POSTGRES_PASSWORD: password, ORCH_DATA_DIR: dataDir, [PORT_VAR]: port },
});

/** What compose said last, which is where the reason is. */
const lastLines = (out: string, n = 3): string =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join("\n");

/**
 * Bring up the local PostgreSQL and say how to reach it.
 *
 * No span, deliberately: `configureTracing` reads its configuration out of the
 * database this call is opening, so a span here has nothing behind it to export.
 * ADR 051 records that rather than leaving it to be found as an omission.
 */
export async function localPostgres(dataDir: string, compose: Compose = dockerCompose): Promise<string> {
  // Empty, not 5432. The compose file defaults the host side only when this is
  // *unset*, so an empty value publishes `127.0.0.1::5432` and Docker draws a
  // free port itself. Nothing to scan for: a port this process probed as free is
  // not a port it holds, and the sandbox server draws ephemeral ports of its own
  // — it has already lost that race once, to itself.
  const port = process.env[PORT_VAR] ?? "";
  const password = passwordAt(join(dataDir, "postgres.password"));
  consola.info("no ORCH_DATABASE_URL — starting the local PostgreSQL container");
  const failed = (detail: string) =>
    new Error(
      `could not start the local PostgreSQL container: ${detail}\n` +
        `Set ORCH_DATABASE_URL to a PostgreSQL of your own, or ${PORT_VAR} to pin the port it publishes.`,
    );
  const run = async (argv: string[]) => {
    const { cmd, env } = ask(argv, dataDir, password, port);
    try {
      return await compose(cmd, env);
    } catch (e) {
      // `docker` absent is an ENOENT out of `spawn`, and it is the likeliest of
      // these on a machine that followed the README out of order.
      throw failed(errText(e, 400));
    }
  };

  // The last lines, not the last 400 bytes: compose narrates every step it took,
  // the one that failed is at the end, and a byte count cuts a word in half.
  const up = await run(["up", "-d", "--wait"]);
  if (up.exitCode !== 0) throw failed(lastLines(up.stderr) || `docker compose exited ${up.exitCode}`);

  // Asked, never assumed. Docker's own choice is knowable no other way, it moves
  // across a stop and start — measured, 32768 then 32769 — and asking is what
  // makes this right when the port *was* pinned too: a container believed to be
  // on an address it never took is how a connection reaches somebody else's
  // PostgreSQL and migrates it.
  const at = await run(["port", "postgres", CONTAINER_PORT]);
  const address = lastLines(at.stdout, 1);
  if (at.exitCode !== 0 || !/:\d+$/.test(address)) {
    throw failed(lastLines(at.stderr) || `it published no host port for ${CONTAINER_PORT}`);
  }
  consola.info(`local PostgreSQL on ${address}`);
  return `postgres://orchestrator:${encodeURIComponent(password)}@${address}/orchestrator`;
}
