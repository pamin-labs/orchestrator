import { expect, test } from "bun:test";
import { buildMap, indexable } from "../../src/mech/knowledge/repomap.ts";

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

  // The correction failed open, and silently. The hand-written glob compiled
  // `**` to `.*` between the two literal slashes around it, so `**/` demanded a
  // directory: the exclude matched `src/gen/a.ts` and let `a.ts` and
  // `docs/a.md` — the files the boss was pointing at — straight into the index,
  // while the config still read as if they were out.
  expect(indexable("a.ts", ["**/*.ts"])).toBe(false);
  expect(indexable("docs/a.md", ["docs/**/*.md"])).toBe(false);
  expect(indexable("docs/x/a.md", ["docs/**/*.md"])).toBe(false);
  expect(indexable("docs/a.txt", ["docs/**/*.md"])).toBe(true);
});

test("the map's symbols come from a reader the caller supplies, not from this machine", () => {
  // The bug this exists to stop reappearing: `buildMap` read the file itself,
  // with `readFileSync(join(repoPath, rel))`. Since 007 §2, `repo_path` is
  // `owner/name` — a GitHub coordinate, not a directory — so every read threw,
  // every throw was caught as "a file git knows about and the disk does not",
  // and the map has rendered **paths with no symbols** ever since. It kept
  // saying `repo map refreshed`, and the thing seven groups were rediscovering
  // by grep was quietly back.
  const files = ["src/a.ts", "src/b.go", "docs/x.md"];
  const text: Record<string, string> = {
    "src/a.ts": "export function alpha() {}\nexport const beta = 1;\n",
    "src/b.go": "func Gamma() {}\n",
  };

  const withReader = buildMap(
    "owner/repo",
    () => files,
    [],
    (rel) => text[rel],
  );
  const a = withReader.find((n) => n.dir === "src")!.files.find((f) => f.name === "a.ts")!;
  expect(a.symbols).toEqual(["alpha", "beta"]);
  // Opportunistic, not universal: `EXPORTED` is JS/TS syntax, so a Go file gets
  // a path and no names — which is still an answer to "where does X live".
  expect(withReader.find((n) => n.dir === "src")!.files.find((f) => f.name === "b.go")!.symbols).toEqual([]);

  // And a caller with no way to read contents gets a paths-only map rather than
  // a silent one. This is the shape the whole system had, and it must be a
  // choice a caller makes rather than an exception it never sees.
  const pathsOnly = buildMap("owner/repo", () => files);
  expect(pathsOnly.flatMap((n) => n.files.map((f) => f.name)).sort()).toEqual(["a.ts", "b.go", "x.md"]);
  expect(pathsOnly.every((n) => n.files.every((f) => f.symbols.length === 0))).toBe(true);
});
