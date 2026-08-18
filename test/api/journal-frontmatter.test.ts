import { expect, test } from "bun:test";
import { frontmatterBlock } from "../../src/api/orch/report.ts";

/**
 * The frontmatter of an exported journal file, which is committed to the
 * project's own repository and read back by anything that parses it.
 */

test("a value that needs quoting gets it, and a list is not joined on commas", () => {
  // Built by concatenation before this: `group: auth: the sequel` is not YAML at
  // all, and `files: [a,b.ts, c.ts]` parses as three entries rather than two.
  // `files` is agent-supplied and constrained only by length.
  const block = frontmatterBlock({
    group: "auth: the sequel",
    role: "engineer",
    slice: null,
    kind: "journal",
    files: ["a,b.ts", "c.ts"],
  });

  expect(Bun.YAML.parse(block)).toEqual({
    group: "auth: the sequel",
    role: "engineer",
    slice: null,
    kind: "journal",
    files: ["a,b.ts", "c.ts"],
  });
});

test("the block is block style, because these files are read by people", () => {
  const block = frontmatterBlock({ group: "g", role: "scribe", slice: 3, kind: "retro", files: [] });
  expect(block).toContain("role: scribe");
  expect(block).not.toStartWith("{");
});
