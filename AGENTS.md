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

- Bun + strict TypeScript, Hono, Zod, `bun:sqlite`, React, Tailwind v4, and
  shadcn/Radix behavior primitives.
- Agent processes run in per-group OpenSandbox containers. The file mailbox and
  `orch` CLI are their only orchestration interface; real credentials remain in
  the egress vault.
- Use existing shadcn behavior for dialogs, menus, toasts, command surfaces,
  accordions, buttons, and inputs. UI visual rules are in `docs/design/ui.md`.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run check
```

Use targeted tests while iterating, then the complete gates before a commit.

**Read CRAP numbers only from `bun run audit:crap`.** It regenerates coverage
first; plain `bun run audit` reads whatever `coverage/coverage-final.json`
happens to hold, and a stale one is worse than none — functions it can no longer
match fall back to an export-reference estimate of "0% tested" and breach the
threshold. Measured twice in one session: once as 189 phantom complexity
findings across thirty files, once as a single finding against a function with
twelve passing unit tests. The structural findings in plain `audit` — boundaries,
cycles, dead code, duplication — are unaffected and can be trusted.

**Audit a branch with `--base main`.** The default base is the merge-base with
the branch's own remote, so once a branch is pushed that base *is* `HEAD` and
the scan reports `✓ No issues in 0 changed files` — a green tick over nothing
examined, which is worse than a red one. Both traps have the same shape: a
command that answers about a scope you did not choose, and answers cheerfully.

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
- Anything that costs wall-clock time carries a span. New work that waits on a
  container, a network call, a subprocess, or the filesystem opens one through
  `activeTracer().startActiveSpan`, names it after what it does rather than a
  number, and sets `SpanStatusCode.ERROR` before rethrowing. Put the span at the
  one place every case passes through, not at each caller: the twenty-fifth
  caller is the one that will not have it. Untimed work is invisible in 系统耗时,
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

Two checks have no local form and are named at the end of every run:
`security-codeql` runs on GitHub's infrastructure, and `pr-plan` reads a pull
request body that does not exist yet — fill in `.github/pull_request_template.md`
and it passes.

CI minutes cost money and a red check costs a round trip. Push knowing the
answer.

## Commits

Before every commit, run TypeScript and the full Bun suite, then stage exact
owned files by name — `git add -A` sweeps in another session's half-finished
work. Sign off every commit (`git commit -s`); CI's `dco` job checks each one
against its author, and repairing a branch afterwards rewrites its history.

Conventional Commit prefix, scoped to the module. The subject states the
**finding**, not the diff — the log is read by somebody asking *why is this like
this*. The body says what the failure looked like, why the fix is at that layer,
and what was deliberately left out; measurements beat adjectives. Examples and
the full convention are in [`CONTRIBUTING`](CONTRIBUTING.md).
