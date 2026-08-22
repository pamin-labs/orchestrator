import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DRAFT_FIELDS } from "../../src/contracts/card.ts";
import { ASK_KINDS, RESERVED } from "../../src/contracts/states.ts";

/**
 * A role file is the only manual a sandboxed agent has, and it quotes vocabulary
 * the contracts own.
 *
 * `dispatch.ts` derives its `--help` from `ASK_KINDS` and `JOURNAL_KINDS`, so
 * the CLI cannot drift. The prompts do not: four lists across two files are
 * typed out by hand and nothing reads them.
 */
/**
 * Add a tenth ask kind and the CLI takes it, the queue labels it (`select.ts` is
 * `satisfies Record<AskKind, …>`), and the two agents that actually file
 * questions never learn the word exists. Rename a card field and every DRAFT
 * card comes back `missing sections`, the only signal a rejection at runtime.
 */
/**
 * A guard rather than interpolation. Templating the role files would move the
 * vocabulary somewhere an author cannot read while writing the paragraph around
 * it, for a list that changes about once a release — and this repository already
 * answers "two owners" with a test rather than with machinery.
 */
const roles = (): [string, string][] =>
  [...new Bun.Glob("roles/*.yaml").scanSync(".")].sort().map((file) => [file, readFileSync(file, "utf8")]);

test("a role file that lists the ask kinds lists all of them", () => {
  // Matched as the pipe-separated run it is actually written as, not by counting
  // loose words: `scope`, `design` and `boundary` are ordinary English and turn
  // up all over these files as prose.
  const spelled = roles().flatMap(([file, source]) => {
    const run = /`--kind` is required, one of ([a-z|]+)/.exec(source)?.[1];
    return run === undefined ? [] : [[file, run] as const];
  });

  // At least one file says it, or the assertion below passes on silence.
  expect(spelled.length).toBeGreaterThan(0);
  expect(spelled.filter(([, run]) => run !== ASK_KINDS.join("|")).map(([file, run]) => `${file}: ${run}`)).toEqual([]);
});

test("`the first five` is still five, and still the reserved ones", () => {
  // The claim in both files is positional — "the first five are the boss's
  // alone" — so it goes wrong the moment `RESERVED` and the head of `ASK_KINDS`
  // stop agreeing, which no test of either list alone can see.
  expect(ASK_KINDS.slice(0, RESERVED.length)).toEqual([...RESERVED]);
  expect(RESERVED).toHaveLength(5);
  expect(roles().filter(([, source]) => source.includes("first five")).length).toBeGreaterThan(0);
});

test("the card template writes the headings the parser accepts", () => {
  const template = roles().find(([file]) => file.endsWith("dispatcher.yaml"))?.[1] ?? "";
  expect(template).not.toBe("");
  // The headings as the Dispatcher is told to copy them, in the order it is told
  // to write them — `validateDraftCard` reports `missing sections` by name, so a
  // renamed field here is a card nobody can file.
  const written = [...template.matchAll(/^[^\S\n]*## (\S.*)$/gm)].map((m) => m[1]!.trim());
  expect(written).toEqual([...DRAFT_FIELDS]);
});
