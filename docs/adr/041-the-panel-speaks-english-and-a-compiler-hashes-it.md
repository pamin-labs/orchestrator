# 041 The panel's copy is English in the source, and its ids are the compiler's

**Status**: accepted
**Date**: 2026-08-20

The panel was written in Chinese and there was no way to read it in anything
else. The first attempt at fixing that (PR #9, react-i18next) worked and cost
834 hand-written keys — `settings.project.removeConfirmBody` and 833 more —
with the Chinese still present in `web/src` as a default value beside each one.
Two things to keep in step, and a key that is a guess at what a string is for.

Lingui removes the layer instead of automating it. `<Trans>Rescan</Trans>` says
what it says, and `lingui extract` computes the id from the text — a sha256
prefix, `Igjjz3`. Nobody writes a key, nobody keeps two files in step, and a
reworded sentence becomes a new message with the old one marked obsolete, which
is what gettext has meant by that for thirty years.

## What Lingui owns and what stays ours

It owns message extraction, ICU parsing and formatting, the catalog format, and
message identity. What stays ours is which locale is active and how it is chosen.

The panel's language is **this browser's**, stored in `localStorage` and
defaulting to `navigator.language`. It does not follow `output.language`:
[`035`](035-language-follows-who-wrote-it.md) governs what the agents write, and
that knob sits in the cache prefix, so reading a pane in another language would
rotate every session in the fleet. `src/contracts/config.ts` holds the one
function mapping free text — `中文`, `ja_JP`, `Japanese` — onto a catalog, and
both sides call it.

`src/platform/text/lang.ts` is **not** migrating. It owns the ~44 strings the
orchestrator itself emits, and the release binary is built by
`bun build --compile` — no bundler config, no plugin, so a macro there would
have to be expanded at runtime in production. The boundary is: the panel is
bundled and gets macros; the server is not and keeps its table. The README's
translation table counts both, which is how a reader can see they are two
mechanisms rather than one that is half-done.

## Why babel, when ADR 015 measured it and refused it

[`015`](015-coverage-has-one-owner.md) rejected `@babel/core` as the coverage
instrumenter on numbers: instrumentation is a **whole-subject** transform — every
file under `src` and `web/src`, re-run per test file because `--parallel` implies
`--isolate` — and it cost 387s of CPU and 71s of wall clock against oxc's 5s and
8s. That decision stands and oxc is still the only thing that instruments.

Macro expansion is a different shape. It is **bounded**: a `includes("@lingui/")`
scan rejects a file before it is parsed, so only the 51 files under `web/src`
that hold copy can reach babel, and only the 58 test processes that import one
of them pay anything at all. `test/support/loader.ts` refuses to register the
plugin for a test file that cannot reach `web/src`, decided from `Bun.main` the
way `dom.ts` decides it needs a document.

Measured on this machine, median of three alternating runs against `main`:

| | main | here |
|---|---|---|
| `bun run test`, CPU | 137.2s | 151.6s (+10.5%) |
| `bun run build:web`, wall | 0.22s | 0.25s |
| `web/dist/main.js` | 1,697,982 B | 1,778,092 B (+4.7%) |
| one catalog chunk | — | 125–156 KB |

`main.js` grows by the Lingui runtime and the ICU compiler and by nothing else:
`splitting: true` puts each catalog in its own chunk, so a browser fetches the
one language it reads and English fetches none. The eight together are 1.09 MB
on disk and nobody downloads them. An earlier revision of this table said
1.86 MB, which was this number before the split.

Both numbers are what they are because of a content-addressed cache in
`.cache/lingui`. Without it the suite was +22% and `build:web` was 0.60s: under
`--isolate` the same panel module is expanded once per test process that imports
it, 58 times for the same bytes. The key is the path, the source and the
installed plugin version, so an edit misses and an upgrade misses. A cold cache costs one babel call per
file — measured at 142.8s against a warm 143.3s, because 51 calls is nothing
next to 58 × 51.

**The rule that keeps 015 intact, stated so it can be checked**: babel never
instruments, oxc never expands macros, and the two meet in exactly one `onLoad`
in `test/support/loader.ts` — **expansion first**, with the map it produces
handed to oxc as `inputSourceMap`.

This paragraph said "oxc first" until the coverage job proved it could not be:
oxc rewrites the initialiser of `const { t } = useLingui()` into a sequence
expression and the macro then refuses the file. The statement map still has to
describe the file on disk, which is what `composeInputSourceMap` is for.
`test/governance/loader-transforms-compose.test.ts` holds the order, and holds
it without either environment variable.

`@babel/core` appears at two call sites — `scripts/lingui-macros.ts` transforms,
`test/governance/panel-speaks-english.test.ts` only parses — both with
`configFile: false` and `babelrc: false`. Neither instruments, which is the part
015 cares about.

## What Bun made us do

Three facts about Bun 1.3.14, each measured rather than assumed:

`bun build` the CLI has no `--plugin` flag and `bunfig.toml` has no bundler key,
so `build:web` is `scripts/build-web.ts` now. The script name is unchanged
because six callers and a governance test refer to it by name.

Two `onLoad` handlers do not chain — the first registered for a path wins and
the rest are never called, and returning nothing is a `TypeError` rather than
"leave this one alone". So macro expansion and instrumentation cannot be two
plugins side by side; they are two transforms behind one.

A plugin registered through `Bun.plugin` does not reach an in-process
`Bun.build`. `bundle-boots` and `bundle-exports` call it directly and are handed
the plugin explicitly; without it the bundle they build keeps the raw macro and
dies on mount with "outside the context of compilation", which is also the exact
text a missing transform produces anywhere else.

## Catalogs are not compiled

`@lingui/core` accepts uncompiled ICU strings once a compiler is registered, so
`lingui compile` and its generated artefact never exist. The alternative would
have put a codegen step in front of `build:web`, `bun test`, `preflight`,
`browse.ts` and three workflows, and a fresh checkout that forgot one fails from
inside a React component. The cost is `@messageformat/parser` in the bundle and
a parse per `i18n._()` call — not cached by Lingui, and deliberately not
memoised here until a render budget says otherwise.

The catalogs are JSON keyed by hashed id with the English `message` beside each
one. `minimal` style would have left a translator a file of `"PCSkw2": "技能"`.

## The cost, stated

A hashed id means a reworded sentence loses its translation. That is the trade
gettext makes and it is the right one — a changed sentence usually should be
re-read — but it means the README percentage can fall on a commit that only
touched English.

Two Chinese wordings can collapse into one English message. Eight did, and are
now written once; the ninth was 镜像 and 图 as "Image", which mislabelled a
dropped screenshot as a container image and needed a `context` to stay two
messages. Nothing catches this automatically — the collapse was found by reading
the pairs, with a throwaway script that was not kept.

## Reopen

If the suite's CPU regresses past +15% on a machine where `main` is stable, or
if `build:web` passes 2s. The exit is Lingui without macros — `<Trans id="…">`
and `i18n._()` need no transform at all — which costs hand-written ids and is
the same rollback the dependency record names.
