# 041 The panel's copy is English in the source, and its ids are the compiler's

**Status**: superseded by [`044`](044-what-the-panel-and-the-server-actually-say.md)
**Date**: 2026-08-20

> Kept for the argument, not as a description. Its central claim — `bun build`
> has no `--plugin`, so the server cannot use a macro — is true of the CLI and
> false of the API, and the correction landed in the middle of this file rather
> than at the top of it. Six passages below describe the design that claim
> produced; 044 lists them and says what is built. The reasoning about hand-written
> keys, and the measurement that removed 2654 lines of them, is still this file's.

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

`src/platform/text/lang.ts` was **not** migrating — it has since, and both
reasons written here for keeping it out were wrong, in different ways.

The first said the release binary is `bun build --compile`, which takes no
plugin, so a macro would have to expand at runtime. That is true of the CLI and
false of the API, which is the distinction the next section is about.

## The correction: the flag, not the API

The paragraph above conflates two things, and this ADR's conclusion rested on
the confusion. **`bun build` the CLI** has no `--plugin` flag. **`Bun.build` the
API** takes `plugins` and `compile` together, and `scripts/build-web.ts` was
already using it for the panel. So the macro was never shut out of the server —
one missing flag was read as a missing capability, and a whole layer got built
to work around it.

Measured, not argued — the first version of this measurement compiled a binary
that rendered out of a generated module:

```
ru n=1  -> 1 срез        ru n=11 -> 11 срезов
ru n=2  -> 2 среза       ru n=21 -> 21 срез
ko      -> main에 병합했습니다
de      -> migriert und abfragbar     (check.database.ok)
```

| | without | with |
|---|---|---|
| binary | 63,446,114 B | 63,495,650 B (+49,536, 10 modules) |

Four Russian forms from one message is the part that matters. `one`/`few`/`many`
is a rule ICU has and we do not, and the alternative on offer was a third
hand-kept table.

That generated module is gone, and so is everything that existed to feed it.
`scripts/build-server.ts` builds the release binary through `Bun.build` with the
same two plugins as the panel, so `src/platform/text/lang.ts` imports the nine
`.po` files directly and the server writes `msg` exactly as `web/src` does.

Measured on the compiled binary, which is where this ADR was wrong before:

```
$ bun run scripts/build-server.ts src/probe.ts dist/probe bun-darwin-arm64
$ dist/probe
влито в main | 已合入 main | main にマージしました | merged into main
```

### What that deleted

Everything below existed only to carry English and an id across a boundary the
macro turned out to be able to cross:

| gone | why it existed |
|---|---|
| explicit ids — `msg({ id: "ev.group.merged", … })` | the server could not compute a hash |
| `web/src/shared/messages.ts`, `web/src/features/settings/checks.ts` | two descriptor tables, so the panel could look an id up |
| `said()` in `lang.ts` | the one typed door onto those ids |
| `scripts/i18n-messages.ts`, `src/platform/text/messages.generated.ts` | a catalogue for a runtime that could not import one |
| `test/governance/english-has-one-author.test.ts` | two copies of the English to keep in step |

An emitter writes `say: msg\`merged into main\``. The macro expands it to
`{ id, message }` at build time, the wire carries that object with its values,
and both sides call `i18n._` on it: the catalogue row when the reader's
catalogue has one, the `message` beside the id when it does not. English is the
second case for every sentence, which is why it still loads no catalogue —
[`035`](035-language-follows-who-wrote-it.md) §3 is why the server renders at
all.

The catalogues moved from `web/src/locales/` to `locales/`, because `web/**` is
a Fallow zone the server may not import from.

## What the second reason got wrong

It was that the server has no reader who needs a ninth language. Wrong about one
reader: the notification webhook is a person, and it leaves this machine. `035`
§3 now sorts by who reads a string and where, and the server renders its half in
ten languages rather than in the two `isChinese()` could tell apart — which is a
language *pair*, so `output.language: 한국어` got English however it was set.

What stays true is the rest of the division: diagnostics only a developer reads
stay English, and feedback that lands in an agent's prompt stays English on
purpose, because translating it only makes the model translate it back. Text a
person reads on the panel is an id and its values, rendered by the browser out of
the catalog its reader chose.

The README's table counts both surfaces, which is how a reader can see they are
two mechanisms rather than one that is half-done.

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
one language it reads. An earlier revision of this table said 1.86 MB, which was
this number before the split.

### English fetched none, and now fetches one

That was true and is deliberately no longer true. `en` was excluded from
`CATALOGS` and an empty catalogue loaded in its place, because the source locale
renders from the `message` the macro already put in the bundle — measured
identical, plural and selectordinal included. So the chunk bought nothing except
a saved fetch, and cost three special cases: the `Exclude<Locale, "en">`, the
`i18n.load("en", {})`, and a branch in `saidText` for "no catalogue row and no
message".

The boss's rule is that every language takes one path and bundle size is not a
constraint; Lingui's own SSR example loads the source locale like any other. So
English now fetches its ~90KB chunk like everybody else, and `saidText` is two
lines. The price is named here rather than left for somebody to rediscover.

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

## Catalogs are `.po`, compiled by a plugin

`scripts/lingui-catalogs.ts` turns each `.po` into an ES module exporting
`messages`, through the four public calls from `@lingui/cli/api` that
`@lingui/vite-plugin` makes in the same order: `getCatalogs`,
`getCatalogForFile`, `catalog.getTranslations`, `createCompiledCatalog`. Lingui
ships that plugin for Vite, a loader for webpack and a transformer for Metro;
there is none for Bun, and writing the Bun one is a smaller departure than not
compiling at all — which is what this project did first, and what Lingui's docs
are firm against: *"you need to always compile your catalogs, even if they are in
JSON format"*, and the runtime compiler *"is typically excluded"* from production
builds.

Two things fall out of compiling at build time. The ICU parser is gone from the
browser, and a message that will not parse now fails `build:web` instead of
throwing inside a React render — `createCompiledCatalog` returns its errors and
this plugin raises them.

`.po` and not JSON, because the file is a translator's. `msgid "Skills"` sits
above `msgstr "Fähigkeiten"`, and any PO editor opens it. The JSON was keyed by
the hash, so the same pair read `"PCSkw2": "技能"` with the English it translates
in a sibling field.

Measured, against the same tree with JSON catalogs and a runtime compiler:

| | JSON, compiled at runtime | `.po`, compiled at build |
|---|---|---|
| catalog chunks | 1,089,738 B | 416,704 B (−62%) |
| `web/dist/main.js` | 1,778,092 B | 1,778,509 B |

The chunk a reader actually downloads went from ~136 KB to ~52 KB, because a
compiled catalog is an array per message rather than an ICU string to be parsed.
`main.js` is flat: the ICU parser left and `@lingui/detect-locale` arrived.

One departure is left, and it is the same shape: the macro is expanded by a Bun
plugin of ours because Lingui's setup guides cover Vite, React, RSC, React Native
and plain JavaScript, and none of them is Bun. The package is the recommended
`@lingui/babel-plugin-lingui-macro`, and even Vite's official route expands
macros with a Babel pass — so what differs is the host, not the method.

Locale detection is `@lingui/detect-locale`, which owns reading storage without
throwing and falling through to the navigator. What it returns is a raw string,
so `localeOf` still decides which catalog can serve it: the stored value is one
of nine, `navigator.language` is whatever the browser says, and `output.language`
is free text a person typed.

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
