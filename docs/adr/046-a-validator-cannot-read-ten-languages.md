# 046 A validator cannot read ten languages, and two of three did not have to

**Status**: accepted. Narrows [`045`](045-a-question-names-what-it-is-about-once.md).
**Date**: 2026-08-23

## Context

045 replaced `chain.ts`'s ten rows of per-language keyword regex with one
declared ASCII enum. `src/mech/util/validate.ts` was the last file in `src/`
holding the same shape, in three places:

| | what it decides | how it failed |
|---|---|---|
| `GENERIC_GATE` | whether a slice criterion is boilerplate | **over-rejects** — it suppresses a hard refusal, so a miss refuses a correct card |
| `testOnly` | whether a slice is tests on their own | under-enforces — the rule existed for 2 of 10 locales |
| `FILLER` | whether a journal is padded | refuses in 2 of 10 locales, **and is a second owner of a rule the line cap already holds** |

They are three different defects and they get three different answers. That is
the finding: "apply 045's remedy" is not a thing one does to a class.

## `GENERIC_GATE` was a live bug, not a gap

Read the call site:

```ts
if (short.length < 8 || !long.includes(short) || GENERIC_GATE.test(short)) return null;
```

The pattern is a **false-positive suppressor**. When it does *not* match, the
enclosing "nested acceptance criteria" refusal fires. So its blind spots do not
cost a missed catch — they cost a correct DRAFT refused, twice in the lifecycle,
because `postDraftDecision` re-validates the stored card on approval.

Measured, one card with the same shape written seven ways — two slices whose
acceptance restates a requirement-level criterion, which every card does:

| written in | before |
|---|---|
| English, Chinese | accepted — the pattern knew those words |
| German, French, Spanish, Portuguese, Russian | **refused as nested acceptance** |
| Korean, Japanese | accepted, because `테스트통과` normalises to five characters and falls under the eight-character floor |

The verdict depended on script density. And the pattern was wrong in the other
direction too: in English and Chinese it suppressed a *genuine* nested pair,
because it matched the criterion's words whatever the card said.

**The card already declares the list.** A slice criterion that merely restates a
requirement-level one is true of every slice by construction — which is the
property the pattern was reaching for — and `validateDraftCard` has parsed
`## accept` four lines above the call. So the generic-gate list is the card's own
`## accept`, in whatever language the card is written in. It is stronger than the
pattern in all ten, not merely equal: it catches project gates the pattern never
knew (`bazel test //...`, `make ci`, `pnpm verify`).

## `testOnly` is deleted, and the gap is recorded

The rule — a slice may not be tests alone — matched the slice **title**, which is
prose in `output.language`. It existed for two locales and never for the other
eight. All three replacements fail:

- **A declared column** (`kind: feature|test|docs`) is the writer certifying that
  their own work should not be rejected. 045 raises exactly this objection about
  a declaration that routes work *down*, and it could afford one only because it
  bought a second reader at the answering end. There is no second reader on this
  path that re-asks "is this tests-only". It is also the only breaking option:
  `tableSlices` reads three columns positionally, so a required fourth refuses
  every stored card on the approval path.
- **The slice's `accept`** does not discriminate. `draft-card.test.ts` has a test
  whose whole point is that a good slice may be accepted by "the suite passes".
- **A model reader** has no free failure direction here. 045's reader may fail
  closed because raising sends a question to the boss, which is always safe. Here
  the edges are *refuse a correct card* — an `xhigh` Dispatcher rewrite — or let
  it through, so it must fail open, so it is not a gate. It would also make
  `validateDraftCard` async for twenty callers and give `src/mech/util/` a
  dependency on `Ctx.askIn`.

The rule keeps three owners that already read ten languages: `roles/dispatcher.yaml`
states it with a worked example; the boss reads the card, which is 045's structure
faithfully mapped — a declaration at the asking end and a reader who is not the
asker at the acting end, and on the DRAFT path that reader is free, human and
already there; and `reconcile` catches the consequence deterministically as
`nothing was claimed and nothing changed`, which is what the measured failure
actually looked like.

One coupling disappears with it.
[`docs/project/archive/2026-08.md`](../project/archive/2026-08.md) records that
`dispatcher.yaml`'s
example slice had to be worded `add tests` rather than `add test cases`, because
the compiled pattern carried neither `more` nor `cases`. A prompt whose prose has
to be checked against a regex is a coupling nobody should have to remember.

## `FILLER` is deleted, because the line cap already owned it

Two rows of Chinese hedges and two of English ones, and — read the call site — it
returns `ok: false`. It **refuses a journal**, at 400. Not a nudge: a gate, in two
of the ten languages an agent writes in, so the same padded entry was accepted
from a German agent and refused from an English one.

The first draft of this ADR argued for keeping it, on the grounds that a miss is
free. That was wrong twice over. A miss is not free when the hit refuses, and
more importantly the rule already has an owner: `validateJournal` caps the body
at `JOURNAL_MAX_LINES` four lines above, which is "be terse" enforced by counting
rather than by recognising words, in every language. A lexicon beside it is a
second enforcement owner of one rule, which `CLAUDE.md` forbids outright.

So it goes the way `testOnly` went, for the same reason plus that one. The test
that pinned it is replaced by one asserting the cap refuses padding in English,
Chinese and German alike, and that a short entry is accepted in all three — which
the lexicon was refusing in two.

## The class, once you look for it outside `validate.ts`

Two more of the same shape turned up the moment "hardcoded word list" was the
thing being searched for rather than "Chinese literal".

**`checkPrMessage`'s `NOT_ENGLISH` was three hand-picked script ranges** — kana,
Han, hangul — chosen when the only other language was Chinese. ADR 035 says
commits and pull requests are English always, and that held for three scripts:
`перенести проверку`, `μετακίνηση ελέγχου` and `نقل الفحص` all walked past it,
in a product that ships Russian. It is
`/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u` now — Unicode's
own property rather than a list of the alphabets somebody remembered, with
`Common` and `Inherited` keeping digits, punctuation and combining marks legal
and `Latin` keeping `déplacer` legal.

**`validateSelfReview` counted `ok`, `met` and `not met` as verdicts**, three
English words no prompt hands out, and refused a fixed lexicon of English
non-answers — `looks good`, `lgtm`, `all good` and four more. So `looks ok`
counted as a verdict and `bestanden` did not, and `sieht gut aus` was accepted
where "looks good" was refused. `roles/engineer.yaml` shows `--review "pass: …"`
and `roles/qa.yaml` says "state pass or fail", so the vocabulary is `pass|fail`
and counting those is language-free. The lexicon is gone: a review with no
verdict word is refused by the count, which is the same refusal in every
language, and product invariant 8 — the prompt and the validator describe the
same behaviour — becomes true rather than half true.

Both are only visible if the search is for the *shape*. A guard that looks for
Chinese literals cannot see an English one.

## What is left that is language-dependent

`short.length < 8` counts characters, and a dense script says more per character,
so a Korean or Japanese pair below the floor is not examined. That direction is
**lenient** — it declines to refuse, which is how a hard refusal should fail —
and `draft-card.test.ts` asserts it rather than pretending it is uniform.

## Compatibility

None required. No protocol change, no migration, nothing stored moves.
`DRAFT_FIELDS`, `ALIAS`, `draftLegacy` and `tableSlices`' three columns are
untouched, so the 0.2.0 retirement clock is unaffected — and the rejected
declared-column option would have started a second one. `testOnly`'s removal is
monotonically loosening; the `GENERIC_GATE` swap loosens nine languages and
tightens only the case where a slice criterion is boilerplate the card itself
never claims.

## Guards

- `draft-card.test.ts` runs one card through seven shipped locales and asserts the
  verdict is the same in all of them, in both directions. Shown failing against
  the previous validator: seven red, five of them a correct card refused and two
  a real nested pair let through.
- `server-chinese-baseline.json` follows `mech/util/validate.ts` from 8 to 6, and
  its ratchet is two-sided, so the file cannot re-grow to its old count.

## Reopen

If a tests-only slice reaches an Engineer turn again — observable as a `reconcile`
gate failure with `nothing was claimed and nothing changed` on a slice whose
sibling landed the change — reinstate the check as a cheap-model reader at
`postDraft` only, never on the approval path, failing open.
