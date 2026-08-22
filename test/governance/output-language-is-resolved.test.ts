import { expect, test } from "bun:test";
import { traverse } from "@babel/core";
import { parse, scan } from "../support/ast.ts";

/**
 * `config.language` is an intent, not an answer.
 *
 * `""` means "follow the panel", so a reader that takes the field directly gets
 * an empty string and writes a prompt saying the agent should answer in nothing.
 * `outputLanguage()` is where the three values become one, and thirteen files
 * read this — the twenty-fifth is the one that would not have.
 */
/**
 * Parsed, not grepped, like its three sibling guards. The regular expression
 * this replaced matched anywhere in the file, so a comment or a docstring saying
 * `cfg.language` failed the build — including the ones on `outputLanguage`
 * itself, which is why the owning file was exempted by path rather than the
 * declaration being recognised.
 */
/**
 * One owner, not two: `no-restricted-properties` in `.oxlintrc.json` would catch
 * `cfg.language` and `config.language` for free, but it matches on an
 * identifier's name and `ctx.config.language` has none — its object is a member
 * expression. Half a rule in a second enforcement owner is what the engineering
 * guide forbids, so it all lives here.
 */
const HOLDER = /^(?:cfg|config)$/;

/** `cfg.language`, `config.language`, and anything `.config.language`. */
const readsRaw = (object: { type: string; name?: string; property?: { type: string; name?: string } }): boolean =>
  (object.type === "Identifier" && HOLDER.test(object.name ?? "")) ||
  (object.type === "MemberExpression" && object.property?.type === "Identifier" && object.property.name === "config");

const offenders = (file: string, source: string): string[] => {
  if (file === "src/contracts/config.ts") return [];
  const ast = parse(file, source);
  if (!ast) return [];
  const found: string[] = [];
  traverse(ast, {
    MemberExpression(p) {
      const { object, property, computed } = p.node;
      if (computed || property.type !== "Identifier" || property.name !== "language") return;
      if (readsRaw(object)) {
        found.push(`${file}:${p.node.loc?.start.line ?? 0} reads config.language instead of outputLanguage(config)`);
      }
    },
  });
  return found;
};

test("nothing reads the raw language field except the function that resolves it", () => {
  expect(scan("src/**/*.ts", offenders)).toEqual([]);
});

test("it fires on a direct read and not on the resolved one, or on prose", () => {
  expect(offenders("src/probe.ts", "const lang = ctx.config.language;")).toHaveLength(1);
  expect(offenders("src/probe.ts", "const lang = cfg.language;")).toHaveLength(1);
  expect(offenders("src/probe.ts", "const lang = outputLanguage(ctx.config);")).toEqual([]);
  // The regular expression could not tell these two from a read.
  expect(offenders("src/probe.ts", "// never read cfg.language directly\nconst x = 1;")).toEqual([]);
  expect(offenders("src/probe.ts", 'const why = "cfg.language is an intent";')).toEqual([]);
  // Nor a field of the same name on something that is not the config.
  expect(offenders("src/probe.ts", "const l = note.language;")).toEqual([]);
});
