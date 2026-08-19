# Engineering documentation

This tree is the source of engineering policy. `AGENTS.md` is the short entry
point; it links here instead of repeating rules.

## Read by purpose

- Current delivery: [`project/plan.md`](project/plan.md) and
  [`project/progress.md`](project/progress.md)
- Architecture: [`principles`](architecture/principles.md),
  [`module boundaries`](architecture/module-boundaries.md),
  [`dependency rules`](architecture/dependency-rules.md), and
  [`data flow`](architecture/data-flow.md)
- Standards: [`enforcement matrix`](standards/enforcement-matrix.md),
  [`dependencies`](standards/dependencies.md),
  [`TypeScript`](standards/typescript.md), [`API`](standards/api-design.md),
  [`errors`](standards/error-handling.md),
  [`async/concurrency`](standards/async-concurrency.md),
  [`state`](standards/state-management.md), [`data`](standards/data.md),
  [`testing`](standards/testing.md), [`security`](standards/security.md),
  [`observability`](standards/observability.md),
  [`performance`](standards/performance.md),
  [`compatibility/migrations`](standards/compatibility-migrations.md),
  [`documentation`](standards/documentation.md), and
  [`code review`](standards/code-review.md)
- Operations: [`development`](operations/development.md),
  [`CI`](operations/ci.md), [`release`](operations/release.md),
  [`observability`](operations/observability.md),
  [`rollback`](operations/rollback.md), and
  [`security candidates`](operations/security-candidates.md),
  [`coverage gaps`](operations/coverage-gaps.md)
- UI language: [`design/ui.md`](design/ui.md)
- Accepted and superseded decisions: [`adr/`](adr/)

## Authority

When documents disagree, an accepted ADR wins over a standard, a standard wins
over operational guidance, and executable enforcement decides what can ship.
Resolve the disagreement in the same pull request. A deliberate exception needs
a new ADR, an owner, and an expiry or removal condition.

Runtime-generated journals under `docs/journal/` are project evidence, not
engineering policy.
