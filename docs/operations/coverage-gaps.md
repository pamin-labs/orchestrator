# Coverage gaps

`fallow health --coverage-gaps` answers a different question from a coverage
percentage, which is why it has its own record. A percentage says how much of a
file ran; this says whether **any test dependency path reaches it at all**. A
file at 0% here has no test that even imports it, directly or transitively —
which is a fact about the suite's shape rather than about a number, and the two
are not substitutes.

This is the disposition list. Every gap is either a real one with work attached
or a deliberate one with a reason, and a gap with neither is the thing this file
exists to prevent.

Current: **6 untested files, 19 untested exports, 96.8% file coverage.**

## Deliberate — an entry point has nothing to assert

A module whose whole body is "wire these things together and start" has no
behaviour of its own. A test of one asserts that composition is composition.

| Path | Why |
|---|---|
| `web/src/app/main.tsx` | The browser entry. Creates a root and renders `App`. |
| `web/src/app/app.tsx` · `App` | The composition root: routing state, the view switch, and the panes. Its policy already lives in `features/navigation/model.ts`, which is tested — see `test/web/navigation-rules.test.ts` and `test/web/web-app-model.test.ts`. |
| `web/src/app/boundary.tsx` · `Boundary` | A React error boundary. What it does on catch is render a message; what it exists for is a crash, which a test cannot stage without staging the crash. |
| `scripts/browse.ts` | A developer script that opens a URL. |
| `scripts/make-github-app.ts` | A one-shot interactive setup script. Its module body starts a server and awaits a redirect at the top level, so importing it from a test hangs — recorded in the commit that added its one guard, which is tested where the value enters rather than here. |

## Deliberate — the test would be a test of the language

`docs/standards/testing.md` says not to write tests that re-run the compiler.
These are one-line expressions whose only behaviour is the operator in them.

| Export | Body |
|---|---|
| `navigation/model.ts` · `choose` | `condition ? yes : no` |
| `navigation/model.ts` · `idOrZero` | `id ?? 0` |
| `navigation/model.ts` · `orEmpty` | `values ?? []` |
| `navigation/model.ts` · `itemName` | `item?.name ?? ""` |
| `navigation/model.ts` · `projectNameProps` | one optional field, present or absent |
| `navigation/model.ts` · `viewClass`, `sideClass`, `settingsClass`, `bodyClass` | a class string chosen by one boolean |
| `src/composition/server.ts` · `missingBinaries` | returns `[]`. Deliberately empty since the host stopped running binaries of its own; it is kept as the one place to name one if that changes, and asserting that a constant is a constant proves nothing. |

The rules **beside** them in the same module are a different matter and are
tested: `viewActive`, `isHome`, `showSide`, `scrollClass`, `settingsInitial`,
`projectForGroup`, `findById`, `waitingProject`, `showRequirementCrumb` and
`showNewRequirement` all carry a condition somebody chose. `scrollClass` in
particular is a membership list, which is the shape that drifts — a view added
to the strip and not to that list gets the page's scrollbar instead of its own.

## Real — components with behaviour and no render test

These have policy inside them and are reachable. They are gaps rather than
exemptions, and the work is a render test each.

| Export | What a test would pin |
|---|---|
| `features/requirement/newreq.tsx` · `NewRequirement` | The form that creates a requirement: what it refuses, what it sends. |
| `features/navigation/switcher.tsx` · `Switcher` | The project/requirement picker's keyboard and empty behaviour. |
| `features/navigation/model.ts` · `requirementItem` | Builds a picker row; more than a ternary. |
| `features/settings/view.tsx` · `SettingsDialog` | Reached by every settings render test through its panes, and not asserted directly. |
| `web/src/shared/api.ts` · `useOrch` | The query hook every view reads through. |
| `web/src/ui/confirm.tsx` · `AskHost` | The confirmation host: what it resolves on confirm, cancel and dismiss. |
| `web/src/ui/theme.tsx` · `startTheme` | Reads the stored preference and the media query, and writes the root attribute. |

## How this is checked

`bun run health:gaps` runs it, and `quality-fallow` runs it in CI. It is
**reported, not gated**: the numbers move whenever a file is added, and a gate
on them would either be a coverage percentage by another name or a reason to
write a test that asserts nothing. What is gated is that this file exists and
that a new gap gets a row in it.
