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

## 3. Derived data a person reads

This section has been rewritten twice, and the reason is worth keeping: both
earlier drafts drew the line in the wrong place.

The first said "`say()` event bodies and note bodies" follow `output.language`.
[`041`](041-the-panel-speaks-english-and-a-compiler-hashes-it.md) then said a
message id and its arguments "should not be rendered on the server at all",
which is the opposite instruction for the same strings.

The second tried to settle it with **"does anything but a browser read this
string?"** — no meant a key and the panel's locale, yes meant `output.language`
on the server. That put the notification webhook in the second bucket by
accident of plumbing, not by intent: a webhook is a person reading a sentence,
and it got one of two languages because `isChinese()` is a language *pair*.

The line is neither the kind of text nor the transport. It is **who reads it and
where**:

| Text | Follows | Rendered by |
|---|---|---|
| Shown on the panel — host checks, events, validation errors | the site language | the panel |
| Leaves this machine for a person — the webhook, the paragraphs of a prompt a person reads | the output language | the server, in ten languages |
| Code, commits, branches, protocol keys, logs, `/readyz` | English | nobody; it is not translated |

Row two is new work rather than a relabelling. `say()` was two hand-kept tables
behind `isChinese()`, so a boss whose `output.language` was `한국어` read the feed
in English however that knob was set. The server writes the same `msg` templates
the panel does now — `say: msg\`merged into main\`` — and `lingui extract` puts
every one of them in all ten `.po` files, which
[`044`](044-what-the-panel-and-the-server-actually-say.md) has the measurement
for: `bun build --compile` the CLI takes no plugin, `Bun.build` the API does,
and a standalone binary built through it renders all ten.

There is no id to keep in step and so nothing to guard: the macro computes the
id from the English at build time, and the English travels beside it on the wire
as the descriptor's `message`. A panel that has never heard of a sentence renders
that.

### What stays server-rendered, and not for a language reason

- **Note bodies.** `note.lang` records which language a note was written in,
  because retrieval has to reach it and an agent reads it back.
- **A question an agent wrote.** `api/orch/escalation.ts` files the agent's own
  words. That is category 1 above and is never rewritten, so it has no
  descriptor and the panel draws the stored text.

### Escalation `question` and `brief` were exempt, and the exemption was the bug

An earlier version of this section listed them beside note bodies: they were
matched as data, so a key "would break all three against rows already stored".

That was a description of the defect rather than a reason. Six predicates in
five files compared the *prose* of a question — `starts_with(question, "PR #12
被关掉了")`, `like(question, "budget:%")`, `substr(question, 1, length(...))` —
which makes a sentence a primary key. Rewording one silently stops a matcher and
nothing fails: `escalate.ts` files a second copy of a question it should have
deduped, `credentialChanged` leaves an answered question sitting on the boss's
queue forever, `prReopened` never reopens. It had already happened once in this
PR's own history, to `沙箱是新的`. It is also why three of those sentences could
not be translated at all, which is the rule this ADR exists to state.

`escalation.dedupe_key` is that key now — a literal union in `escalate.ts`, one
`=` per matcher, and no pattern to escape. `question` and `brief` are ordinary
sentences again, so they take the same shape `event` does: rendered in the output
language into the column that prompts splice, with the descriptor beside them in
`question_said` / `brief_said`, and the panel prefers the descriptor. Rows stored
before the column keep their prose and the panel falls back to it;
`20260822013502_escalation_matches_a_key_not_prose` backfills their keys from the
four literals, which is the last moment that mapping is known.

`test/mech/escalate.test.ts` states the rule over the whole tree rather than over
the six predicates that were fixed: no SQL compares `escalation.question` or
`escalation.brief`. It was shown failing against each of them.

The migration was additive: `event.meta_json` already existed, so an id and its
values ride beside the rendered body, the panel prefers the id and falls back to
`body`, and `state_change` is trimmed at seven days anyway. The server keeps
rendering `body` regardless — it is `NOT NULL`, `scrub` works on it, and the
webhook reads it — but in the output language, now that there are ten of them.

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
