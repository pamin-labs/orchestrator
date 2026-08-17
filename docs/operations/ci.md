# CI operations

CI is read-only verification. It does not format, fix, commit, push, or rewrite
a contributor branch.

## Required jobs

```text
quality-format
quality-types
quality-oxlint
quality-fallow
test-main
build-web
security-codeql
security-fallow
security-dependencies
security-container
workflow-static
dco
pr-plan
```

Jobs install from the frozen lockfile, use a pinned Bun version, and pin external
actions to immutable commit SHAs. The local setup action removes repeated Bun
installation without hiding checkout or job policy. Fork pull requests receive
read permissions only and no repository secrets. Fallow analyzes once, preserves
the audit verdict, and re-renders that JSON as log annotations and the job
summary without pull-request write permission.

`pr-plan` applies to non-bot pull requests and requires the 12 plan fields from
the pull-request template. `N/A: reason` is valid; blank fields fail. `dco`
requires a matching `Signed-off-by` trailer for each human-authored commit.

Security ownership follows the
[`enforcement matrix`](../standards/enforcement-matrix.md): CodeQL, Fallow
security, `bun audit`, Dependency Review, Trivy, actionlint, and zizmor each
answer a distinct question. Fallow scans the complete official candidate
catalogue, including the two opt-in secret categories. Pull requests fail only
for a newly reachable candidate; the nightly job inventories the full backlog
for verification rather than declaring candidates to be vulnerabilities.
Dependabot proposes dependency and action updates for ordinary review.

Actionlint runs its attested release binary after verifying the pinned checksum;
zizmor runs at an exact version through the pinned uv setup action. Statistical
microbenchmarks and randomized stress run nightly. Pull requests retain only
deterministic bundle and artifact budgets.

## Failure handling

Reproduce the named job locally when a script exists. Do not rerun a deterministic
failure without changing input. Treat a flaky/randomized failure as a defect:
record its seed/path/order and replay before changing the test. A GitHub outage or
registry timeout may be retried once the external state changes; it is not fixed
by reducing permissions or skipping the check.

After workflow changes, separately verify repository rulesets, required-check
names, secret scanning, push protection, and merge policy in GitHub settings.
