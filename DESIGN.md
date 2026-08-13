# DESIGN

The web page. One file, `web/index.html`, no framework, no build step, nothing
fetched at runtime.

## The scene that decides everything

Afternoon at the desk, editor open beside this, a fifteen-second glance every
twenty minutes to see if anything waits on the boss. Not a war room, not a
wallboard, never stared at for an hour.

That forces: **light, warm paper, dense, no ceremony.** A dark neon console would
be the category reflex ("AI tool, therefore dark"), and it is wrong for a page
read in daylight next to an editor. A dark variant exists because the tool stays
open into the evening, but it is the same design in dark ink, not a second design.

## Abstraction: a decision queue plus one pipeline per requirement

Not a kanban. A board models moving cards between columns and the boss never
moves anything: the columns are written by the system, so the board's central
affordance is dead and misleading. Four of five columns also say "nothing for you
here" at equal visual weight.

What the interaction actually is:

1. **A queue** of decisions that arrive over time, action buttons on the row,
   which can reach zero. "都处理完了" is an achievable state. A board always looks
   half empty, which trains the reader to ignore it.
2. **One track per requirement**, segments are slices in order, three discrete
   ticks inside each are its gates. Sequence is what "走到哪" means, and columns
   cannot express it.

Clicking either goes to the drill-in: slice lanes, the tasks under each slice, who
is working, and the open question sitting under the lanes it blocks.

**Progress is never a percentage.** A model's percentage is a guess; a gate is a
fact. Gate ticks are fixed-width marks, not a full-width fill, so they cannot be
misread as one.

## Colour

OKLCH throughout. No `#000`, no `#fff`; every neutral is tinted warm (hue ~72).
Restrained: tinted neutrals plus one accent, with a semantic state vocabulary.

| Token | Job |
|---|---|
| `--accent` indigo `oklch(0.435 0.145 285)` | **needs you**, and nothing else |
| `--ok` green | a gate passed |
| `--bad` red | a gate failed |
| `--ink-3` | not run yet |
| motion (`breathe`) | running now |

The accent is cool and deliberately far from red / amber / green so "needs you"
can never be misread as a gate outcome. It marks the queue border, the waiting
slice, primary buttons, and the current selection. Never decoration.

## Type

One family: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`. Mono
(`ui-monospace`) for identifiers, paths, branches, money, token counts. Fixed rem
scale, ratio ~1.18, no fluid clamps: product UI is read at one DPI.

Sizes in use: 0.625 (pills), 0.6875 (meta), 0.75 (secondary), 0.8125 (body /
controls), 0.875 (base), 0.9375 (group name), 1.375 (the one big number in 成本).

## Layout

- Header (project switch, spend, connection) → nav (the five views) → one view.
- The views are peers, one at a time. Crowding them onto one screen is how an
  earlier version became seven boxes each reporting an absence.
- Chat is a collapsible right sidebar, never the spine.
- Hairlines and spacing instead of card borders. Cards appear once, shallowly,
  never nested.
- Fixed grid columns in the slice lanes so gate tracks line up down the page.
  A track whose left edge moves with the title length cannot be compared with the
  one above it, and comparing them is the whole view.

## Motion

150 to 250 ms, `cubic-bezier(0.22, 1, 0.36, 1)`. Only state: hover, focus, the
live dot, a new feed line fading in. No layout properties animated, no page-load
choreography.

## Components

Every control has default / hover / focus-visible / active / disabled. One button
shape everywhere: `.go` for the primary action, plain for secondary, `.quiet` for
destructive-adjacent (打断, 封存).

Empty states teach the interface instead of reporting absence. With no project at
all, the page is one panel with the one field it needs, not a tutorial.

## Banned here

Side-stripe accent borders, gradient text, decorative glass, hero metrics,
identical card grids, modal-as-first-thought, decorative motion, em dashes in
copy. The one `—` that remains is inside the DRAFT card placeholder, because the
validator parses `标题 [normal] — 验收方式` and the placeholder must show real
syntax.

## Copy

Chinese for status, questions, journals. English for code, branches, commits, PR
titles, errors. Plain words over internal vocabulary: 跑测试 not 闸门, 别人替你答的
not 代答, 轮到你 not `chain_state=boss`. If the boss would need the source to
understand a label, the label is wrong.
