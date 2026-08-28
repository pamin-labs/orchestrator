# Orchestrator engineering guide

Orchestrator coordinates AI employee teams for a one-person company. Keep this
file short: it is the navigation and invariant layer. Detailed rules live under
`docs/` and are enforced by the compiler, Oxlint, Fallow, tests, and CI.

## Start here

Read in this order before changing code:

1. `docs/project/progress.md`
2. `docs/project/plan.md`
3. affected files in `docs/architecture/`
4. affected files in `docs/standards/`
5. relevant ADRs in `docs/adr/`

Update `docs/project/progress.md` after each verifiable unit, not after each
file. Record an architectural exception or changed decision in a new ADR.

## Architecture invariants

1. `web/src` imports browser code and shared public contracts only.
2. `src/http/routes` composes Hono, schemas, middleware, and handlers; it owns no
   business policy.
3. `src/api` translates protocol operations and may call `src/mech`.
4. `src/mech` never imports API, route, or web modules.
5. Runtime and external adapters never import panel or web policy.
6. Cross-boundary imports use declared public files; no accidental deep import.
7. Prompt assembly goes through `src/prompt/assemble.ts`, and injected delta is
   appended to the newest user message.
8. `orch lease` accepts only registered resources plus schema-validated data.
   It returns after enqueue; a single durable follow-up turn carries the result.
   Agents never poll or resubmit a queued lease.
9. `src/contracts/states.ts` is the lifecycle vocabulary; every stored state has a driver,
   terminal declaration, or idempotent repair in the invariant table.
10. Expected failures use stable error codes. External I/O has timeout,
    cancellation, contextual error propagation, and an explicit failure path.
11. No new mutable singleton state. State ownership and transaction boundaries
    must be explicit.
12. Every architectural exception requires an ADR and an executable regression
    guard where possible.

## Technology and commands

- Bun + strict TypeScript, Hono, Zod, PostgreSQL through Drizzle
  (`drizzle-orm/bun-sql`), React, Tailwind v4, and shadcn/Radix behavior
  primitives. Tests talk to a real Postgres in a container, one schema per
  worker — which is why a suite run costs what it does.
- Agent processes run in per-group OpenSandbox containers. The file mailbox and
  `orch` CLI are their only orchestration interface; real credentials remain in
  the egress vault.
- Use existing shadcn behavior for dialogs, menus, toasts, command surfaces,
  accordions, buttons, and inputs. UI visual rules are in `docs/design/ui.md`.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run check
```

Use targeted tests while iterating, then the complete gates before a commit.

**`bun run test`, not `bun test`** — including with a path after it, which is
forwarded. The script carries `--parallel`, and `test/support/dom.ts` registers a
DOM only for the files that need one, which it decides from `Bun.main`. That only
holds when each file gets its own process, which `--parallel` implies. Run bare
`bun test` over a directory and every file is classified from the first one's
path; the symptom is `HTMLElement is not defined` in a file that looks nothing
like a browser test.

**Read CRAP numbers only from `bun run audit:crap`.** It regenerates coverage
first; plain `bun run audit` reads whatever `coverage/coverage-final.json`
happens to hold, and a stale one is worse than none — functions it can no longer
match fall back to an export-reference estimate of "0% tested" and breach the
threshold. Measured twice in one session: once as 189 phantom complexity
findings across thirty files, once as a single finding against a function with
twelve passing unit tests. The structural findings in plain `audit` — boundaries,
cycles, dead code, duplication — are unaffected and can be trusted.

**The audit base is pinned, and you no longer have to remember it.** All three
`audit` scripts carry `FALLOW_AUDIT_BASE=origin/main`. Left to itself the base
is the merge-base with the branch's *upstream*, so on a pushed branch it is
`HEAD` and the scan reports `✓ No issues in 0 changed files` — a green tick over
nothing examined, which is worse than a red one. Measured on this branch before
the pin: 15 files and 45 functions against 287 and 5140. It was preflight-only —
a CI `pull_request` checkout has no upstream and already fell through to main —
but a rule written down and followed by neither call site is a rule. Both traps
on this page have the same shape: a command that answers about a scope you did
not choose, and answers cheerfully.

Do not run overlapping enforcement owners. Replacing TypeScript, Oxlint,
Fallow, Bun test, CodeQL, or another owner requires an ADR and migration
evidence; adding a second tool beside it is forbidden. Dependency selection is
defined in `docs/standards/dependencies.md`.

## Required plan for non-trivial work

Before implementation, record or state:

```text
Affected boundaries
Current invariants
Data/control flow
Public API impact
Persistence/migration impact
Failure semantics
Async/concurrency impact
Security/trust boundaries
Performance/observability impact
Compatibility strategy
Test strategy
Rollback
```

Use `N/A: reason` where a field truly does not apply. Empty fields are not a
plan.

## AI-specific delivery workflow

1. Read current project state and affected contracts.
2. Run `fallow guard` for touched areas and identify change radius.
3. Write the task plan above.
4. Implement the smallest coherent slice.
5. Run the TypeScript project build and type-aware Oxlint.
6. Run targeted Bun tests, then the full suite.
7. Run Fallow audit and Fallow Review.
8. Run independent architecture/API, security, test-quality, and performance
   review when those areas are affected.
9. Review the diff, update project progress, and create a small commit.

For parallel agent work, give every agent mutually exclusive file ownership,
the minimum necessary tools, explicit verification commands, and a required
`PASS/FAIL + file:line + evidence` report. Agents must not stage, commit, revert,
or run the full suite unless they own integration.

## Coding and testing rules

- English for code, comments, errors, branches, commits, and pull requests.
- Own product logic; rent everything else. A capability a popular, maintained
  library already provides is not written here. Adopt when it deletes
  project-owned code, tests or does the more correct thing, or supplies a
  capability we need now or plausibly later. "We could write this ourselves" is
  not a reason to decline; declining needs measured evidence and a reopen
  condition. Ignore anything with no release in over a year.
- A new dependency must delete its replaced implementation in the same coherent
  change and document maintenance, security, licence, cost, and rollback. It
  must not become a second owner for a risk in the enforcement matrix.
- **Use a library the way its current documentation says to.** Read the installed
  version — `node_modules/<pkg>` types and README, plus the project's own docs —
  before writing against it, and take the API from what is in front of you rather
  than from recall or a blog post: majors move, and result shapes move with them.
  Prefer its documented extension point over a wrapper of your own; if you find
  yourself writing a loop, a timer, a statistics helper or a queue beside it, that
  is a feature you have not reached for. Wiring it the unofficial way is how a
  correct dependency still produces a defect that reads as the library's fault —
  a lazily-registered DOM instead of the documented preload entry, a
  `SpanProcessor` where the SDK wanted a `SpanExporter`. State in the change which
  documented pattern you followed.
- Validate `unknown` data at trust boundaries; avoid `any` and unsafe type
  assertions.
- Test observable behavior and failure paths. Keep incident regression tests;
  remove tests that merely rerun compiler or linter commands.
- A new guard is shown failing before it is kept, and a claim about a bundle, a
  CI command or a library's runtime is measured rather than reasoned about.
  Both rules, and the defects that produced them, are in
  [`testing`](docs/standards/testing.md).
- A `key`, a dependency array or a cache key takes the resolved value, not the
  raw one in scope. See [`state-management`](docs/standards/state-management.md).
- No sleeps for synchronization, unbounded concurrency, dangling promises,
  swallowed errors, or retries of non-idempotent work.
- A bug fix must block the same bug class at its shared entrypoint, type,
  invariant, or source guard.
- **A sentence a person reads is named, not written.** Four places to write one,
  and the place decides which:

  | where | how |
  |---|---|
  | JSX | `<Trans>` / `<Plural>`, from `@lingui/react/macro` |
  | inside a component | `` t`` `` from `const { t } = useLingui()` — it re-renders when the locale moves |
  | outside one (module tables, helpers) | `` msg`` `` → a descriptor; the caller renders it with `t(…)` or `i18n._(…)` |
  | the server | `` say: msg`merged into main` `` on `bus.emit`, never `body:` |

  One object under three names, and which one you write says where it is:
  `` msg`` `` is the macro, `MessageDescriptor` is what it produces, and `Said`
  is that descriptor after it has crossed the wire — same fields, validated,
  because `event.meta_json` is JSON somebody else stored. `src/contracts/said.ts`
  states the equivalence to the compiler rather than in a comment.

  `bus.emit` renders `say` into `body` and stores the descriptor beside it, so
  the panel draws the row from `meta.say` in whichever of ten languages its
  reader chose. Values carry values, never a rendered fragment: a descriptor
  inside another's values is one sentence in two languages. English is the
  source, so an unrecognised locale falls back to it rather than to nothing.
  Three exceptions, and only three: what a model reads, what a log or `/readyz`
  carries, and a protocol key — and a comment that names a label spells it the
  way the source does. Which text follows which language is the table in
  [`035`](docs/adr/035-language-follows-who-wrote-it.md); how it is wired is
  [`044`](docs/adr/044-what-the-panel-and-the-server-actually-say.md).
  Guards: `panel-speaks-english`, `server-speaks-one-language`,
  `values-carry-no-rendered-text`, `an-event-names-its-sentence`,
  `a-component-takes-t-from-the-hook`.

  **A change that adds one is not finished until ten catalogues carry it.**
  `bun run i18n:extract`, fill the eight you write by hand, and `zh-Hant` is
  generated from `zh` by `i18n:hant`. This is not a courtesy step: the CLI test
  asserts an *empty stderr*, and lingui writes its missing-translation warning
  there, so an untranslated string is a red suite rather than a quiet gap.
  `bun run preflight` runs both halves — every message translated with its
  placeholders intact, and the catalogues matching the source.

  A **protocol key** is the third exception and it is narrower than it sounds: a
  key written into a table and read back (`index-fail:p1:claude:haiku`), a stored
  verdict compared by value (`gates_json` holding `pass`/`blind`/`none`), a
  resource name. Nobody reads one as a sentence. A label on a settings page, a
  question filed for the boss, and a row in the timeline are none of those.
- Anything that costs wall-clock time carries a span. New work that waits on a
  container, a network call, a subprocess, or the filesystem opens one through
  `activeTracer().startActiveSpan`, names it after what it does rather than a
  number, and sets `SpanStatusCode.ERROR` before rethrowing. Put the span at the
  one place every case passes through, not at each caller: the twenty-fifth
  caller is the one that will not have it. Untimed work is invisible in `System timing`,
  and the panel is where "which one is slow" gets asked — a watchdog tick
  reported 50s against a 30s interval for as long as it was a single span.
  Details in [`observability`](docs/standards/observability.md).

## Before opening a pull request

```bash
bun run preflight
```

One command, everything CI gates on, about twenty seconds. It reports each step
as passed, failed, or **skipped with the reason** — a step needing a binary this
repository does not vendor (`actionlint`, `shellcheck`, `docker`) says so and
names what CI will do instead, because a preflight that silently skips the
container scan promises a green run it never tested.

Four checks have no local form and are named at the end of every run:
`security-codeql` runs on GitHub's infrastructure; `dependency-review` asks
GitHub's API about the pull request's own range, which is where the licence
allow-list is enforced; `codecov/patch` is posted by a second workflow *after*
CI has already reported green, and it is the one status that can fail;
and `pr / verify engineering plan sections` reads a pull request body that does
not exist yet — fill in `.github/pull_request_template.md` and it passes.

There were two until a parity sweep walked both sides. Preflight also ran
`bun audit --audit-level=high` where CI runs it bare, so a moderate advisory
was red there and green here, and `fallow security --changed-since main` where
CI diffs `origin/main` — a local ref that can sit behind the remote is a scope
nobody chose.

CI minutes cost money and a red check costs a round trip. Push knowing the
answer.

## Commits

Before every commit, run TypeScript and the full Bun suite, then stage exact
owned files by name — `git add -A` sweeps in another session's half-finished
work. Sign off every commit (`git commit -s`); CI's `dco` job checks each one
against its author, and repairing a branch afterwards rewrites its history.

Conventional Commit prefix, scoped to the module — **on the pull request title
too**, since squash puts that title on `main` as the commit subject. The subject
states the **finding**, not the diff — the log is read by somebody asking *why is
this like this*. The body says what the failure looked like, why the fix is at
that layer, and what was deliberately left out; measurements beat adjectives.
Examples and the full convention are in [`CONTRIBUTING`](CONTRIBUTING.md).
