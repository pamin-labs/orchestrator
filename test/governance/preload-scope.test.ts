import { expect, test } from "bun:test";
import { scan } from "../support/ast.ts";
import { z } from "zod";
import { needsDom } from "../../scripts/needs-dom.ts";
import { stressFiles } from "../../scripts/stress-tests.ts";

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
test("every place that runs `bun test` either isolates files or leaves the browser ones out", async () => {
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(await Bun.file(new URL("../../package.json", import.meta.url)).json());
  const isolating = (script: string) => script.includes("--parallel") || script.includes("--isolate");
  const offenders = Object.entries(scripts)
    .filter(([, script]) => script.includes("bun test"))
    .filter(([, script]) => !isolating(script))
    .map(([name]) => name);
  expect(offenders).toEqual([]);

  // A script is the other way to run one, and it is how the rule got out: the
  // check above reads `package.json`, and `test:stress` spawns `bun test` from
  // TypeScript, so the string it looks for was never there. 195 failures, 20 of
  // 21 distinct ones `HTMLElement is not defined`.
  // The argv, with `test` as its first word: `["bun", "test", …]` and
  // `[process.execPath, ...args]` where `args` opens `["test", …]`. Reading only
  // `package.json` is how this rule got out in the first place, so the shapes
  // are matched rather than the one that happened to be looked at.
  const runsBunTest = (src: string) => /\[\s*"bun",\s*"test"\s*,|=\s*\[\s*"test"\s*,/.test(src);
  const spawners = scan("scripts/**/*.ts", (file, source) => (runsBunTest(source) ? [file] : [])).toSorted();
  // Named, so a second one is a decision somebody has to make rather than a
  // silent third way of running the suite.
  expect(spawners).toEqual(["scripts/stress-tests.ts", "scripts/test.ts"]);
  // `test.ts` isolates. `stress-tests.ts` deliberately does not — cross-file
  // order dependence is what it hunts, and `--parallel` implies `--isolate`,
  // which is the configuration that cannot have the bug. So it owes the other
  // half of the rule instead.
  expect(stressFiles().filter(needsDom)).toEqual([]);
  // And it is not excluding everything: the pass still has something to stress.
  expect(stressFiles().length).toBeGreaterThan(100);
});
