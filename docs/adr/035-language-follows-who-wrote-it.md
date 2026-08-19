# 035 What language something is in follows who wrote it

**Status**: accepted
**Date**: 2026-08-19
**Follows**: `src/platform/text/lang.ts`, and `CLAUDE.md`'s half of the rule —
English for code, comments, errors, branches, commits and pull requests.

Three categories, and the boundary between them is authorship rather than audience.

## 1. Text a person wrote is never rewritten

The boss's requirement, a slice's `accept_spec`, a complaint, a project's own spec
document. These reach a prompt verbatim — `ctx.ts` puts `accept_spec` into one — and
translating them loses intent for the sake of consistency nobody asked for.

An earlier draft of this rule put "prompt assembly" wholesale into the forced-English
category. That was wrong in exactly this way: a prompt carries the boss's own words.

## 2. Derived data only a machine reads is English

PageIndex summaries, repo map symbols, error codes, logs, feedback sent to an agent.

**The reason is correctness, not retrieval convenience.** `sigOf` in `pageindex.ts`
hashes the file's content and nothing else, so a summary is rebuilt only when the file
changes. That makes the summary's *language* something no mechanism can correct: let
it drift — a model version, a file that happens to be written in Chinese, an
`output.language` somebody changed — and the index holds summaries in two languages
whose signatures will never invalidate. Forcing English makes a summary a pure
function of its input again, which is what the incremental contract claims it is.

`test/mech/pageindex.test.ts` asserts every prompt asks for English, against a file
written in Chinese. It was shown failing: the prompts said only "One line, under 20
words".

Feedback to an agent is the same category for a different reason, recorded in
`lang.ts`: it lands in a prompt beside code and gate output, and translating it would
only make the model translate it back.

## 3. Derived data a person reads follows `output.language`

`say()` event bodies, note bodies, panel text.

## The cost, stated

Retrieval is now cross-lingual by construction: a Chinese question has to reach an
English summary of a file. BM25 cannot do that, which
[031](031-embeddings-do-not-fit-in-this-binary.md) measured and refused an embedding
for — so this is a stated gap rather than a solved problem, and it is the price of
category 2 being a pure function.

Note *bodies* stay in the language they were written in, which is what keeps a
Chinese question able to reach a Chinese note. The line falls between a note's body
and a note's summary.

## Reopen

A model that ranks the relevant other-language passage above an irrelevant
same-language one — ADR 031's condition, runnable as `bun run embedding:check`.
