# 034 Symbols come from a grammar, not from a regular expression

**Status**: accepted
**Date**: 2026-08-19
**Follows**: [007](007-github-is-the-source-of-a-project.md), which recorded that the
repo map had had no symbols since it landed, and
[020](020-retrieval-is-rented-and-multilingual.md).

## What was there

One regular expression over `export function|const|class|…`. Three things were wrong
with it and only the first is about coverage:

1. It is JS/TS syntax. A Go file entered the map and came back out with a path and no
   names — and Orchestrator indexes *the boss's* repositories rather than this one, so
   that was the normal case rather than the exotic one.
2. It matched `export function` inside a string or a comment.
3. It could not tell `func (s *Server) Listen()` from `func NewServer()`.

Six languages of that, hand-written, is a parser. `web-tree-sitter` is the parser.

## What is rented

`web-tree-sitter@0.26.12` (MIT, zero dependencies) and `@vscode/tree-sitter-wasm@0.3.1`
(MIT) for the pre-built grammars. Six are imported — Go, JavaScript, Python, Rust, TSX,
TypeScript — covering twelve extensions.

**The grammars are imported, not vendored.** `with { type: "file" }` puts only the
imported `.wasm` in the binary: 4.6 MiB of the 21 MB installed. A vendored copy under
`src/` would need a header saying where it came from and how to refresh it, which is
what a lockfile entry already is, kept current by the same tooling as everything else.

**No `tags.scm`.** The plan that led here assumed vendored tag queries, because that is
how aider does it. What the map needs is the top-level declarations of a file, which is
a walk of the tree's own named children — a query language buys nothing for that, and
`tags.scm` files are per-grammar, unversioned, and would be the vendored copies the
paragraph above declines.

## The finding that only the artefact could give

`Parser.init()` with no arguments is what the README shows. It works under `bun run`
and **fails inside `bun build --compile`**: Emscripten resolves its own
`web-tree-sitter.wasm` as a sibling of the script, and a compiled binary has no
siblings — `ENOENT /$bunfs/root/web-tree-sitter.wasm`. Handing the bytes over through
the documented `wasmBinary` module option is what makes the compiled artefact work.

`test/mech/symbols.test.ts` measures it in the compiled binary rather than reasoning
about it, which is `docs/standards/testing.md`'s rule and the reason this was caught
before release rather than by a user.

## What each language counts as a symbol

JS/TS lists exported names; Go, Python and Rust list top-level ones. That is the cut
each language gives you — the other three have no `export` keyword, visibility being
capitalisation, an underscore or `pub` — and a JS module's private helpers would push
its public names past the map's cap.

## Reopen

A language a client uses that `@vscode/tree-sitter-wasm` does not ship. The cost is one
import and one line in `GRAMMAR`; the reason to state it here is that the answer is
never "add another regex".
