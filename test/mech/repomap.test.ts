import { describe, expect, test } from "bun:test";
import { buildMap, indexable, loadMap, mapFor, saveMap } from "../../src/mech/knowledge/repomap.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { saveSingletonNote } from "../../src/mech/util/rows.ts";
import * as fx from "../support/factories.ts";

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

/**
 * A project can correct what detection got wrong — the same arrangement `detect.ts`
 * uses for gates: best-effort, written where the boss can edit it.
 */
/**
 * The correction failed open, and silently. The hand-written glob compiled `**` to
 * `.*` between the two literal slashes around it, so a leading `**` followed by a
 * slash demanded a directory: the exclude matched `src/gen/a.ts` and let `a.ts` and
 * `docs/a.md` — the files the boss was pointing at — straight into the index, while
 * the config still read as if they were out.
 *
 * A case per glob, so a regression names the pattern that stopped matching rather
 * than printing a bare `expected false`.
 */
describe("a project can correct what detection got wrong", () => {
  test.each([
    ["docs/legacy/a.md", ["docs/legacy/**"], false],
    ["docs/a.md", ["docs/legacy/**"], true],
    ["gen/schema.ts", ["gen/*.ts"], false],
    ["gen/deep/schema.ts", ["gen/*.ts"], true],
    ["a.ts", ["**/*.ts"], false],
    ["docs/a.md", ["docs/**/*.md"], false],
    ["docs/x/a.md", ["docs/**/*.md"], false],
    ["docs/a.txt", ["docs/**/*.md"], true],
  ])("%s against %j is indexable: %p", (path, excludes, want) => {
    expect(indexable(path, excludes)).toBe(want);
  });
});

test("the map's symbols come from a reader the caller supplies, not from this machine", async () => {
  // The bug this exists to stop reappearing: `buildMap` read the file itself,
  // with `readFileSync(join(repoPath, rel))`. Since 007 §2, `repo_path` is
  // `owner/name` — a GitHub coordinate, not a directory — so every read threw,
  // every throw was caught as "a file git knows about and the disk does not",
  // and the map has rendered **paths with no symbols** ever since. It kept
  // saying `repo map refreshed`, and the thing seven groups were rediscovering
  // by grep was quietly back.
  const files = ["src/a.ts", "src/b.go", "src/c.py", "docs/x.md"];
  const text: Record<string, string> = {
    "src/a.ts": "export function alpha() {}\nexport const beta = 1;\n",
    "src/b.go": "func Gamma() {}\n",
    "src/c.py": "import os\n\nclass Delta:\n    def method(self): pass\n\ndef epsilon(): pass\n",
  };

  const withReader = await buildMap(
    "owner/repo",
    () => files,
    [],
    (rel) => text[rel],
  );
  const a = withReader.find((n) => n.dir === "src")!.files.find((f) => f.name === "a.ts")!;
  expect(a.symbols).toEqual(["alpha", "beta"]);
  // The two languages the old comment named as invisible, and this is the map
  // asserting it rather than `symbols.ts` asserting it about itself. Both used to
  // come back `[]`, because the one regex doing this parsed JS/TS syntax; the
  // Go and Python rows are what a boss's repository actually looks like, and
  // they are the reason the whole change exists.
  const src = withReader.find((n) => n.dir === "src")!;
  expect(src.files.find((f) => f.name === "b.go")!.symbols).toEqual(["Gamma"]);
  // `import os` is not a declaration and the class names itself, so its method
  // does not appear beside it.
  expect(src.files.find((f) => f.name === "c.py")!.symbols).toEqual(["Delta", "epsilon"]);

  // And a caller with no way to read contents gets a paths-only map rather than
  // a silent one. This is the shape the whole system had, and it must be a
  // choice a caller makes rather than an exception it never sees.
  const pathsOnly = await buildMap("owner/repo", () => files);
  expect(pathsOnly.flatMap((n) => n.files.map((f) => f.name)).sort()).toEqual(["a.ts", "b.go", "c.py", "x.md"]);
  expect(pathsOnly.filter((n) => !n.files.every((f) => f.symbols.length === 0))).toEqual([]);
});

test("the map is searched with the same tokenizer as the notes", async () => {
  // `mapFor` had its own tokenizer: `/[a-z0-9_./-]{3,}/g`. Two consequences, both
  // measurable. Stop words became query terms, and scoring is `hay.includes(w)`,
  // so `the` matched `theme.ts` and ranked it level with a real hit. And anything
  // under three characters was dropped, so `db`, `mw`, `ui` and `id` could not be
  // searched for at all.
  //
  // It does not make a question with no Latin in it work — the haystack is paths
  // and exported names, so a Chinese term matches nothing either way. What it
  // fixes is the ranking of the questions that do.
  const nodes = await buildMap("owner/repo", () => ["src/db/schema.ts", "web/src/theme.ts"]);
  const found = mapFor(nodes, "where is the db schema", 4000);
  expect(found).toContain("src/db");
  expect(found).not.toContain("theme");
});

/**
 * The map is stored as data, not as the text a prompt reads.
 *
 * It used to be persisted rendered and parsed back by splitting on `" — "` and
 * `", "`, so a file whose name contained the separator came back as a different
 * file with different symbols and nothing said so. The render is one-way.
 */
test("a file name containing the render's separator survives a round trip", async () => {
  const db = await openMemory();
  const p = (await fx.on(db).project.create({ name: "p" })).id;
  const nodes = [
    { dir: "src", files: [{ name: "a — b.ts", symbols: ["one, two", "three"] }] },
    { dir: "docs", files: [{ name: "plain.md", symbols: [] }] },
  ];
  expect(await saveMap(db, p, nodes)).toBe(true);
  expect(await loadMap(db, p)).toEqual(nodes);
  // Unchanged content is still not a write, which is what the rule depends on.
  expect(await saveMap(db, p, nodes)).toBe(false);
});

test("a map written by an older build reads as absent rather than as nonsense", async () => {
  const db = await openMemory();
  const p = (await fx.on(db).project.create({ name: "p" })).id;
  await saveSingletonNote(db, p, "map", "src/\n  a.ts — one, two\n");
  expect(await loadMap(db, p)).toEqual([]);
});
