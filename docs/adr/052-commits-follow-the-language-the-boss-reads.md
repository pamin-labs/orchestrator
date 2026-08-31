# 052 Commits follow the language the boss reads

**Status**: accepted. Narrows [`035`](035-language-follows-who-wrote-it.md) row
three and retires the `NOT_ENGLISH` half of
[`046`](046-a-validator-cannot-read-ten-languages.md).
**Date**: 2026-08-30

## Context

035's table put "code, commits, branches, protocol keys, logs" in one row —
English, never translated — and `roles/scribe.yaml` said why: *"Commits, pull
requests and branch names are read by people who did not ask for this work."*

That is true of a branch name and of code. It is not true of a commit body in a
one-person company, which is the product this is. The boss reads `git log`. They
read the pull request. On an installation set to Chinese they read a panel, a
webhook, a journal and a question queue in Chinese, and then one artefact —
the record of what actually shipped — in English, written by a model that had
just been told twice to write Chinese.

The four places that stated the rule did not agree on much else. `assemble.ts`
injected it into every stable prefix, `roles/scribe.yaml` stated it as
**English, always**, `delta.ts` repeated it per turn, and `prwatch.ts` enforced
it. A prompt that permits what the validator rejects teaches a model to write
something that gets thrown away at the end of the only turn it gets, and the
inverse teaches nothing at all.

## Decision

The commit subject and body, and the pull request title and body, follow
`outputLanguage(cfg)` — the same value the journal, the webhook and the
questions already follow.

**No new setting.** A second knob whose only sensible value is "the same as the
first one" is a knob two people can set into disagreement, and the reason 043
gave for resolving three values into one applies unchanged.

What stays English is what is not prose: code, error strings, branch names, and
a commit's `type(scope):` prefix. The prefix is not a stylistic choice —
`SUBJECT` matches `[a-z0-9._/-]` and a scope is a module identifier.

`## Output language` in `assemble.ts` is the **only** owner. `roles/scribe.yaml`
is static YAML and cannot interpolate a setting, so a language named there is
right until the boss changes the knob and wrong afterwards — which is what had
happened. `one-owner-for-the-language.test.ts` is the guard, shown failing
against the line it removed.

## `NOT_ENGLISH` is replaced by a detector, not by a bigger table

046 replaced three hand-picked script ranges with
`/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u`, which was right
for the rule it enforced. It cannot express this one. A script test passes an
English commit on a Chinese installation, and that is the drift that actually
happens: the model's own prefix says to write Chinese and the validator has no
opinion.

The first draft of this change was a `Locale → Unicode script` table. It was
wrong in the same way 045 and 046 were about keyword lists — it only ever
catches "written in a third language", never "written in the wrong one of two" —
and it is a thing a maintained library does better. `CLAUDE.md`: own product
logic, rent everything else.

**`eld` 2.1.0** (Nito-ELD), Apache-2.0, zero dependencies, released seventeen
days before this. It was the only candidate with a release inside a year:
`franc` and `tinyld` stopped in January 2024, `cld3-asm` in December 2023,
`languagedetect` in 2022. Its own benchmark puts it at 99.3–99.7% on ≤140
characters against franc's 89.8%, which is the size of text this asks about.

Measured here, on nine real commits — a subject plus a three-to-five line body,
one per shipped locale:

| detected on | extrasmall | medium | large |
|---|---|---|---|
| the subject alone | 8/9 | 8/9 | 9/9 |
| subject and body | **9/9** | 9/9 | 9/9 |

The miss is `der skills-Mount war unter macOS leer`, called English by both
smaller databases — with `isReliable()` still true, so confidence would not have
saved it. So the whole message is what gets detected, never the title, and
`extrasmall` is enough. `setLanguageSubset` narrows the candidates from sixty to
the ten that ship.

### It fails lenient, and that is the important half

```
refuse ⟺ detect(subject + body).isReliable() ∧ language ≠ the configured one
```

An unreliable reading publishes. 046's own finding was that `GENERIC_GATE`
failed in the refusing direction and cost correct cards; this refuses a turn the
Scribe gets once. Measured: a Chinese commit whose body is mostly paths and
identifiers detects as English, and `isReliable()` returns false, so it is
published. That case is the reason the rule is written around confidence rather
than around equality.

## Two things the test found on its way in

**The full-stop rule was ASCII.** `t.endsWith(".")` is the whole of "no full
stop at the end", and a Chinese or Japanese subject ends `。`. The rule stopped
applying to the languages it had just been opened to. It is `/[.。．]$/` now.

**The pull request body's headings were English literals.** `## Asked for`,
`## Slices (N, all accepted)`, `## Decisions`, `## Retro` and the footer sat
above and below prose in the boss's language. They are `msg` descriptors
rendered with `renderSaid`, like everything else the server says — eleven new
ids across ten catalogues.

## Consequences

An installation that has said nothing still writes English: `outputLanguage`
ends in `?? "en"`. One that is set to Chinese now gets a Chinese `git log`, and
its pull requests read as one document rather than two.

`## Output language` is in the hashed half of the prefix, so the first turn
after this upgrade rotates every live session once. The settings page has warned
that the language knob does this since it existed.

**+963 kB in the compiled server**, measured rather than read off the package:
`bun build` of `src/composition/server.ts` is 3,361,611 bytes on `main` and
4,347,339 bytes here, so 2.6% of the 160 MB release-archive budget. The four
databases `eld` ships are 932 kB to 4.3 MB on disk and only the one imported is
bundled. Nothing reaches the browser: `web/dist` is byte-identical and contains
none of the package's API, because the validator is server-side.

`zh` and `zh-Hant` are one language to the detector, because ISO 639-1 has one
Chinese. A Traditional commit passes a Simplified installation and the reverse.
That is the right answer to the question being asked — *did the Scribe write in
the language the boss reads* — rather than a limitation worked around.

## Reopen

If a correct message is refused in the field, the evidence is the message plus
`detect().getScores()`. The cheap first move is `eld/medium`; the honest one is
that this check has never had a second reader, and 046's `testOnly` is the
precedent for deleting a rule rather than growing it.
