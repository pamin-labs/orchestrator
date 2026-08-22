# 045 A question names what it is about, once

**Status**: accepted
**Date**: 2026-08-23

## Context

`orch ask-boss` carried two classification enums.

`--kind` — `env|spec|boundary|design|other` — chose a queue heading, and fell
back to `other` on the rule that an agent must never be stuck on a taxonomy.

`--reserved` — `budget|merge|credential|deploy|scope` — chose whether the PM may
answer. It was optional, and when it was absent the routing fell through to
`RESERVED` in `src/mech/flow/chain.ts`: ten rows of per-language keyword regex,
about sixty lines, tuned per script. Its own comment recorded the measurement —
two probes per language, "raise the budget?" and "merge into main?", and sixteen
of eighteen leaked before the other eight language rows existed. English
`budget increase` was never the word order anyone uses, and Chinese has no word
for merge that the pattern held.

Two axes for one fact. And the second one, made required, needs a value meaning
"not one of these" — a reason that is not a reason.

## Decision

One required enum, nine values, no `other` and no `none`.

```
budget | merge | credential | deploy | scope   → the boss
env | spec | boundary | design                 → the PM
```

`TO_BOSS` is the first half. One word decides the queue heading and the routing,
and the routing is set membership. The values are ASCII protocol keys — the same
word whatever `output.language` says — which is one of
[`035`](035-language-follows-who-wrote-it.md)'s three exemptions from the
panel's own language, and the whole reason a word beats a pattern here.

The vocabulary is **ordered**, and the order is the rule: a question can be about
two of these — "swap Postgres for SQLite to cut hosting cost" is `design` and
`budget` — so the asker takes the one that raises highest, and the five that
raise are first. That rule is in `src/prompt/assemble.ts`, where an agent reads
it, and in `RESERVED_TOPICS`' comment, where the next person to add a value
does.

### What the merge costs, and what pays it back

The old flag could only ever *raise*: declaring sent a question up, and saying
nothing left it to the patterns. `--kind env` is a declaration that routes a
question **down**, and the agent that saves itself a round trip by misfiling is
the same agent that files.

So the gate has a second half, at the answering end rather than the asking end —
which is also the moment the damage would happen. Before a stand-in may answer,
`answerError`:

1. reads the stored `kind` as a key. Not the question's prose: that is the move
   `dedupe_key` and `question_said` already made one column over, and it means
   the wording is free to change.
2. where that is not one of the five, shows the question to the cheap model
   `getAnswerDraft` already uses and asks one yes/no.

A model reads all ten languages. A keyword list guesses at them.

**This is not "a gate a model can talk its way out of."** The reader is not the
PM, is not in the conversation, and is shown the question rather than an
argument about the question. What the earlier comment refused was letting the
*answerer* decide whether it may answer; this asks a third party.

### Three edges, deliberately not the same edge

| | |
|---|---|
| `ctx.askIn` not wired | **abstain.** `indexModel.model` empty turns the cheap tier off; that is a deployment the boss chose, not a check that failed. Failing closed would leave a stand-in unable to answer anything at all |
| the call throws, times out, or answers something that is not yes or no | **raise.** A check that did not run is not a check that passed, and this is what keeps "no path routes a question away from the boss" |
| yes | **refuse**, and the PM abstains — byte-identical to what `isReserved` did on a hit |

## Consequences

No migration. `escalation.kind` is a nullable `text()` with no enum constraint,
so only the write path narrows. A row filed before the column has `kind` null,
falls past step 1, and reaches the second reader on its prose — which is why
nothing had to be backfilled and there is no window.

`--kind` is now a usage error to omit, in the CLI and as a 400 at the API. The
role files say so. `severity` still falls back, and should: it moves a queue
heading, not a decision.

The second reader has no deadline of its own and no cache — one call per answer
attempt, inside `modelAsk`'s 60s. Marked `ponytail:` at the call.

## Reopen

If answer attempts get frequent enough that one model call each is measurable,
cache the verdict per escalation id — the question does not change. If a
deployment runs with `indexModel.model` empty *and* wants the second half of the
gate, the reader has to become something other than `askIn`.
