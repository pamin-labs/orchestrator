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
- New stored states update `src/states.ts`, the invariant table, and an
  executable repair/driver test.
- New UI behavior uses shadcn/Radix primitives when one exists.
- Product logic belongs here; commodity fixtures, mocks, retries, parsers,
  polling, serialization, metrics, and benchmark machinery follow the
  [dependency standard](docs/standards/dependencies.md). A mature library that
  materially deletes project-owned code is preferable to another local wheel.
- Expected failures have stable codes; external I/O has cancellation, timeout,
  and safe contextual errors.
- English is used for code, comments, errors, branches, commits, and pull
  requests. Runtime output may follow the configured language.

## Commits and DCO

Use a Conventional Commit prefix and a subject that states the finding, not
merely the edit. Explain how failure presented and why the fix belongs at this
layer. Follow [`.claude/skills/git-commit/SKILL.md`](.claude/skills/git-commit/SKILL.md).

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
