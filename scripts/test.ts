/**
 * `bun test --parallel`, with one retry reserved for a runtime crash.
 *
 * Bun 1.3.14 segfaults in a test worker roughly once in ten full runs here. A
 * dead worker takes the run with it, so every file that had not started counts
 * as failed: the two observed crashes reported **172** and **252** failures,
 * which reads as a project-wide breakage and is one upstream bug.
 */

/**
 * It is arm64 pointer authentication, and it cannot reach CI.
 *
 * `panic: Segmentation fault at address 0x6C38377464756519` — ASCII where a
 * pointer belongs, which is what a failed PAC signature looks like. Same family
 * as oven-sh/bun#30281 (React, arm64 PAC IB trap) and #29519 (`test --isolate`),
 * both from the WebKit module-loader rewrite in #29393 and both fixed; 1.3.14 is
 * the newest stable and still does this. Every workflow runs `ubuntu-24.04`,
 * which is x64 and has no PAC — so this is a local-only tax, not a flaky CI.
 */
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { $, fileURLToPath, SQL } from "bun";
import { z } from "zod";
import { cpus } from "node:os";
import { dirname, join } from "node:path";

export const CRASHED = /worker crashed with SIG|Segmentation fault|oh no: Bun has crashed/;

/**
 * One suite run at a time, because a namespace is named per worker.
 *
 * `BUN_TEST_WORKER_ID` restarts at 0 every run, so a second concurrent run takes
 * the first one's schemas and empties its tables mid-test. That is not a slow
 * run, it is a wrong one: duplicate keys, absent foreign parents and
 * `relation "agent" does not exist` across files that share nothing — and a
 * corrupt run looks exactly like a broken branch.
 */
/**
 * A lock file, not an advisory lock in the database: the pool hands each
 * statement whichever connection is free, so a session-scoped lock on one of
 * twenty-four is not held by the run. A lock left by a killed run names its own
 * pid, which is what lets it be cleared and said out loud.
 */
const LOCK = `${import.meta.dir}/../node_modules/.cache/orch-test.lock`;

/** Whether a pid is still around. Signal 0 asks without delivering anything. */
function alive(pid: number): boolean {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid in the lock file, or 0 when there is none to read. */
function holder(): number {
  try {
    return Number(readFileSync(LOCK, "utf8"));
  } catch {
    return 0;
  }
}

/**
 * Exported, because the stress pass is a second suite run and used to take
 * neither this nor the timeout below — it spawns `bun test` itself. Two runs
 * share schema names, which is the incident this lock exists for.
 */
export function claim(): () => void {
  mkdirSync(dirname(LOCK), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    // `wx` is `O_CREAT | O_EXCL`: it creates or it throws, with no window between
    // the two in which a second run could decide the same thing.
    try {
      writeFileSync(LOCK, String(process.pid), { flag: "wx" });
      break;
    } catch {}
    const held = holder();
    if (!alive(held) && attempt === 0) {
      console.error(`[test] clearing a lock left by pid ${held}, which is gone.`);
      try {
        unlinkSync(LOCK);
      } catch {}
      continue;
    }
    console.error(
      `\n[test] another suite run (pid ${held}) is already using this repository's test\n` +
        `[test] namespaces. Two runs share schema names and empty each other's tables,\n` +
        `[test] which reports as failures in files neither run touched. Wait for it, or\n` +
        `[test] run one file: bun run test <path> --max-concurrency=2\n`,
    );
    process.exit(1);
  }
  return () => {
    // Only if it is still ours: a run that outlived its lock must not delete the
    // lock of the run that legitimately took over.
    try {
      if (holder() === process.pid) unlinkSync(LOCK);
    } catch {}
  };
}

/**
 * A hang threshold, not a load threshold.
 *
 * Bun's 5000ms default sat 571ms above this suite's p99.9 — 4,429ms across
 * 1,848 tests, measured from a junit run — so three of five consecutive full
 * runs reported a *different* healthy test as timed out, and CI's runner is
 * about twice as slow again. A real hang does not finish in twenty seconds.
 */
/**
 * `--max-concurrency` under Bun's default of 20, because oversubscription is a
 * net cost here rather than a win: 62.3s at 20, 53.8s at 8, 46.2s at 4, for the
 * same 1,848 tests on ten cores.
 */
/**
 * Derived from the core count rather than pinned at the eight measurement found,
 * because the number that was right here was wrong on CI: a four-core runner ran
 * four workers at eight apiece — thirty-two tests against one Postgres — and the
 * property that replays every JSON payload, 578ms on this machine, spent over
 * thirty seconds waiting its turn. The ratio reproduces the measured optimum on
 * ten cores and asks for three on four.
 */
/**
 * Both sit before the caller's arguments, so `bun run test <path>
 * --max-concurrency=2` still wins — verified, Bun takes the last occurrence.
 */
/**
 * The coverage scripts go through here too, and that is the point: pinning the
 * number in `package.json` is what let the derivation miss CI entirely, since
 * CI runs `test:coverage:ci` and never `test`. One definition, and the crash
 * retry and the run lock come along for free.
 */
export const TIMEOUT = "--timeout=20000";
/**
 * `--no-isolate`, which is the whole reason this line has a comment.
 *
 * `--parallel` implies `--isolate`: a fresh global and a cleared module registry
 * per file, so every file re-evaluates the module graph it imports. Measured on
 * this tree, that is what the suite's memory was — 253 files at 29-55MB apiece,
 * peaking around 7GB of system memory, and flat across worker counts because the
 * total is files x graph rather than processes x anything. Bun's own benchmark
 * says the same thing (https://bun.com/docs/test/parallel).
 */
/**
 * What it costs is that files see each other's leftovers, which is a property
 * the suite now has to hold rather than one the runner buys. Four leaks were
 * paid off to get here: happy-dom's network primitives replacing Bun's, a
 * catalog restored per test rather than only the locale, `startTheme` wiring a
 * second keydown listener, and a test that emptied a catalog with a merging
 * `load`. `bun run test:stress` was already the configuration that finds them.
 */
const LIMITS = [TIMEOUT, "--no-isolate", `--max-concurrency=${Math.max(2, Math.round(cpus().length * 0.8))}`];

async function run(): Promise<{ code: number; crashed: boolean }> {
  const args = ["test", "--parallel", ...LIMITS, ...Bun.argv.slice(2)];
  const child = Bun.spawn([process.execPath, ...args], { stdout: "pipe", stderr: "pipe" });
  // A window, not the whole run: the three markers `CRASHED` looks for are one
  // line each, and this used to hold every byte the suite printed — 223 files of
  // output in memory to answer a question about the last few.
  let saw = "";
  const tee = async (from: ReadableStream<Uint8Array>, to: typeof Bun.stdout) => {
    // One decoder per stream, streaming: a fresh one per chunk both allocates
    // per read and mangles any UTF-8 sequence a pipe split across two of them,
    // which is a `` in the middle of whichever marker `CRASHED` is looking for.
    const decoder = new TextDecoder();
    for await (const chunk of from) {
      saw = (saw + decoder.decode(chunk, { stream: true })).slice(-8192);
      await Bun.write(to, chunk);
    }
  };
  // Both streams, concurrently: bun writes results to one and panics to the other,
  // and reading them in sequence deadlocks on whichever pipe fills first.
  await Promise.all([tee(child.stdout, Bun.stdout), tee(child.stderr, Bun.stderr)]);
  return { code: await child.exited, crashed: CRASHED.test(saw) };
}

// `import.meta.main`, so the test that pins `CRASHED` to a real panic can import
// this file without running the whole suite to get at one regular expression.
/**
 * The suite's Postgres, started only if nobody else has, and stopped only then.
 *
 * From the binaries in `node_modules`, not from Docker. `@embedded-postgres/<os>-<cpu>`
 * is what `bun install` — the one setup step every checkout already runs — puts
 * there, so the same `bun run test` works on a developer's machine, on CI, and
 * inside a group's sandbox, which has no `docker` and no route to the host's
 * loopback.
 */
/**
 * That is where this was found: the first requirement this project gave itself
 * stopped the whole group on `docker is absent from PATH`, and the engineer
 * asked the boss for a database nobody could hand in.
 */
/**
 * `initdb` and `pg_ctl` are driven here rather than through `embedded-postgres`,
 * the package those binaries belong to. Beyond resolving them, its one job is to
 * run them as a `postgres` user when the caller is root — which a sandbox is —
 * and it does that with `child_process.spawn`'s `uid`/`gid`, which Bun ignores:
 * `spawnSync("id", { uid: 65534 })` prints `uid=0(root)` under bun 1.3.14 and
 * `nobody` under node 20 in the same image. `runuser` is what works. Reopen
 * when Bun honours `uid` in `spawn`; the wrapper then deletes to a constructor.
 */
/**
 * A developer who ran `db:test:up` themselves, and the nightly jobs, which run
 * it in `setup-bun` because `test:stress` spawns `bun test` itself, keep the
 * container they asked for: nothing answering is the only case this starts
 * anything, and it stops only what it started.
 */
const TEST_DB = new URL(
  process.env.ORCH_TEST_DATABASE_URL ?? "postgres://orchestrator:orchestrator@127.0.0.1:5433/orchestrator",
);
/**
 * The binaries, one package name at a time.
 *
 * Named as literals rather than built from `process.platform` and `process.arch`,
 * because a path assembled out of two variables is a reference nothing can
 * follow — not a reader, not `bun install`'s `os`/`cpu` filter, and not the dead
 * code audit, which reported all four as devDependencies nobody imports.
 * Thunks, because only this machine's is installed and resolving the other three
 * throws.
 */
const BINARIES: Record<string, () => string> = {
  "darwin-arm64": () => import.meta.resolve("@embedded-postgres/darwin-arm64/package.json"),
  "darwin-x64": () => import.meta.resolve("@embedded-postgres/darwin-x64/package.json"),
  "linux-arm64": () => import.meta.resolve("@embedded-postgres/linux-arm64/package.json"),
  "linux-x64": () => import.meta.resolve("@embedded-postgres/linux-x64/package.json"),
};

/** Where this platform's `initdb` and `pg_ctl` are, said in one place so the
 *  error names the package rather than a path that does not exist. */
function binDir(): string {
  const at = BINARIES[`${process.platform}-${process.arch}`];
  if (!at)
    throw new Error(
      `no PostgreSQL binaries for ${process.platform}-${process.arch}; start one and set ORCH_TEST_DATABASE_URL`,
    );
  return join(dirname(fileURLToPath(at())), "native/bin");
}
const DATA = `${import.meta.dir}/../node_modules/.cache/orch-test-pg`;

/** A TCP connect rather than `pg_ctl status`: someone may be running their own
 *  Postgres on that port, and starting a second one over it is the failure this
 *  is meant to avoid rather than cause. */
async function databaseAnswers(): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: TEST_DB.hostname,
      port: Number(TEST_DB.port || 5433),
      socket: { data() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** The server's settings, read from the compose file so it stays their one
 *  owner: `max_connections`, `fsync=off` and the rest are explained there, and
 *  the nightly jobs still start that container. */
const Compose = z.object({ services: z.object({ "postgres-test": z.object({ command: z.array(z.string()) }) }) });
const serverFlags = (): string[] =>
  Compose.parse(
    Bun.YAML.parse(readFileSync(`${import.meta.dir}/../docker/postgres-test-compose.yml`, "utf8")),
  ).services["postgres-test"].command.slice(1);

/** `runuser -u postgres --` when root, because Postgres refuses to start as
 *  root. The user is made if the image has none; only a sandbox gets here. */
async function asPostgres(): Promise<string[]> {
  if (process.getuid?.() !== 0) return [];
  await $`id -u postgres || useradd --system postgres`.quiet();
  return ["runuser", "-u", "postgres", "--"];
}

/** Brings it up if nothing answers. `started` says whether the server is this
 *  run's to stop, which is the half a guard can check without stopping
 *  somebody else's. */
export async function ownDatabase(): Promise<{ started: boolean; stop: () => Promise<void> }> {
  if (await databaseAnswers()) return { started: false, stop: async () => {} };
  const as = await asPostgres();
  const bin = binDir();
  // Fresh every run: a cluster left by another Postgres version does not start,
  // and with `fsync=off` a cold start costs about a second.
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  if (as.length) await $`chown postgres ${DATA}`.quiet();
  // `trust`, like the compose file's committed password: loopback only, and it
  // holds nothing but throwaway databases. The builtin C.UTF-8 exists on every
  // platform; `en_US` does not exist in a container that installed no locales.
  await $`${as} ${bin}/initdb --pgdata=${DATA} --username=${TEST_DB.username} --auth=trust --encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 --no-sync`.quiet();
  const options = ["-p", TEST_DB.port || "5433", ...serverFlags()].join(" ");
  await $`${as} ${bin}/pg_ctl --pgdata=${DATA} --log=${DATA}/log --wait --options=${options} start`.quiet();
  const name = TEST_DB.pathname.slice(1);
  if (!/^\w+$/.test(name)) throw new Error(`ORCH_TEST_DATABASE_URL names a database this cannot create: ${name}`);
  const sql = new SQL(new URL("/postgres", TEST_DB).href);
  await sql.unsafe(`CREATE DATABASE "${name}"`);
  await sql.end();
  return {
    started: true,
    stop: async () => {
      await $`${as} ${bin}/pg_ctl --pgdata=${DATA} --mode=fast stop`.quiet().nothrow();
    },
  };
}

if (import.meta.main) {
  const release = claim();
  process.on("exit", release);
  const database = await ownDatabase();
  const first = await run();
  if (first.code === 0 || !first.crashed) {
    await database.stop();
    process.exit(first.code);
  }

  console.error(
    "\n[test] a worker crashed — this is bun itself, not a failing test, and it counts every\n" +
      "[test] file it never reached as a failure. Running once more; a second crash is real.\n",
  );
  const second = await run();
  await database.stop();
  process.exit(second.code);
}
