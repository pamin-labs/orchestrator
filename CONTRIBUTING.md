# Contributing

Thanks for improving Orchestrator. The project accepts focused bug fixes,
tests, documentation, performance evidence, and features that fit the current
[project plan](docs/project/plan.md).

By participating, follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report
security issues privately through [SECURITY.md](SECURITY.md), not an issue or
pull request. General help belongs in the channels in [SUPPORT.md](SUPPORT.md).

## Before changing code

Read in order:

1. [`docs/project/progress.md`](docs/project/progress.md)
2. [`docs/project/plan.md`](docs/project/plan.md)
3. [`AGENTS.md`](AGENTS.md)
4. affected architecture and standards from [`docs/README.md`](docs/README.md)
5. relevant [`docs/adr/`](docs/adr/)

Open an issue before a large feature, new public dependency, protocol break, or
architectural exception. Maintainers may decline work outside the active
milestone even when the implementation is sound.

## Development

Requires Bun and, for live sandbox tests, Docker plus `opensandbox-server`.

```bash
bun install --frozen-lockfile
bun run dev
bun run check
```

Use targeted tests while iterating and the complete gate before committing.
Live OpenSandbox tests report a skip when their server is unavailable; state
that limitation in the pull request instead of claiming the path passed.

The detailed task and agent workflow is in
[`docs/operations/development.md`](docs/operations/development.md). Keep changes
small, do not mix cleanup with behavior, and update documentation in the same
coherent change as a contract.

## Engineering rules

- Do not add a second enforcement owner beside the tools in the
  [enforcement matrix](docs/standards/enforcement-matrix.md). A replacement
  needs an ADR and migration evidence.
- New stored states update `src/contracts/states.ts`, the invariant table, and an
  executable repair/driver test.
- New UI behavior uses shadcn/Radix primitives when one exists.
- Product logic belongs here; commodity fixtures, mocks, retries, parsers,
  polling, serialization, metrics, and benchmark machinery follow the
  [dependency standard](docs/standards/dependencies.md). Reach for a popular,
  maintained library rather than another local wheel — it qualifies if it
  deletes project-owned code, tests or does the more correct thing, or supplies
  a capability we need now or plausibly later.
- Expected failures have stable codes; external I/O has cancellation, timeout,
  and safe contextual errors.
- English is used for code, comments, errors, branches, commits, and pull
  requests. Runtime output may follow the configured language.

## Before opening a pull request

`bun run preflight` runs every gate CI runs, in about twenty seconds, and says
which ones it could not run and why — a step that cannot run is reported as
*skipped with a reason*, never passed over silently.

There is nothing to install. The workflow lint runs from the same pinned
`rhysd/actionlint` image CI verifies, so it needs only the container runtime this
project already requires, and that image carries `shellcheck` — which a bare
`actionlint` binary does not, and without which it skips every shell rule without
saying so. A host `actionlint` is used when you happen to have one; asking each
contributor to install it would make the check silently absent for whoever did
not, and an absent check reads as a green one.

`security-codeql` and `pr-plan` have no local equivalent: the first runs on
GitHub's infrastructure, the second reads the pull request body. Filling in
`.github/pull_request_template.md` completely is what the second checks.

## Commits and DCO

Use a Conventional Commit prefix — `feat` `fix` `docs` `test` `refactor` `perf`
`build` `chore`, scoped to the module — and a subject that states the finding,
not merely the edit: `fix(sandbox): the skills mount was empty on macOS, and
nothing could say so`, not `fix(sandbox): update mount path`. The body explains
how the failure presented, why the fix belongs at that layer, and what was
deliberately left out; measurements beat adjectives. English throughout, and no
`🤖 Generated with` footer — the trailers below are the attribution.

Every human-authored commit carries a matching DCO sign-off:

```bash
git commit -s -m "fix(sandbox): the failed mount looked healthy"
git rebase --signoff main   # repair a branch before review
```

The [Developer Certificate of Origin](https://developercertificate.org/) means
you have the right to submit the contribution under this project's licence. It
is not a CLA and does not transfer copyright.

## Pull requests

One pull request should deliver one coherent outcome. Fill every plan field in
the template; use `N/A: reason` where a field truly does not apply. Include the
exact commands and relevant output proving the change, plus a rollback path.

CI is read-only and will not format, fix, or push your branch. Run formatting,
types, lint, tests, audit, and workflow checks locally as applicable. Respond to
review findings with a fix or an evidence-backed disposition. The merge remains
a maintainer decision under [GOVERNANCE.md](GOVERNANCE.md).
