# CI operations

CI is read-only verification. It does not format, fix, commit, push, or rewrite
a contributor branch.

## The required-check list

`.github/required-checks.txt` is the single source. `release.yml` reads it, and
`test/governance/workflows.test.ts` fails if a `ci.yml` job is missing from it —
a job that runs but is not required is a check nobody has to pass.

The branch ruleset is a GitHub setting and cannot read a file, so it is pushed:

```bash
gh api -X PUT repos/pamin-labs/orchestrator/rulesets/20892179 \
  --input <(gh api repos/pamin-labs/orchestrator/rulesets/20892179 | jq \
    --slurpfile checks <(cat .github/required-checks.txt .github/merge-only-checks.txt \
      | grep -vE '^\s*(#|$)' | jq -R '{context: .}' | jq -s .) \
    '(.rules[] | select(.type == "required_status_checks")
       | .parameters.required_status_checks) = $checks[0]')
```

Both files, and only here. `release.yml` reads `required-checks.txt` alone,
because it asserts each name is green among the **check runs of the release sha**
and a name that only ever appears on a pull request head would block every
release. That is what `merge-only-checks.txt` is for.

Export the current ruleset before changing it — `docs/operations/snapshots/`
holds the last one — because a wrong list here blocks every merge, and the
failure mode is a pull request that waits forever on a context nothing posts.
That is not hypothetical: this repository shipped a ruleset requiring a check
named `check` that no job has ever produced.


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

## What a pull request pays for

Actions bills per job, rounded up to the whole minute, so the shape of the run is
a cost decision. Three things hold it down, and each has a failure mode worth
knowing before changing it.

**Every job carries `timeout-minutes`.** They inherited the six-hour default
until this was added; one wedged `bun test` or a hung registry pull would have
billed 360 minutes on its own.

**`bun install` is cached** in `.github/actions/setup-bun`, keyed on
`hashFiles('bun.lock')`. It runs in four jobs per pull request and was cold in
all four.

**`security-container` and `workflow-static` are gated on what changed**, by a
`changes` job they `needs:` — not by `paths-ignore` on the workflow. The
difference is the whole point: a workflow that never fires produces no check run
at all, and a required context that never posts leaves the pull request pending
forever, which is the `check` bug described above. A job skipped by an `if`
still completes, as `skipped`, and the merge gate accepts that.

Two rules that look like details and are not:

- The gates ask `!= 'false'`, not `== 'true'`, under an `always()`. An unset
  output is therefore "run it". A filter that breaks in any way keeps the security
  checks on rather than silently dropping two of them.
- **Outside a pull request the filter is bypassed and every gate runs.**
  `release.yml` demands `completed:success` from every name in
  `.github/required-checks.txt` for the commit it releases, and `skipped` is not
  `success` — so a docs-only commit that skipped a gate on `main` would be
  unreleasable.

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

`codecov/patch` is a **check run**, not a commit status — measured on `2ac8b99`,
where `commits/<sha>/check-runs` lists it `success` and `commits/<sha>/status`
returns an empty array. That empty array is why this was recorded for weeks as
"Codecov has never uploaded"; the upload had been succeeding all along, and the
probe was reading the wrong table.

It is still not a release gate, for a different reason than the one written here
before: `pr-report.yml` uploads only on a pull request, so no `main` commit ever
carries it. Hence `merge-only-checks.txt`. `test` is in the release list and
covers the "did the coverage job run green" half.

## Failure handling

Reproduce the named job locally when a script exists. Do not rerun a deterministic
failure without changing input. Treat a flaky/randomized failure as a defect:
record its seed/path/order and replay before changing the test. A GitHub outage or
registry timeout may be retried once the external state changes; it is not fixed
by reducing permissions or skipping the check.

After workflow changes, separately verify repository rulesets, required-check
names, secret scanning, push protection, and merge policy in GitHub settings.
