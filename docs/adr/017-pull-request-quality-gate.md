# 017 The merge gate is changed-line coverage

**Status**: accepted
**Date**: 2026-08-17

Thirteen quality jobs ran on every pull request and reported only into their own
logs. A global coverage percentage is the wrong gate — `docs/standards/testing.md`
says so, and ratcheting one teaches contributors to add tests to whatever is
cheapest. The answerable question is whether the lines this change touched were
tested.

Codecov owns coverage reporting and the gate: `patch` can fail, `project` is
informational. `ci` keeps `contents: read` and no job-level permissions and only
uploads artifacts; a `workflow_run` job posts, because `pull_request` can never
grant `pull-requests: write` to a fork. It executes nothing from those
artifacts. Coverage numbers live only in Codecov's own comment; ours carries test
results, Fallow findings and size budgets.

**Consequence**: `codecov/patch` is a commit status, so it can never appear in
the `check-runs` response `release.yml` reads. It blocks merge, not release;
`test-coverage` covers the release side. That list of required checks now exists
in three places and is a known drift source.
