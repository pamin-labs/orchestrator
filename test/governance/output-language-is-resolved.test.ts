import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { outputLanguage } from "../../src/contracts/config.ts";

/**
 * `config.language` is an intent, not an answer.
 *
 * `""` means "follow the panel", so a reader that takes the field directly gets
 * an empty string and writes a prompt saying the agent should answer in nothing.
 * `outputLanguage()` is where the three values become one, and thirteen files
 * read this — the twenty-fifth is the one that would not have.
 */
const READS = /\b(?:ctx\.config|cfg|config)\.language\b/;

const offenders = (file: string, source: string): string[] =>
  file !== "src/contracts/config.ts" && READS.test(source)
    ? [`${file} reads config.language instead of outputLanguage(config)`]
    : [];

test("nothing reads the raw language field except the function that resolves it", () => {
  const all: string[] = [];
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(".")) {
    all.push(...offenders(file, readFileSync(file, "utf8")));
  }
  expect(all).toEqual([]);
});

test("it fires on a direct read and not on the resolved one", () => {
  expect(offenders("src/probe.ts", "const lang = ctx.config.language;")).toHaveLength(1);
  expect(offenders("src/probe.ts", "const lang = cfg.language;")).toHaveLength(1);
  expect(offenders("src/probe.ts", "const lang = outputLanguage(ctx.config);")).toEqual([]);
  expect(offenders("src/contracts/config.ts", "cfg.language || cfg.panelLanguage")).toEqual([]);
});

/**
 * What "nobody has said" resolves to, which is the whole point of the change:
 * a fresh installation has no language written down and still speaks the
 * reader's.
 */
test("output follows the boss, then the panel, then English", () => {
  expect(outputLanguage({ language: "Deutsch", panelLanguage: "zh" })).toBe("Deutsch");
  expect(outputLanguage({ language: "", panelLanguage: "zh" })).toBe("zh");
  expect(outputLanguage({ language: "", panelLanguage: "" })).toBe("en");
});
