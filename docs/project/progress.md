# Project progress

Read this file first when resuming work. Update it after a verifiable unit, not
after each edited file. Historical implementation narrative belongs to Git
history, release notes, and ADRs.

## Current milestone

M7 — executable engineering governance and versioned protocol.

## Baseline

- Branch: `refactor/api-split-and-settings`
- SHA: `179f0c4655daa6e71fad696500da82e581b7f931`
- Baseline `bun run check`: pass
- Baseline tests: 772 pass, 6 skip, 0 fail across 88 files
- Baseline test time: 13.84 seconds
- Baseline Fallow: 7 unused type exports, 8 private type leaks, 1 unused class
  member, 3 production imports from dev dependencies, no duplication finding

## Verified complete

- Hono route schemas feed typed handlers and generated browser/CLI clients.
- External JSON is validated before entering business code.
- Group sandboxes, file mailbox transport, and credential vault boundaries are
  implemented and covered by live tests when OpenSandbox is available.
- GitHub is the project source; host Git is not part of runtime operation.
- `src/states.ts` and executable invariants cover stored lifecycle states.
- Existing full quality chain is green at the baseline SHA.
- Governance work is isolated in `codex/engineering-governance` under a separate
  worktree.
- Project plan and progress responsibilities moved under `docs/project/` and
  were reduced to active product state; TypeScript and 772 tests remain green.
- `AGENTS.md` is now the real engineering entrypoint, `CLAUDE.md` is its
  compatibility link, and a source guard prevents legacy documentation paths;
  TypeScript and 773 tests are green.
- The engineering constitution is split across architecture, standards,
  operations, and ADR documents; PR plans carry the required change-radius,
  failure, security, compatibility, test, and rollback evidence.
- TypeScript project references, type-aware Oxlint, and a 16-zone Fallow DAG
  have non-overlapping ownership. Fallow reports zero deterministic dead-code,
  complexity, duplication, boundary, cycle, coverage, or private-leak findings.
- `/api/v1/*` and `/orch/v1/*` are the only protocol surfaces. Typed client
  contracts include middleware errors and durable idempotency discovery,
  inspection, and operator recovery without re-running an unknown side effect.
- Cancellation, durable correlation, transactional state/evidence writes,
  after-commit event fan-out, health/readiness/metrics, and graceful shutdown
  are implemented with focused failure-path tests.
- CI is read-only and separates type, lint, architecture, tests, security,
  workflow, ownership, and PR-plan gates. Releases bind a verified `main` SHA to
  immutable binaries/images, checksums, SBOMs, provenance, and an atomic tag.
- Final `bun run check`: 825 pass, 6 environment skips, 0 fail in 8.96 seconds.
  Final three-run median is 8.94 seconds, 35.40% faster than the 13.84-second
  baseline. Nightly stress passed 8,170 tests twice with seeds `272027580` and
  `1349770149`.
- Clean TypeScript build, performance budgets, Fallow audit, and graph-pinned
  Fallow Review all pass; the review accepted four anchored decisions with no
  rejected or stale judgments.
- Architecture/API, security/reliability, and test/performance reviewers report
  no reproducible P0 or P1 findings. Actionlint and zizmor report no workflow
  findings after the final release-order fix.

## Blockers and deviations

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
