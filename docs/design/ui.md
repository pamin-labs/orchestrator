# DESIGN

The web page. React and Tailwind v4 built into `web/dist`, shadcn/Radix for
behaviour only, nothing fetched at runtime — the fonts are the ones already on
the machine and `test/integration/smoke.test.ts` fails if a remote origin appears in the
served HTML.

## The scene that decides everything

Afternoon at the desk, editor open beside this, a fifteen-second glance every
twenty minutes to see if anything waits on the boss. Not a war room, not a
wallboard, never stared at for an hour.

That forces: **light, warm paper, dense, no ceremony.** A dark neon console would
be the category reflex ("AI tool, therefore dark"), and it is wrong for a page
read in daylight next to an editor. A dark variant exists because the tool stays
open into the evening, but it is the same design in dark ink, not a second design.

## Less is more. 克制。

The rule that outranks every other rule here: **add nothing the boss did not need
to see.** Not fewer features, fewer marks on the screen for the same fact.

Concretely, on every change ask:

- Is this number already on the screen? A diffstat above a pane switch that
  repeats it is the same three numbers twice, 200px apart. Print it once.
- Is this box doing work? A border, a radius and a fill around content that
  already sits inside a bordered list is three frames drawn around one thing.
  Hairlines and a shared left edge say the same and cost nothing.
- Is this control louder than what it controls? A black pressed pill switching
  between panes competes with the diff it switches to. State can be carried by a
  tint.
- Would a sentence do what a paragraph is doing? QA's report is the working, not
  the verdict. Two lines, the rest one click away.
- Is this the whole label, or the whole label plus an explanation? Say it once.

Density is not crowding. Dense means many facts, each stated once, aligned so the
eye can compare them. Crowded means one fact stated three ways.

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

## Surfaces: three depths, and they mean something

Flattening the evidence panel removed the boxes and left everything looking the
same: rows, verdicts, diffs and logs all hairline-separated text on paper. The
fix is not more borders. It is depth, and each depth has one job:

| Surface | What sits on it |
|---|---|
| `paper` | what you steer — list rows, questions, headers, the acceptance line |
| `rail` | the row you are inside. An open accordion row is tinted so the body under it has a visible owner |
| `sunk` | what a machine produced — diffs, gate logs, the drafted answer. Recessed, never authored by a person |

Two rules that follow:

- **Never two boxes around one thing.** A panel inside a bordered list inside a
  row is three frames drawn around the same content. Depth plus one hairline says
  it.
- **`rule` between kinds, `rule-soft` between siblings.** Rows in a list are
  siblings; a verdict block and the diff under it are not. Making both hairlines
  the same weight is what made the panel read as one undifferentiated column.

Gutters: one value, both sides, the same as the row above. An asymmetric gutter
(`pl-14 pr-3`, indenting to a title on one side only) reads as a mistake even
when the reason for it is real.

## Type

One family: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`. Mono
(`ui-monospace`) for identifiers, paths, branches, money, token counts. Fixed rem
scale, ratio ~1.18, no fluid clamps: product UI is read at one DPI.

The scale has names, in `web/style.css`, and nothing writes a rem literal:

| token | rem | for |
|---|---|---|
| `text-tag` | 0.5625 | the smallest label that still has to be read |
| `text-pill` | 0.625 | pills |
| `text-meta` | 0.6875 | meta |
| `text-secondary` | 0.75 | secondary |
| `text-body` | 0.8125 | body / controls |
| `text-base` | 0.875 | base |
| `text-name` | 0.9375 | group name |
| `text-lead` | 1 | the line above a section |
| `text-card` | 1.0625 | card heading |
| `text-title` | 1.25 | page heading |
| `text-figure` | 1.375 | the one big number in `Cost` |

Layout widths and grid templates stay inline, deliberately. The scale above was
eleven values over 262 call sites — one shared ruler that had drifted. The layout
literals are about twenty values over one to five sites each
(`grid-cols-[minmax(0,1fr)_auto]`, `max-w-[76rem]`), which is a page deciding its
own proportions, not a constant with several copies. Naming
`grid-cols-[2rem_minmax(0,1fr)_auto]` would move the definition away from the
only grid that has it. `css-token-drift` still reports them as advisory; reopen
this if one width reaches the double figures the type scale did.

Eleven, not the seven this sentence used to claim. Four of them —
0.5625, 1, 1.0625, 1.25 — were in the product and not in this document, across
262 call sites in 43 files, and neither side could tell. Naming them changed no
pixel; it made the disagreement impossible to have again, and
`test/governance/type-scale.test.ts` fails on the next rem literal.

## Layout

- One header row: project trail, the five views, subscription usage, waiting
  count, connection. `Settings` is the gear, not a sixth view — it opens over the work. It was two rows for a while and the second was a tab strip
  above pages that had their own tab strips. Spend is not here — it belongs in
  `Cost`, where it can be attributed. Usage is, because it is a constraint on what
  to start next — and only for an account that has a window. A per-token key or a
  self-hosted gateway shows nothing there rather than a percentage read off some
  other subscription.
- The views are peers, one at a time. Crowding them onto one screen is how an
  earlier version became seven boxes each reporting an absence.
- **The window never scrolls; a pane inside a view does.** The shell is one
  `h-dvh` grid, rows `auto` (header) and `minmax(0,1fr)` (everything else), and
  each view carries a `min-h-0` chain down to the pane that owns the scrollbar.
  Two rules follow from experience: never measure a region as
  `calc(100vh - <header>)` — that writes the same height twice and detunes on the
  next header change — and a grid whose rows are left at `auto` grows past its
  container no matter what `min-h-0` says above it, so pin the row to
  `minmax(0,1fr)`. `overflow: hidden` on `body` is not a fix; it hides the
  content that could not be reached.
- One count, one name. `To do` is the queue of things waiting on the boss, and it
  appears once — as the tab that holds it, and as the header badge. Two lists
  with the same name and different counts is how a number stops being trusted.
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
destructive-adjacent (`Interrupt`, `Archive`).

Empty states teach the interface instead of reporting absence. With no project at
all, the page is one panel with the one field it needs, not a tutorial.

## Banned here

Side-stripe accent borders, gradient text, decorative glass, hero metrics,
identical card grids, modal-as-first-thought, decorative motion, em dashes in
copy.

The one dialog that is not a view is `Settings`, and it took four page versions to earn
it. A view is 76rem wide and settings is a dozen fields, so every page version
was mostly white, and the two scopes — this server, this repository — read as the
same thing because they were built from the same three components. A dialog sizes
itself, so its density is designed rather than inherited from the window; and one
left rail holds both scopes as two groups, which is the thing neither page could
say about itself. It is also the only surface here nobody is ever *in*: you come
to fix something and go back to the work, which is what closing a dialog does and
what navigating back from a view does not. Modal-as-first-thought stays banned;
this was the fifth. The one `—` that remains is inside the DRAFT card placeholder, because the
validator parses `title [normal] — accept` and the placeholder must show real
syntax.

## Copy

English in the source, and the reader's language on the screen. Every sentence a
person reads is named — `<Trans>` in JSX, the hook's `t` inside a component,
`msg` outside one — and a catalogue renders it in whichever of ten languages the
reader chose. Which text follows which language is the table in
[ADR 035](../adr/035-language-follows-who-wrote-it.md) §3; how it is wired is
[ADR 044](../adr/044-what-the-panel-and-the-server-actually-say.md). Three
things are not translated: what a model reads, what a log or `/readyz` carries,
and a protocol key.

This section used to read *"Chinese for status, questions, journals"*, which was
the panel's design until PR #9 and is the opposite of the rule now.

Plain words over internal vocabulary, which is the part that did not change and
is the part a catalogue cannot enforce: `Run tests` not `Gate`, `answered for
you` not `delegated`, `Your turn` not `chain_state=boss`. If the boss would need
the source to understand a label, the label is wrong — and the English is the
source every translator works from, so a label that reads as jargon here reads
as jargon in ten languages.
