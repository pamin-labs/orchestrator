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
9. `src/states.ts` is the lifecycle vocabulary; every stored state has a driver,
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
- Own product logic and reuse commodity capabilities. Prefer deletion, existing
  code, standard library, platform features, installed dependencies, then a
  well-maintained library before writing infrastructure the project must own.
- A new dependency must delete its replaced implementation in the same coherent
  change and document maintenance, security, licence, cost, and rollback.
- Validate `unknown` data at trust boundaries; avoid `any` and unsafe type
  assertions.
- Test observable behavior and failure paths. Keep incident regression tests;
  remove tests that merely rerun compiler or linter commands.
- No sleeps for synchronization, unbounded concurrency, dangling promises,
  swallowed errors, or retries of non-idempotent work.
- A bug fix must block the same bug class at its shared entrypoint, type,
  invariant, or source guard.

## Commits

Before every commit, run TypeScript and the full Bun suite, then stage exact
owned files. Follow `.claude/skills/git-commit/SKILL.md`. Commit subjects explain
the finding; bodies explain the observed failure and why the fix belongs at that
layer.
