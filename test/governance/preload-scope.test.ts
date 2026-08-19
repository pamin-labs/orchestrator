import { expect, test } from "bun:test";
import { z } from "zod";

/**
 * The gate has no list to drift from any more, so what is left is its one
 * precondition.
 *
 * `dom.ts` used to classify by directory plus a hand-kept set, and this file held
 * the drift test for it — scanning every test's imports and failing when one
 * reached the browser without being on the list. `needsDom` now runs that same
 * scan itself, on the file about to run, so the list and the thing it described
 * are one object and cannot disagree. The drift test went with the list.
 *
 * What no scan can see is the flag, below.
 */

/**
 * The gate's precondition, checked on the command that has to carry it.
 *
 * `dom.ts` decides from `Bun.main`, which names the file only when each file
 * gets its own process. `--parallel` implies `--isolate` and buys exactly that;
 * without it Bun runs the whole suite in one process, evaluates the preload
 * once, and every file after the first is classified by the first file's path.
 *
 * Nothing else catches this. The mode is invisible from inside the preload —
 * `process.argv` is rewritten to the current test file either way, a `--parallel`
 * worker carries no IPC handle to spot, and `[test] parallel`/`[test] isolate`
 * in `bunfig.toml` are silently ignored (all three measured against Bun 1.3.14).
 * So if the flag ever leaves this script, the suite does not fail here — it goes
 * green while classifying 149 files from one path, until some later run trips
 * over `HTMLElement is not defined` in a file that looks nothing like a DOM test.
 */
test("the test script isolates files, which is what dom.ts's gate reads Bun.main for", async () => {
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(await Bun.file(new URL("../../package.json", import.meta.url)).json());
  const isolating = (script: string) => script.includes("--parallel") || script.includes("--isolate");
  const offenders = Object.entries(scripts)
    .filter(([, script]) => script.includes("bun test"))
    .filter(([, script]) => !isolating(script))
    .map(([name]) => name);
  expect(offenders).toEqual([]);
});
