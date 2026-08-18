# Development workflow

## Start a task

Read `docs/project/progress.md`, `docs/project/plan.md`, affected architecture
and standards, then relevant ADRs. For non-trivial work, record every field:

```text
Affected boundaries
Current invariants
Data/control flow
Public API impact
Persistence/migration impact
Failure semantics
Async/concurrency impact
Security/trust boundaries
Performance/observability impact
Compatibility strategy
Test strategy
Rollback
```

Use `N/A: reason` when a field does not apply. An empty field is not a plan.

Before editing, inspect the current call/data flow and run Fallow guard for the
touched paths. For parallel work, give agents mutually exclusive file ownership,
minimum tool permissions, targeted validation, and a required `PASS/FAIL +
file:line + evidence` response. Only the integrating agent stages, commits, and
runs the full suite.

## Deliver a coherent slice

```bash
bun install --frozen-lockfile
bunx fallow guard <changed-files>
# edit the smallest coherent behavior
bun run typecheck
bun run lint
bun run test test/affected.test.ts
bun run test
bun run audit
git diff --check
```

`bun run audit` scores CRAP as if nothing were covered, because it has no
coverage map to read. A complexity finding it reports is therefore a question,
not a verdict: `bun run audit:crap` measures coverage first and scores against
it. A function can sit at CRAP 90 estimated and zero findings exact — check
before refactoring around one.

Then run Fallow Review and independent architecture/API, security, test-quality,
and performance review for affected dimensions. Review the final diff, update
`docs/project/progress.md` once for the verified unit, and create a small commit.

At a milestone run:

```bash
bun run check
bun run typecheck:clean
bun run test:stress
```

If a command fails, preserve the full error, reduce to the smallest reproducer,
and fix the shared entrypoint or invariant. Do not weaken a gate, add a sleep, or
mark a test skipped to make the signal disappear. If environment-only live tests
cannot run, record the exact prerequisite and leave their status open.
