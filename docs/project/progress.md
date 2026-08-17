# Project progress

Read this file first when resuming work. Update it after a verifiable unit, not
after each edited file. Historical implementation narrative belongs to Git
history, release notes, and ADRs.

## Current milestone

M7 — executable engineering governance and versioned protocol.

## Baseline

- Branch: `refactor/api-split-and-settings`
- SHA: the commit containing this entry
- TypeScript, Oxlint, Biome, and default changed-code Fallow audit: pass
- Tests: 831 pass, 15 environment skips, 0 fail across 98 files
- Local test time: 7.64 seconds in the restricted agent environment
- Fallow: no introduced dead code, boundary, cycle, or duplication finding;
  `audit:all` still reports 88 inherited complexity/CRAP findings

## Verified complete

- Hono route schemas feed typed handlers and generated browser/CLI clients.
- External JSON is validated before entering business code.
- Group sandboxes, file mailbox transport, and credential vault boundaries are
  implemented and covered by live tests when OpenSandbox is available.
- GitHub is the project source; host Git is not part of runtime operation.
- `src/states.ts` and executable invariants cover stored lifecycle states.
- Existing full quality chain is green at the baseline SHA.
- Governance work has landed on `refactor/api-split-and-settings`; the former
  `codex/engineering-governance` worktree is historical and is not the active
  implementation path.
- Project plan and progress responsibilities moved under `docs/project/` and
  were reduced to active product state; TypeScript and 772 tests remain green.
- `AGENTS.md` is now the real engineering entrypoint, `CLAUDE.md` is its
  compatibility link, and a source guard prevents legacy documentation paths;
  TypeScript and 773 tests are green.
- The engineering constitution is split across architecture, standards,
  operations, and ADR documents; PR plans carry the required change-radius,
  failure, security, compatibility, test, and rollback evidence.
- Dependency governance now prefers maintained commodity libraries when they
  remove project-owned infrastructure, while forbidding two simultaneous owners
  for the same enforcement or runtime responsibility.
- TypeScript project references, type-aware Oxlint, and a directory-owned Fallow
  DAG have non-overlapping ownership. `entry` contains only undiscovered scripts,
  and the default new-only audit needs no health baseline. Fallow reports zero
  dead-code, duplication, boundary, cycle, coverage, or private-leak findings.
- Oxlint now rejects deprecated APIs, unsafe arguments, import-type side
  effects, unsafe catch callbacks, promise-executor returns, loop captures, and
  implicit button types. Zod 4 and Bun SQLite deprecations are removed; Fallow
  also gates stale suppressions and misplaced dev/optional dependencies.
- `/api/v1/*` and `/orch/v1/*` are the only protocol surfaces. Typed client
  contracts include middleware errors and durable idempotency discovery,
  inspection, and operator recovery without re-running an unknown side effect.
- Cancellation, durable correlation, transactional state/evidence writes,
  after-commit event fan-out, health/readiness/metrics, and graceful shutdown
  are implemented with focused failure-path tests.
- CI is read-only and separates type, lint, architecture, tests, security,
  workflow, ownership, and PR-plan gates. Releases bind a verified `main` SHA to
  immutable binaries/images, checksums, SBOMs, provenance, and an atomic tag.
- Full suite reached 831 pass and 0 fail. Six OpenSandbox tests are gated on a
  live server; nine HTTP smoke cases also skip only in restricted environments
  that cannot bind loopback. Normal CI must run the HTTP smoke suite.
- Clean TypeScript build, hard Oxlint gate, formatting, web build, performance
  budgets, and graph-pinned Fallow Review pass; the review accepted four anchored
  decisions with no rejected or stale judgments.
- Architecture/API, security/reliability, and test/performance reviewers report
  no reproducible P0 or P1 findings. Actionlint and zizmor report no workflow
  findings after the final release-order fix.

## Blockers and deviations

- Fallow's default new-only audit is green. `bun run audit:all` remains red on
  88 inherited complexity/CRAP findings; they are not hidden by a saved baseline,
  threshold increase, or inline suppression.
- Live OpenSandbox tests remain environment-gated and are skipped without a
  running sandbox server.
- Repository settings such as branch protection, secret scanning, push
  protection, and required checks must be verified on GitHub after workflow
  files land; repository files cannot enable all of them.
- No compatibility aliases will be kept for the pre-release unversioned API.

## Next executable items

1. Enable the required checks, DCO, secret scanning, push protection, and code
   owner review in GitHub repository settings.
2. Run the six environment-gated OpenSandbox integration tests against the
   supported sandbox server and retain their logs.
3. Run the release workflow in dry-run mode on GitHub-hosted Linux to exercise
   multi-platform images, Trivy, SBOM, and provenance tooling.
4. Monitor the first merged CI and nightly stress runs; replay any property
   failure from its reported seed and path.
