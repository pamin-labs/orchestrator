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
in English however that knob was set. It is now the same ten catalogs the panel
has: `web/src/shared/messages.ts` declares each message once with an explicit
`ev.` id, `lingui extract` puts the id in all ten `.po` files, and
`scripts/i18n-messages.ts` folds the `ev.` ones into
`src/platform/text/messages.generated.ts` — a plain module, which is what the
server can import. 041 said Lingui could not reach the server; what it could not
reach was a `.po`, because `bun build --compile` takes no plugin. Running the
library needs no plugin, and a standalone binary renders `5 дел ждут вас`.

`MessageId` is a literal union off that generated file, so an id the server names
and the catalogs do not have fails `tsc`. That is the whole guard; there is no
parity test beside it.

### Three landings that stay server-rendered, and not for a language reason

- **Escalation `question` and `brief`.** They are matched as data:
  `escalate.ts` dedupes on `starts_with(question, prefix)`, `api/panel/group.ts`
  closes one with `like(question, "PR #%…%")`, and `delta.ts` splices `question`
  verbatim into an agent's prompt. A key would break all three against rows
  already stored.
- **Note bodies.** `note.lang` records which language a note was written in,
  because retrieval has to reach it and an agent reads it back.

These are **load-bearing data**, not text somebody happens to read. That is why
they are exempt, and the exemption survives any future move of the line above.

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
