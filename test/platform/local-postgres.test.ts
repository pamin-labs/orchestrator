import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPostgres, passwordAt } from "../../src/platform/persistence/local-postgres.ts";

/**
 * The database a deployment gets when it named none.
 *
 * Nothing here starts a container: `localPostgres` takes the runner, so what is
 * tested is the decision — which password, which argv, which environment, which
 * address, and what the error says — rather than whether Docker is on the
 * runner. Docker's own behaviour is measured in ADR 051 instead.
 */

const dir = () => mkdtempSync(join(tmpdir(), "orch-local-pg-"));

/**
 * The two variables this reads, stated rather than inherited.
 *
 * A developer's own `.env` sets `ORCH_POSTGRES_PASSWORD` beside the URL, and Bun
 * loads it into every process including this one — so without this, half these
 * assertions passed or failed according to whether the machine running them had
 * ever started a database. Each test that cares sets what it needs.
 */
beforeEach(() => {
  delete process.env["ORCH_POSTGRES_PASSWORD"];
  delete process.env["ORCH_POSTGRES_PORT"];
});

/** Records what it was asked; answers `up` with success and `port` with an address. */
const ok = (address = "127.0.0.1:32768") => {
  const seen: { cmd: string[]; env: Record<string, string> }[] = [];
  const compose = async (cmd: string[], env: Record<string, string>) => {
    seen.push({ cmd, env });
    const stdout = cmd.includes("port") ? `${address}\n` : "";
    return { exitCode: 0, stdout, stderr: "" };
  };
  return { seen, compose };
};

test("the password is generated once and reused, because initdb only reads it on an empty volume", () => {
  const dataDir = dir();
  const path = join(dataDir, "postgres.password");
  const first = passwordAt(path);
  expect(first).toHaveLength(48);
  expect(passwordAt(path)).toBe(first);
  expect(readFileSync(path, "utf8")).toBe(first);
});

test("the password file is readable by nobody else", () => {
  const path = join(dir(), "postgres.password");
  passwordAt(path);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("the url is built from the address docker reports, not from the port we asked for", async () => {
  const dataDir = dir();
  const { compose } = ok("127.0.0.1:49177");
  const url = await localPostgres(dataDir, compose);
  const password = readFileSync(join(dataDir, "postgres.password"), "utf8");
  expect(url).toBe(`postgres://orchestrator:${password}@127.0.0.1:49177/orchestrator`);
  expect(await localPostgres(dataDir, compose)).toBe(url);
});

test("nobody pinning a port means an empty one, which is what makes docker choose", async () => {
  const { seen, compose } = ok();
  await localPostgres(dir(), compose);
  expect(seen.map((c) => c.env["ORCH_POSTGRES_PORT"])).toEqual(["", ""]);
});

test("compose is asked to wait, then asked where it published", async () => {
  const dataDir = dir();
  const { seen, compose } = ok();
  await localPostgres(dataDir, compose);
  const [up, port] = seen;
  expect(up?.cmd.slice(0, 3)).toEqual(["docker", "compose", "-f"]);
  expect(up?.cmd[3]).toEndWith("/docker/postgres-compose.yml");
  expect(up?.cmd.slice(4)).toEqual(["up", "-d", "--wait"]);
  expect(port?.cmd.slice(4)).toEqual(["port", "postgres", "5432"]);
  // `ORCH_DATA_DIR` is the volume's parent in the compose file, so dropping it
  // puts the database in whatever `../data` resolves to instead — which looked
  // like it worked, once, in `docker/`.
  expect(up?.env["ORCH_DATA_DIR"]).toBe(dataDir);
  expect(up?.env["ORCH_POSTGRES_PASSWORD"]).toBe(readFileSync(join(dataDir, "postgres.password"), "utf8"));
});

test("ORCH_POSTGRES_PORT is passed through, and the reported address still decides", async () => {
  const { seen, compose } = ok("127.0.0.1:55432");
  process.env["ORCH_POSTGRES_PORT"] = "55432";
  try {
    expect(await localPostgres(dir(), compose)).toContain("@127.0.0.1:55432/orchestrator");
    expect(seen[0]?.env["ORCH_POSTGRES_PORT"]).toBe("55432");
  } finally {
    delete process.env["ORCH_POSTGRES_PORT"];
  }
});

test("a compose failure names both ways out, since neither is guessable from docker's own error", async () => {
  const failing = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "Bind for 127.0.0.1:5432 failed: port is already allocated",
  });
  const e = await localPostgres(dir(), failing).catch((err: unknown) => err);
  expect(String(e)).toContain("port is already allocated");
  expect(String(e)).toContain("ORCH_DATABASE_URL");
  expect(String(e)).toContain("ORCH_POSTGRES_PORT");
});

test("a container that published nothing is an error, not a url with no port in it", async () => {
  const silent = async () => ({ exitCode: 0, stdout: "\n", stderr: "" });
  const e = await localPostgres(dir(), silent).catch((err: unknown) => err);
  expect(String(e)).toContain("published no host port");
  expect(String(e)).toContain("ORCH_DATABASE_URL");
});

test("no docker at all is the same error, not an unhandled ENOENT", async () => {
  const absent = async () => {
    throw new Error("spawn docker ENOENT");
  };
  const e = await localPostgres(dir(), absent).catch((err: unknown) => err);
  expect(String(e)).toContain("ENOENT");
  expect(String(e)).toContain("ORCH_DATABASE_URL");
});

/**
 * The password the volume was actually built with.
 *
 * `POSTGRES_PASSWORD` is read by initdb on an empty volume and never again, so a
 * value generated here authenticates against nothing the moment `data/postgres`
 * already holds a cluster — and on any machine that ever ran `bun run db:up`, it
 * does.
 */
/**
 * Measured on this repository's own checkout: `data/postgres/18/docker` was a
 * 106 MB cluster with no `postgres.password` beside it, because the volume came
 * from the `ORCH_POSTGRES_PASSWORD` in `.env`. So ADR 051's fallback, reached by
 * unsetting `ORCH_DATABASE_URL`, would have started that container and then
 * failed to log into it.
 */
test("the environment's password wins, because it is the one the volume was built with", async () => {
  const dataDir = dir();
  const { seen, compose } = ok();
  process.env["ORCH_POSTGRES_PASSWORD"] = "from-the-env";
  try {
    expect(await localPostgres(dataDir, compose)).toContain("postgres://orchestrator:from-the-env@");
    expect(seen[0]?.env["ORCH_POSTGRES_PASSWORD"]).toBe("from-the-env");
    // And it did not write a file that a later run with no variable would then
    // prefer over the value that actually opens the cluster.
    expect(existsSync(join(dataDir, "postgres.password"))).toBe(false);
  } finally {
    delete process.env["ORCH_POSTGRES_PASSWORD"];
  }
});
