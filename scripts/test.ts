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
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

function claim(): () => void {
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
 * same 1,848 tests. Eight keeps overlap for the I/O-bound majority.
 *
 * Both sit before the caller's arguments, so `bun run test <path>
 * --max-concurrency=2` still wins — verified, Bun takes the last occurrence.
 */
const LIMITS = ["--timeout=20000", "--max-concurrency=8"];

async function run(): Promise<{ code: number; crashed: boolean }> {
  const args = ["test", "--parallel", ...LIMITS, ...Bun.argv.slice(2)];
  const child = Bun.spawn([process.execPath, ...args], { stdout: "pipe", stderr: "pipe" });
  let saw = "";
  const tee = async (from: ReadableStream<Uint8Array>, to: typeof Bun.stdout) => {
    for await (const chunk of from) {
      saw += new TextDecoder().decode(chunk);
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
if (import.meta.main) {
  const release = claim();
  process.on("exit", release);
  const first = await run();
  if (first.code === 0 || !first.crashed) process.exit(first.code);

  console.error(
    "\n[test] a worker crashed — this is bun itself, not a failing test, and it counts every\n" +
      "[test] file it never reached as a failure. Running once more; a second crash is real.\n",
  );
  const second = await run();
  process.exit(second.code);
}
