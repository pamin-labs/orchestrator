# 020 Retrieval is Orama, segmented by ICU

**Status**: accepted
**Date**: 2026-08-18

`orch ctx query` is the one thing that stops an agent grepping, and grepping is
expensive in a way that compounds: every round re-reads the whole transcript, and
turns above sixty rounds ate 59% of the measured cache-read bill. So the quality
of this one command is a cost control, not a nicety.

It was doing two things badly.

**It could not read most of the world.** `terms` matched Latin with one regex and
split Han, Hiragana and Katakana per character with another. Measured across eight
scripts, Korean, Russian, Thai, Arabic and Greek each produced **zero** terms —
those notes were invisible to retrieval, silently, because an empty term list is
indistinguishable from a document about nothing. `Intl.Segmenter` is ICU's word
breaker, already in the runtime, and all eight now produce words. Chinese improves
on its own terms too: 中文问候 is two words rather than four of the commonest
characters in the language.

`@node-rs/jieba` (2.0.2, active) was the strongest library alternative and was
measured rather than assumed: it ties with ICU on Chinese and splits Korean and
Russian into single characters, because it is a Chinese dictionary segmenter.
`segmentit`, `tiny-segmenter`, `kuromoji` and `intl-segmenter-polyfill` all fail
the maintenance rule; `wink-nlp` and `natural` are English-first. The library here
is ICU and it is already present.

**It rescanned the corpus on every question.** Four hundred note bodies pulled
into JavaScript, re-tokenised — 696,000 characters measured — and scored by a
hand-written BM25 at 33.4ms a query, in a file whose header says it must answer in
milliseconds. The `LIMIT 400` was never a product decision; it was that cost's
ceiling, and it meant nothing older than four hundred notes could be found at all.
Orama: 0.32ms at four hundred documents, 1.4ms at two thousand. Sixty-one lines of
scoring deleted.

**Why not SQLite FTS5**, which is otherwise the cleaner fit — its index lives
inside the database, needs no state in our code and stays consistent inside the
transaction. It loses on one property: it is SQLite's. Orama's index does not live
in the database, so replacing the database does not replace the search. That trade
was made deliberately and its price is real: a derived index needs an owner and a
freshness rule, and both are here rather than absent.

Orama also does vectors and hybrid ranking natively, so letting a user bring an
embedding model and a reranker later is a field on this schema and a mode passed
to `search` — not a second retrieval system beside this one.

**Consequence**: the index is created by the composition layer and handed over on
`Ctx`, never reached for from a module — building costs 315ms at four hundred
notes and grows, so it cannot be rebuilt per query. Freshness is a three-number
stamp over the note table: a growing id means an incremental insert, anything else
moving means a row was rewritten and the index is rebuilt. Both cases are asserted,
because "found what was written after the server started" and "re-read a note that
changed" are the two ways a derived index lies quietly.

`KIND_WEIGHT` and the recency nudge stay ours, multiplied over the library's
relevance rather than folded into it: no search library knows that a recorded
decision is worth more to recall than a journal entry.

**Reopen when**: the corpus outgrows an in-memory index, or a user asks for
retrieval across projects rather than within one.
