import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Every directory holding first-party TypeScript is linted.
 *
 * `scripts/` was not, and ten findings were waiting there — two of them
 * `no-floating-promises`, the rule that matters most during an async migration.
 * `benchmark.ts` called five newly async span queries without awaiting one, so
 * the telemetry budget measured five promises being constructed, 67µs against a
 * 600ms ceiling, and could not have gone red. A gate that does not read a
 * directory is a gate that directory does not have.
 */

const IGNORED = new Set(["node_modules", "dist", "coverage", "docs", "roles", "config", "docker"]);

const holdsTypeScript = (dir: string): boolean => {
  const stack = [dir];
  for (let seen = 0; stack.length && seen < 4_000; seen++) {
    const here = stack.pop()!;
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
      if (entry.isDirectory()) stack.push(join(here, entry.name));
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) return true;
    }
  }
  return false;
};

test("the lint script reads every directory that holds TypeScript", () => {
  const pkg = z
    .object({ scripts: z.object({ lint: z.string() }) })
    .parse(JSON.parse(readFileSync("package.json", "utf8")));
  const targets = pkg.scripts.lint.split(/\s+/).slice(1);
  expect(targets.length).toBeGreaterThan(0);

  const roots = readdirSync(".", { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED.has(e.name))
    .map((e) => e.name)
    .filter(holdsTypeScript);
  // The scan must have found something, or this passes by finding nothing —
  // which is the same failure shape it exists to catch.
  expect(roots).toContain("src");
  expect(roots).toContain("scripts");

  for (const root of roots) {
    expect({ root, linted: targets.some((t) => t === root || t.startsWith(`${root}/`)) }).toEqual({
      root,
      linted: true,
    });
  }
});
