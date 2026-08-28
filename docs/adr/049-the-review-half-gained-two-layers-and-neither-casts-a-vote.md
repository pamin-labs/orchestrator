# 049 The review half gained two layers, and neither casts a vote

**Status**: accepted. Applies [`034`](034-symbols-are-parsed-not-matched.md) to a second consumer.
**Date**: 2026-08-29

## Context

The deterministic half of review — `self → reconcile → gate → QA → boss` — had
one shape of blindness in it. `runGates` believes any suite that exits 0.
`reconcile` compares file paths, not assertions. QA reads the same diff the same
model wrote. **Weakening a test is the cheapest way to make a slice green, and no
layer could see it.** Separately, this repository enforces its own module
boundaries with invariants 1–6 and `fallow`; a project driven by orchestrator had
nothing equivalent.

## Decision: two layers after the gate, both recording rather than refusing

**`discriminate`** (`src/mech/flow/discriminate.ts`) reverts the slice's source
files, runs the project's own `test` gate, and restores. A **non-zero exit is the
healthy answer** — including a compile error, since a test that cannot compile
without the new symbol is a test that discriminates. Exit 0 means these tests
distinguish nothing, recorded as `blind`. Per-file localisation runs only on the
pass path: when the whole revert is green, every subset revert is green too, and
there is no information in it.

**`boundaries`** (`src/mech/flow/boundaries.ts`) parses the changed files with the
tree-sitter grammars `symbols.ts` already loads and asks whether this slice
introduces a dependency **the repository has never had** — a ratchet against its
own history, the same shape as the Chinese-literal ratchet already trusted here.

The plan proposed authored rules (`boundaries: [{from, deny, why}]`) checked by a
substring scan over import-shaped lines. Both halves were wrong. A regex beside a
working parser is the defect ADR 034 closed, one directory over. And authored
rules need somebody to write them, a channel to propose them and a tier to
approve them — a feature nobody configures is a feature that never fires, which
is not a hypothetical: see below.

## Why evidence and not a verdict

Both layers can be wrong in ways only a person sees. A test suite can be honestly
green under a revert (a pure refactor); a new edge can be exactly the right edge.
A gate that misfires is a gate somebody turns off, and then the true positives go
with it. So both write to `gates_json`, say a sentence on the timeline, reach the
PR body through `prwatch`, and the QA turn is asked about a `blind` — and neither
returns `pass: false`.

## The layer that shipped inert, which is the reason this section exists

`discriminate` was merged and did nothing. It requires a clean worktree before it
will touch anything — reverting uncommitted work is losing work — and the
worktree is dirty at gate time, because `takeCheckpoint` commits at the *start*
of a turn. Both e2e fixtures happened to commit first, so two green tests proved
exactly nothing. The fix is a `checkpoint` immediately before the check; the
probe that found it became the test.

This is the whole argument against the authored-rule design in one artefact: a
layer that is present, configured, tested, and silent.

## Why not real mutation testing

Bailador's pipeline mutates. One mutation engine per language, each running the
suite through a language-specific harness, in **other people's repositories** —
that is a dependency matrix, not a feature. `lizard` was rentable across
twenty-two languages precisely because it only reads.

**Revisit when** a driven project already has a mutation runner configured. Then
it is a command the repository declared, which makes it an ordinary gate under
[`048`](048-a-project-states-its-own-gates-so-there-is-nothing-to-approve.md) and
costs us nothing.

## Consequence

A passing slice runs its test suite one extra time. `discriminate: false` in
project config turns it off, beside `gateRetries`, and it was shown failing with
that key set before it was kept. Spans: `gate.discriminate`.
