import { expect, test } from "bun:test";
import { z } from "zod";

/**
 * The gate has no list to drift from any more, so what is left is its one
 * precondition.
 *
 * `dom.ts` used to classify by directory plus a hand-kept set, and this file held
 * the drift test for it. `needsDom` now runs that same scan itself, on the file
 * about to run, so the list and the thing it described are one object and cannot
 * disagree. The drift test went with the list; what no scan can see is the flag.
 */

/**
 * The gate's precondition, checked on the command that has to carry it.
 *
 * `dom.ts` decides from `Bun.main`, which names the file only when each file gets
 * its own process. `--parallel` implies `--isolate` and buys exactly that; without
 * it Bun runs the suite in one process, evaluates the preload once, and classifies
 * every later file by the first file's path.
 */
/**
 * Nothing else catches this. The mode is invisible from inside the preload —
 * `process.argv` is rewritten either way, a worker carries no IPC handle to spot,
 * and `[test]` keys in `bunfig.toml` are silently ignored (all measured against Bun
 * 1.3.14). So if the flag left this script the suite would go green while
 * classifying every file from one path, until a later run tripped over
 * `HTMLElement is not defined` somewhere that looks nothing like a DOM test.
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
