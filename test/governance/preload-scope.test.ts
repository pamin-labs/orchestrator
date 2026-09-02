import { expect, test } from "bun:test";
import { scan } from "../support/ast.ts";
import { z } from "zod";
import { stressFiles } from "../../scripts/stress-tests.ts";

/**
 * What the preload owes every worker, checked from inside one.
 *
 * `dom.ts` used to register happy-dom for the one file `Bun.main` named, which
 * is a file only when each gets its own process — so the rule this file guarded
 * was that every `bun test` carried `--isolate`. It registers once per worker
 * now, and that is what lets the suite drop the flag: 253 files re-evaluating
 * their module graph was ~7GB of memory and 46s, against ~2GB and 24s without.
 */
/**
 * The half that replaces it is the half that is invisible. happy-dom brings its
 * own `Request`, and a signal from one realm's `AbortController` is not an
 * `AbortSignal` to the other's — five tests in `test/http` said
 * `signal is not of type AbortSignal`, and before that a body over the limit was
 * answered 400 where Bun answers 413. Nothing about a document being present
 * says the network classes were put back.
 */
test("the preload leaves a worker a document and Bun's own network classes", () => {
  expect(typeof document).toBe("object");
  expect(typeof localStorage).toBe("object");
  const aborter = new AbortController();
  expect(() => new Request("http://x/", { signal: aborter.signal })).not.toThrow();
  expect(() => new Response(new ReadableStream())).not.toThrow();
});

/**
 * Which files may run `bun test`, still named rather than counted.
 *
 * The check that reads `package.json` is how the old rule got out: `test:stress`
 * spawns `bun test` from TypeScript, so the string a scripts-field scan looks
 * for was never there. Both argv shapes are matched — `["bun", "test", …]` and
 * `= ["test", …]` — rather than the one that happened to be looked at.
 */
test("two scripts run the suite, and a third is a decision rather than a habit", async () => {
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(await Bun.file(new URL("../../package.json", import.meta.url)).json());
  const direct = Object.entries(scripts)
    .filter(([, script]) => script.includes("bun test"))
    .map(([name]) => name);
  expect(direct).toEqual([]);

  const runsBunTest = (src: string) => /\[\s*"bun",\s*"test"\s*,|=\s*\[\s*"test"\s*,/.test(src);
  const spawners = scan("scripts/**/*.ts", (file, source) => (runsBunTest(source) ? [file] : [])).toSorted();
  expect(spawners).toEqual(["scripts/stress-tests.ts", "scripts/test.ts"]);
  // The stress pass no longer excludes the browser files — the document is there
  // for them — and it still has something to stress.
  expect(stressFiles().length).toBeGreaterThan(100);
});
