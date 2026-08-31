import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Which language an agent writes in is said in exactly one place.
 *
 * `buildStable` injects `## Output language`, and it is the only text that knows
 * what the setting resolved to. A role file cannot: it is static YAML, so a
 * sentence in one is a second owner that is right until the boss changes the
 * knob and wrong afterwards.
 */
/**
 * `roles/scribe.yaml` carried `**English, always**, whatever language the panel
 * is being read in` for as long as commits were English. When they stopped
 * being, that line was still there — instructing the model to ignore the
 * paragraph three sections above it.
 */
const CLAIMS = [
  // A language named as the answer, rather than referred to as a setting.
  /\bEnglish, always\b/i,
  /\balways\s+(?:in\s+)?English\b/i,
  /\bwrite\s+(?:it\s+)?in\s+English\b/i,
  /\bin\s+English,?\s+whatever\b/i,
];

const roles = (): [string, string][] =>
  [...new Bun.Glob("roles/*.yaml").scanSync(".")].sort().map((f) => [f, readFileSync(f, "utf8")]);

test("no role file decides what language to write in", () => {
  const said = roles().flatMap(([file, source]) =>
    CLAIMS.filter((claim) => claim.test(source)).map((claim) => `${file}: ${claim.source}`),
  );

  expect(said).toEqual([]);
});

test("the one owner still says it", () => {
  // Or the assertion above passes because nobody says it anywhere, which is a
  // fleet writing in whatever each model felt like.
  const assemble = readFileSync("src/prompt/assemble.ts", "utf8");
  expect(assemble).toContain("## Output language");
  expect(assemble).toContain("${parts.language}");
});
