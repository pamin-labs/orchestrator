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
export const CRASHED = /worker crashed with SIG|Segmentation fault|oh no: Bun has crashed/;

async function run(): Promise<{ code: number; crashed: boolean }> {
  const args = ["test", "--parallel", ...Bun.argv.slice(2)];
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
  const first = await run();
  if (first.code === 0 || !first.crashed) process.exit(first.code);

  console.error(
    "\n[test] a worker crashed — this is bun itself, not a failing test, and it counts every\n" +
      "[test] file it never reached as a failure. Running once more; a second crash is real.\n",
  );
  const second = await run();
  process.exit(second.code);
}
