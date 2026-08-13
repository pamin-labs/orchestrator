# PRODUCT

register: product

## Product purpose

A dispatch system for one person running a company of AI employees. The boss
drops an idea; groups of agents take over decomposition, architecture, coding,
testing, review and the PR. The boss does three things: approve a DRAFT card,
accept a slice, merge.

The web page is the boss's only surface. `orch` is the agents' surface.

## Users

One user. A senior engineer who built this and works next to it all day, with an
editor open in another window. Fluent in Linear, GitHub, terminal tooling. Reads
Chinese for status and English for code. Does not want to be a PM.

The page has exactly one job: answer three questions in fifteen seconds.

1. 整个需求走到哪
2. 卡在哪道闸
3. 谁在等我

## Scene

Afternoon, daylight at the desk, editor beside it. A fifteen-second glance every
twenty minutes, between the user's own tasks. Not a war room, not a wallboard,
never stared at for an hour. This forces a light, warm, paper-like surface and
high information density with no ceremony.

## Tone

Terse. Chinese for status, journals, questions. English for code, commits,
branches, PR titles, errors. No pleasantries, no restated headings, no
congratulation. A team that says little and makes the state obvious.

## Strategic principles

- **Progress is which gates passed, never a percentage.** A model's percentage is
  a guess; a gate is a fact. Render the gates.
- **Deterministic facts outrank agent narration.** What the page trusts: slice
  status, gate exit codes, file diffs, money. What it demotes: chat.
- **The DRAFT card blocks the boss, so it must be readable in 20 seconds.** Hard
  capped at 12 lines by the validator. The page must not bury it.
- **Say what is waiting on me, first and loudest.** Everything else is reference.
- **An empty screen must teach the interface**, not report absence. On a fresh
  install every panel is empty; that state is the onboarding.
- **Cost is visible, including cache hit rate.** A cache ratio that drops is the
  only symptom of the most expensive silent failure in the system.

## Anti-references

- **Chat-first agent UIs.** A transcript is not a status board. Conversation is a
  side rail here, never the spine.
- **The dark neon "AI ops console".** The category reflex. This is a desk tool in
  daylight, not a spaceship.
- **Kanban boards with equal cards.** Slices are a sequence with gates, not
  interchangeable tiles.
- **Dashboards of big numbers.** There is no metric worth a hero. The useful
  numbers are small and contextual.
- **Anything that asks the boss to read prose to learn state.**
