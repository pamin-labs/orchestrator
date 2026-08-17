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
test-coverage
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
deterministic artifact budgets.

## Pull request report

`ci` produces evidence; `pr-report` publishes it. The split exists because `ci`
runs on `pull_request`, and a fork pull request cannot be granted
`pull-requests: write` under that trigger. Adding the permission to `ci` would
either fail on forks or require running fork code with write access. So `ci`
stays at `contents: read` with no job-level permissions and uploads artifacts,
and `pr-report` runs from the base repository on `workflow_run` with the
permissions it needs.

Every artifact is a `$RUNNER_TEMP/report` directory uploaded with `if: always()`,
so a red job still reports:

```text
report-tests     junit.xml            pr-number.txt   from test-main
report-coverage  lcov.info            pr-number.txt   from test-coverage
                 coverage-final.json
report-fallow    fallow-audit.json    pr-number.txt   from quality-fallow
report-budget    budget.txt           pr-number.txt   from build-web
```

`workflow_run` carries no pull-request number for a fork, so each artifact
carries `pr-number.txt`. `pr-report` reads it back and skips cleanly when the
triggering run was not a pull request or produced no artifacts.

`pr-report` uploads `lcov.info` and `junit.xml` to Codecov over OIDC
(`use_oidc: true`, no `CODECOV_TOKEN`), then maintains one sticky comment
keyed on the `pr-report` header, updated in place for each new commit. That
comment carries test pass/fail/skip counts, duration, failing test names, Fallow
finding counts by category, and the release archive budget. It deliberately carries
no coverage number: Codecov's own comment owns that, and two comments answering
the same question is worse than one. Artifact bytes are fork-controlled, so
nothing from them is executed and backticks are stripped before rendering.

`codecov.yml` makes `patch` the only failing status and leaves `project`
informational, because `docs/standards/testing.md` treats a coverage percentage
as a non-goal. The question is whether the changed lines were tested, not
whether a global number went up. `patch.target` is 65%, set below the whole-repository
statements figure measured with `bun run test:coverage` at the time it was chosen
(76.31% statements, 67.25% branches, 69.31% functions, 78.97% lines). Patch
coverage itself is computed by Codecov against the diff and cannot be measured
locally, so the first target is a floor the current codebase clears rather than a
number derived from past patches. Tighten it from observed patch results once
several pull requests have reported, and record each tightening in
`docs/project/progress.md`.

`codecov/patch` is a commit status, not a check run. `release.yml` gates on
`repos/OWNER/REPO/commits/$SOURCE_SHA/check-runs`, where a commit status can
never appear, so `codecov/patch` blocks pull-request merge only and is not a
release gate. `test-coverage` is in the release required-check list and covers
the "did the coverage job run green" half.

## Failure handling

Reproduce the named job locally when a script exists. Do not rerun a deterministic
failure without changing input. Treat a flaky/randomized failure as a defect:
record its seed/path/order and replay before changing the test. A GitHub outage or
registry timeout may be retried once the external state changes; it is not fixed
by reducing permissions or skipping the check.

After workflow changes, separately verify repository rulesets, required-check
names, secret scanning, push protection, and merge policy in GitHub settings.
