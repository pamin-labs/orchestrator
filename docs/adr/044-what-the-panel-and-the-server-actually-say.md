# 044 What the panel and the server actually say

**Status**: accepted. Supersedes [`041`](041-the-panel-speaks-english-and-a-compiler-hashes-it.md).
**Date**: 2026-08-23

041 decided the shape and got the wall wrong. Its central claim — that
`bun build` has no `--plugin`, so the server could not use Lingui macros — is
true of the CLI and false of `Bun.build({ compile, plugins })`, which takes both
and cross-compiles. 041 records the correction in a section of its own, and the
rest of the file was written before it. Five passages now describe a design that
was replaced while the branch was still open, and a reader who trusts them gets
the wrong number for the one thing anybody asks about.

This ADR is what is built. 041 stays for its argument — it is the record of why
a hand-written key layer looked necessary, and of the measurement that removed
it — and stops being the description.

## What 041 says that is no longer true

| 041 | here |
|---|---|
| `:95` "English … still loads no catalogue" | all ten load, English among them. 041 retracts this itself at `:145`; the earlier sentence stayed |
| `:116` "The README's table counts both surfaces" | one surface. `scripts/i18n-progress.ts` says so in its own comment, and both READMEs show one table |
| `:126` "only the 51 files under `web/src`" | 88 files hold a `@lingui/` import, 52 of them under `web/src`. `OURS` matches `src` and `web/src`, because the server writes `msg` too |
| `:129` "`loader.ts` refuses to register the plugin … decided from `Bun.main`" | registered for every test process. `bunfig.toml` records the removal; the ADR did not |
| `:140`, `:235` `web/dist/main.js` 1,778,092 B (+4.7%) | 1,470,287 B (−13.4%). See below |
| `:213` "The ICU parser is gone from the browser" | it was put back by `setMessagesCompiler`, and is gone again |

## The bundle got smaller, and almost none of that is i18n

041's `+4.7%` was measured before two findings that have nothing to do with
translation.

| | bytes | |
|---|---|---|
| `main`, before any of this | 1,697,982 | |
| 041's measurement | 1,778,092 | +4.7% |
| after the `NODE_ENV` fix | 1,491,931 | React's production runtime |
| after dropping `setMessagesCompiler` | 1,470,287 | −13.4% against `main` |

Bun inlines `process.env.NODE_ENV` as `"development"` unless told otherwise —
measured, both the CLI and the API — so the panel had been shipping React's
development build the whole time, and Lingui's dev-only ICU compiler with it.
`scripts/build-web.ts` sets it explicitly.

`setMessagesCompiler` was then re-added by hand, which is what made 041's "the
ICU parser is gone" false. Its stated purpose was the fallback path: with no
catalogue loaded, every id falls back to the `message` the macro left beside it,
which is ICU source. That path had one caller — `i18n.activate("en")` in
`applyLocale`'s `catch`. Loading `en.po` there takes the same door every other
locale takes and the rows arrive compiled, so the parser has no caller at all:
19,903 bytes of `@messageformat/parser` compiling nothing on every normal load.

## Ten locales, one list, and CLDR for the rest

`src/contracts/config.ts` holds one line — which `.po` files exist. It was a
table of three columns: the code, the name each language calls itself, and a
regular expression for every spelling somebody might type into
`output.language`.

The other two columns are CLDR's, and the runtime ships CLDR.

- **Which catalogue a tag asks for** is `Intl.Locale.prototype.maximize()`,
  which *is* `likelySubtags` — the thing the hand-written table's comment cited
  while implementing it by hand. `zh-Hans-MO`, `cmn-Hant` and `yue` are right
  without a row, and the ordering that made Traditional-before-Simplified
  load-bearing is gone.
- **Which catalogue free text asks for** is scored against the hundred names
  `Intl.DisplayNames` gives for these ten languages *in* these ten languages,
  longest match winning, with a two-character prefix allowed because CLDR spells
  it `繁體中文` where a person stops at `繁體`. The regexes it replaced knew
  English and the endonym: there was no Japanese word for German and no Russian
  word for Spanish, so `ドイツ語` in the knob got English.
- **What a language calls itself** is the diagonal of the same table. `zh` is
  named through `zh-Hans`, because "Chinese" is not an answer in a menu that
  also offers 繁體中文. `français` stays lower case: that is how French writes a
  language name, and title-casing it is editing CLDR.

The same rule took five `msg` descriptors and fifty translated rows out of the
settings page: `Intl.NumberFormat({ style: "unit" })` already prints `20分钟`,
`20 Min.` and `20 мин`, and gets the spacing right where `${n} ${label}` did
not. `Intl.RelativeTimeFormat` took two more, and gets the word order right in
the three languages where an interpolated suffix cannot — `il y a 20 min`.

**The rule this leaves behind**: before writing a table of language facts, check
whether `Intl` already answers it. What is ours is which catalogues exist and
what our own sentences say. Everything about how a language spells a thing is
CLDR's, and a copy of it is a copy that can drift.

## Storage is not always there

`applyLocale` read `localStorage` outside its own `try`, on the strength of a
comment saying `@lingui/detect-locale` owned that. It does not:
`detectFromStorage` is a bare `globalThis.localStorage.getItem(key)`. Chrome's
"block all cookies" and Firefox's `dom.storage.enabled=false` make the *getter*
throw, and `startLocale()` is awaited before `createRoot().render()` — so the
panel was a blank page, which is the same failure the `catch` above it was added
to fix for a 404'd chunk.

The dependency is gone with it: `localeOf` already answers for a stored `Locale`
and a raw `navigator.language` alike, and accepts the legacy values a `z.enum`
would have thrown away.

## Reopen

041's conditions still stand: if the suite's CPU regresses past +15% on a
machine where `main` is stable, or if `build:web` passes 2s, the exit is Lingui
without macros. Add one: if a locale ships whose script CLDR names in a way the
prefix rule mis-scores — the two-character prefix is the one heuristic left in
`localeOf`, and `test/web/locale.test.tsx` is where a counter-example goes.
