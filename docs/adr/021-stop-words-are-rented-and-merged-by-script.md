# 021 Stop words are rented, and merged by script

**Status**: accepted
**Date**: 2026-08-18

ADR 020 rented the tokenizer and left the stop list hand-written: 67 English
words, in a corpus where `docs/journal/` is entirely Chinese. Measured against
this repository's own `docs/` (83 documents, 253,514 characters):

| term | documents | top-1 BM25 |
|---|---|---|
| `的` | 22 | **3.77** |
| `sandbox` | 20 | 3.13 |
| `the` | 53 | 1.36 |
| `opensandbox` | 8 | **0.63** |

The highest-weighted term in the index was a Chinese particle, and one hit on
`the` outscored one hit on `opensandbox` by two to one.

**BM25's IDF does not make a stop list redundant**, which was the tempting
conclusion. Adding a single `the` to `sandbox` moved the top result from
`001-agent-transport-and-sandbox` to `004-codex-as-a-provider`; `what is the`
pulled in two documents that match nothing else. Orama's length normalisation
(`b = 0.75`) hands short documents a high score on common words and IDF does not
claw it back.

**A corpus-driven list does not work either**, and this is worth writing down so
nobody re-derives it: filtering by document frequency at `df > 0.4` dropped 36
words out of 5,613 and kept `how`, `should`, `we` and `what`; `的` sits at 26%.
Stop words are a property of a language, not of a few hundred notes.

`stopword` 3.1.5 (2025-06-13, MIT) has 64 lists including `zho`, `jpn`, `kor` and
`tha`. **Merging all of them is wrong**: the combined list is 12,819 words and
kills `net` and `hit` — `src/mech/sandbox/net.ts` and `ctx.ts`'s `Hit` — along
with `die`, `man`, `war` and `end`. Collisions happen between Latin-script
languages, and only there. So the merge is English plus every non-Latin list:
4,546 words, and **zero of 75 sampled engineering terms lost**.

`@orama/stopwords` was the same-owner candidate and covers 30 languages without
Korean or Thai.

**Consequence**: Korean and Thai are segmented but unfiltered — the honest limit
of merging without a language signal. `use`, `get`, `set`, `make` and `need`
return to the index, which is right in a corpus about code; the hand-written list
had dropped them.

**Reopen when**: Korean or Thai retrieval quality is worth carrying a per-document
language field for.
