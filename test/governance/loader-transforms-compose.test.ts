import { expect, test } from "bun:test";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { expandMacros } from "../../scripts/lingui-macros.ts";
import { instrumented } from "../support/coverage.ts";

/**
 * The two transforms in `test/support/loader.ts`, run in the order it runs them.
 *
 * They collided silently for a branch: `oxc-coverage-instrument` rewrites the
 * initialiser of `const { t } = useLingui()` into a sequence expression, and the
 * Lingui macro then refuses the file — "`useLingui` macro must be used in
 * variable declaration". Only `ORCH_COVERAGE=1` runs both, so `bun run test`
 * was green while CI's coverage job failed on 21 panel files. This test pays
 * for neither environment variable: it calls the transforms directly.
 */
const PANEL = `${process.cwd()}/web/src/ui/bits.tsx`;

/**
 * `oxc` returns the Istanbul map beside the code, so nothing here has to go
 * looking for it in the emitted source. This used to count braces from
 * `coverageData = {` and `JSON.parse` the slice, with an oxlint suppression for
 * the cast that followed — a second hand-written bracket matcher in a tree that
 * had just deleted one.
 */
/** The two fields this test reads, parsed rather than asserted: `JSON.parse`
 *  hands back `any`, and a shape change should say so here. */
const CoverageMapSchema = z.object({
  path: z.string(),
  fnMap: z.record(z.string(), z.object({ decl: z.object({ start: z.object({ line: z.number() }) }) })),
});

test("expanding macros before instrumenting leaves both transforms working", () => {
  const source = readFileSync(PANEL, "utf8");
  expect(source).toContain("useLingui");

  const { code, map } = expandMacros(source, PANEL);
  // The macro is gone and the runtime import took its place; the reverse order
  // throws before reaching here.
  expect(code).not.toContain("@lingui/react/macro");
  expect(map).toBeTruthy();

  const { coverageMap } = instrumented(code, PANEL, map);
  expect(coverageMap).not.toBeNull();
  const data = CoverageMapSchema.parse(JSON.parse(coverageMap ?? ""));

  // Keyed by the file on disk, not by babel's basename: the report merges shards
  // on this string, and `bits.tsx` is not a path anything can resolve.
  expect(data.path).toBe(PANEL);

  // And the counters describe the file on disk. `Clamp` is what the panel's
  // long-prose blocks render through, and it is the function that carries the
  // `useLingui` call this test exists for.
  const lines = source.split("\n");
  const clamp = Object.values(data.fnMap).find((fn) => lines[fn.decl.start.line - 1]?.includes("function Clamp"));
  expect(clamp).toBeDefined();
});
