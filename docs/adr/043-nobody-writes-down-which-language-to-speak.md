# 043. Nobody writes down which language to speak

## Status

Accepted.

## Context

`output.language` — what the agents write in, and what leaves this machine for a
person — defaulted to the string `"中文"`, hardcoded in `src/platform/config/load.ts`.

Two things were wrong with that, and only one of them is taste.

Every other fallback in this design is English. `localeOf()` ends in `?? "en"`.
A message with no catalogue row renders the English the macro hashed. ADR 041
records the reason: English is the source, so an unrecognised locale falls back
to it rather than to nothing. This one key disagreed, and the disagreement was
not free — `src/api/orch/escalation.ts` compared `language === "en"` against it,
so its English branch was unreachable for every spelling of English there is.

The second is the one a user notices. A German boss installing this got a German
panel — the panel detects `navigator.language` — and Chinese webhooks, until they
found a knob. The two halves of one preference disagreed about what "nobody has
chosen yet" means.

The knob's own comment named the wall: it could not offer a "follow the panel"
option, because *"the server never learns what this browser is set to — that
lives in `localStorage` — so a value promising to track it would be a lie the
moment the reader changed panes."*

## Decision

Let the server learn it.

- `panelLanguage` is a config key the panel's locale menu writes through the
  settings API when the reader picks a language. One of the ten, or `""`.
- `language` allows `""`, and `""` is the shipped default. Nothing is written
  down on a fresh installation.
- `outputLanguage(cfg)` resolves the three: **what the boss set for output wins,
  otherwise the language they are reading the panel in, otherwise English.**
- Every reader goes through it. `output-language-is-resolved` is the guard —
  `config.language` outside `src/contracts/config.ts` is a failure, because the
  raw field is now an intent (`""`) rather than an answer, and a caller taking it
  directly writes a prompt telling an agent to answer in nothing.
- The `Output language` knob lists "Same as the panel (…)" first. `Combobox` is
  free text, so its options *are* their values; the follow row is a sentence
  mapped to `""` at that one call site.

ADR 035 is unchanged: these are still two values on purpose — what I read is not
what my customers read. This decides only what "nobody has said" means.

## Consequences

A fresh installation speaks the reader's language with no file, no knob and no
default to know about: the panel detects the browser, the menu writes it through,
and output follows. A boss who wants them different sets the knob, and it wins.

The cost is a config key that is settable through the API and absent from the
settings page — it is in `KNOBS_ELSEWHERE`, because Preferences already owns that
choice and a second control for one fact is two controls that can disagree.

Ten tests asserted the rendered Chinese of a server event, which is what the old
default produced. They assert the English source now, which is what `msg` says
rather than what one catalogue renders it as.
