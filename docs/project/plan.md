# Orchestrator project plan

Orchestrator is a local AI employee coordination system for a one-person
company. The owner supplies an idea and approves a short DRAFT, accepts coherent
slices, and merges the resulting pull request. Planning, implementation,
deterministic gates, independent review, and delivery are delegated.

This file owns product goals, scope, milestones, and unfinished work. System
contracts live in `docs/architecture/`, engineering rules in `docs/standards/`,
operational procedures in `docs/operations/`, and decisions in `docs/adr/`.

## Product goals

- Keep owner attention on decisions with evidence, not routine coordination.
- Make every live state durable, observable, and driven to a terminal outcome.
- Limit failure to one independently acceptable slice.
- Enforce trust, dependency, ownership, and prompt-cache boundaries in code.
- Support multiple projects and non-overlapping groups without shared checkout
  corruption.
- Remain self-hostable and portable across supported release platforms.

## Core model

Four entities are first-class:

- `job`: future work and the sole dispatch mechanism.
- `event`: append-only facts about what happened.
- `note`: durable blackboard knowledge and exported journals.
- `task` / `slice`: executable work and independently acceptable delivery.

A group is a task subtree plus branch, sandbox, roster, ownership, and budget.
It is not a second scheduler. Agent turns are bounded transactions over this
model.

## Product invariants

1. Prompt deltas are appended to the newest user message by
   `src/prompt/assemble.ts`.
2. `orch lease` accepts only registered resources and schema-validated data.
3. Deterministic policy is enforced by code, not requested in prompts.
4. Every stored state has a driver, terminal declaration, or idempotent repair.
5. Group agents run inside their own OpenSandbox boundary; real credentials stay
   in the credential vault.
6. GitHub is the source of projects and the remote is the home of branches.
7. File ownership is checked before parallel work and reconciled after turns.
8. Prompt permissions and validators describe the same allowed behavior.
9. Expected failures have stable codes and external I/O has an explicit failure
   path.
10. Every architectural exception is recorded as an ADR.

## In scope

- Requirement intake, DRAFT approval, slice execution, review, and PR lifecycle.
- Agent roles, bounded turns, interruption, parking, budgets, and escalation.
- Per-group sandboxes, mailbox transport, credential substitution, and leases.
- Deterministic build/test/lint/security gates and reconciliation.
- Browser control plane, SSE, notifications, settings, and evidence views.
- GitHub project discovery, branch publication, PR polling, and merge queue.
- Project knowledge, onboarding, lessons, journals, and cost attribution.
- Open-source governance, reproducible CI, and immutable releases.

## Out of scope

- A general DAG or SaaS integration engine.
- Direct agent access to owner secrets or unrestricted host commands.
- Automatic merge to the protected default branch.
- Silent fallback from containers to host execution.
- Compatibility aliases before the first public stable release.

## Architecture summary

```text
web/src
   -> shared HTTP contracts
src/http/routes
   -> src/api/panel | src/api/orch
   -> src/mech
   -> src/runtime and external adapters
   -> SQLite | OpenSandbox | GitHub | provider CLI
```

The detailed dependency, data-flow, API, error, async, state, security,
observability, performance, and compatibility contracts are linked from
`docs/README.md`.

## Milestones

| Milestone | Outcome | State |
|---|---|---|
| M0 | Durable project state and restartable development context | Complete |
| M1 | Single-group end-to-end skeleton | Complete |
| M2 | Sandbox boundary and two-level review | Complete |
| M3 | Intercept, watchdog, and notifications | Complete |
| M4 | Answer chain and feedback routing | Complete |
| M5 | Ownership, merge queue, and PR watcher | Complete |
| M6 | Standup, cost, provider adapters, and archive | Complete |
| M7 | Executable engineering governance and versioned protocol | In progress |
| M8 | Operability, test architecture, and immutable release evidence | Planned |

## Current delivery sequence

1. Move project state and decisions under the documentation tree.
2. Make `AGENTS.md` the concise engineering entrypoint.
3. Publish architecture and standards with one enforcement owner per rule.
4. Establish TypeScript project references, type-aware Oxlint, and Fallow zones.
5. Ship `/api/v1/*` and `/orch/v1/*` without legacy aliases.
6. Add consistent errors, cancellation, idempotency, readiness, metrics, and
   graceful shutdown where the runtime requires them.
7. Remove redundant tests, add focused property tests, and reduce median suite
   time by at least 35% or to at most eight seconds.
8. Replace mutating CI and release workflows with read-only PR checks and
   immutable, attested releases.

Acceptance and measured status for the active milestone live in
`docs/project/progress.md`.
