import { expect, test } from "bun:test";
import { indexable } from "../src/mech/knowledge/repomap.ts";


test("what belongs in an index is decided by exclusion, not by an extension list", () => {
  // Both indexes used to carry their own allow-list. repomap's named eighteen
  // languages while its symbol regex parses JS/TS only; PageIndex's named seven,
  // and on this repository its entire effect was to drop eight files — one
  // lockfile and seven things an agent would reasonably ask about. Point either
  // at a Go, Python or Rust project and the source is invisible.
  for (const ok of [
    "main.go",
    "app.py",
    "src/lib.rs",
    "README.rst",
    "docs/guide.mdx",
    "notes.txt",
    "Dockerfile",
    "Makefile",
    "web/index.html",
    "src/api.ts",
  ]) {
    expect({ path: ok, indexable: indexable(ok) }).toEqual({ path: ok, indexable: true });
  }

  // The set that is *not* text a model can summarise is stable and
  // language-independent, which is why the rule runs this way round.
  for (const no of [
    "bun.lock",
    "package-lock.json",
    "Cargo.lock",
    "go.sum",
    "assets/logo.png",
    "fonts/x.woff2",
    "vendor/github.com/x/y.go",
    "third_party/z.py",
    "dist/bundle.min.js",
    "dist/bundle.js.map",
    "data/orchestrator.sqlite",
  ]) {
    expect({ path: no, indexable: indexable(no) }).toEqual({ path: no, indexable: false });
  }
});

test("a project can correct what detection got wrong", () => {
  // Same arrangement detect.ts uses for gates: best-effort, written where the
  // boss can edit it, rather than a guess nobody can override.
  expect(indexable("docs/legacy/a.md", ["docs/legacy/**"])).toBe(false);
  expect(indexable("docs/a.md", ["docs/legacy/**"])).toBe(true);
  expect(indexable("gen/schema.ts", ["gen/*.ts"])).toBe(false);
  expect(indexable("gen/deep/schema.ts", ["gen/*.ts"])).toBe(true);
});
