import { expect, test } from "bun:test";
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

/** `oxc` returns the map beside the code; the shape it uses is not the plugin's business. */
const mapOf = (code: string, path: string): { path: string; fnMap: Record<string, { decl: { start: { line: number } } }> } => {
  const marker = "coverageData = {";
  const at = code.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = code.indexOf("{", at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- oxc's own emitted literal; a shape change here should fail loudly on the next line, not be re-validated
    else if (code[i] === "}" && --depth === 0) return JSON.parse(code.slice(open, i + 1)) as ReturnType<typeof mapOf>;
  }
  throw new Error(`no coverage data in ${path}`);
};

test("expanding macros before instrumenting leaves both transforms working", () => {
  const source = readFileSync(PANEL, "utf8");
  expect(source).toContain("useLingui");

  const { code, map } = expandMacros(source, PANEL);
  // The macro is gone and the runtime import took its place; the reverse order
  // throws before reaching here.
  expect(code).not.toContain("@lingui/react/macro");
  expect(map).toBeTruthy();

  const out = instrumented(code, PANEL, map);
  const data = mapOf(out, PANEL);

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
