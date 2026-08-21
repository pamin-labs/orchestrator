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

Panel text was in this list and is not any more:
[`041`](041-the-panel-speaks-english-and-a-compiler-hashes-it.md) moved it to the
browser's own language. Reading a pane is not writing a thing, and this knob sits
in the cache prefix — following it would have rotated every session in the fleet
to change what one person reads.

This section said "`say()` event bodies and note bodies" follow `output.language`,
and after 041 that was half wrong in a way nobody could see from either file: 041
says a `SayKey` and its arguments "should not be rendered on the server at all",
which is the opposite instruction for the same strings. **041 wins for event
bodies.** The line is not the kind of text, it is the reader:

> Does anything but a browser read this string?

**No — the panel's own locale, and the server sends a key.** A `bus.emit` body is
read by the timeline and by nothing else. Rendering it at the emit site pins it to
one install-wide setting, and `isChinese()` is a language *pair*, so a Korean boss
gets English however that knob is set. The catalogs have nine; the panel picks
one per browser.

**Yes — `output.language`, rendered on the server, as before.** Three sinks, and
each has something other than a browser at the far end:

- **Escalation `question` and `brief`.** `delta.ts` splices `question` verbatim
  into an agent's prompt. It is also matched as data: `escalate.ts` dedupes on
  `starts_with(question, prefix)` and `api/panel/group.ts` closes a question with
  `like(question, "PR #%…%")`. A key would break both against rows already stored.
- **Note bodies.** `note.lang` exists to record which language a note was written
  in, because retrieval has to reach it and an agent reads it back.
- **The notification webhook.** `notify.ts` posts the body to somebody else's
  server. Desktop notifications are *not* in this list: there is no Web Push here,
  the frame goes over the same bus and the browser raises it.

The migration is additive, not a rewrite: `event.meta_json` already exists, so a
key and its arguments ride beside the rendered body, the panel prefers the key and
falls back to `body`, and `state_change` is trimmed at seven days anyway. The
server keeps rendering `body` regardless — it is `NOT NULL`, and the webhook reads
it.

None of that has happened yet. What exists today is the half it depends on: every
message the watchdog writes is a `SayKey` with **named** arguments, because
`{hours}` is a name a catalog can carry and `{h}` is not.

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
