# Governance

Orchestrator is maintained by Pamin Labs with public design and review evidence.
The current maintainers listed by [`.github/CODEOWNERS`](.github/CODEOWNERS)
have merge, release, and security-response authority.

## Decisions

- Small bug fixes and documentation changes are decided in pull-request review.
- Large features, new dependencies, public protocol changes, and architectural
  exceptions start with an issue and, when accepted, an ADR.
- ADRs record evidence, decision, consequences, and revisit conditions. An
  accepted ADR outranks a standard; executable enforcement must be updated in
  the same change.
- The active scope and milestone are public in
  [`docs/project/plan.md`](docs/project/plan.md) and
  [`docs/project/progress.md`](docs/project/progress.md).

Maintainers seek technical consensus but may make the final call when security,
compatibility, maintenance cost, or the active milestone requires it. A decision
is explained in the issue, pull request, or ADR; silence is not acceptance.

## Contributions and ownership

Anyone may propose or review a change. CODEOWNERS requests the responsible
maintainer; it does not grant exclusive authorship. Authors must satisfy the DCO,
CI, review, and documentation requirements in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Maintainers may edit, close, or defer work
that is unsafe, duplicative, out of scope, abandoned, or lacks a viable rollback.

## Releases and security

Maintainers select a verified `main` SHA and follow the immutable
[release procedure](docs/operations/release.md). Published artifacts are not
replaced. The security response is private until coordinated disclosure under
[`SECURITY.md`](SECURITY.md).

Governance changes use the same public pull-request process and require approval
from `@pamin-labs/core`.
