# Project progress

Read this file first when resuming work. It is a **snapshot**: replace the
section a verified unit changes rather than appending to it, and never prepend
above this title. The narrative — what the failure looked like, what was
measured, what was deliberately not taken — belongs in the commit body, in ADRs,
and in [`archive/`](archive/). `test/governance/progress-stays-current-state.test.ts`
caps this file's length, because the same policy was written here in prose and
the file reached 3362 lines anyway.

Product goals, scope, milestones and the delivery sequence live in
[`plan.md`](plan.md). This file carries measured status only.

## Baseline

Measured on `docs/progress-had-become-the-archive-again`, 2026-08-30.

- TypeScript, Oxlint, Biome: pass
- Tests: 1959 pass, 6 environment skips, 0 fail, 1965 across 240 files
- Coverage: 83.64% of statements, 73.95% of branches, 79.28% of functions,
  86.13% of lines
- Fallow audit against real coverage (`bun run audit:crap`): dead code 0,
  complexity 0, duplication 0
- Fallow security, full inventory: **1** candidate —
  `scripts/embedding-check.ts:126`, a non-literal URL passed to `fetch()` in a
  development script, not reached from any runtime entry point. It was 40 when
  this line last had a number
- Block comments over eight lines: zero, enforced by
  `test/governance/comment-blocks.test.ts`
- Released: `v0.1.4`, 2026-08-30, under
  [ADR 050](../adr/050-the-bump-merging-is-the-release-request.md)
- Test time is not recorded as a target. The same suite measures differently per
  machine, and a threshold on it would be a coin flip in CI

## Blockers and deviations

- **Live OpenSandbox tests are environment-gated** and skip without a running
  sandbox server. That is the six skips in the count above.
- **Repository settings are not repository files.** Branch protection, secret
  scanning, push protection and required checks are verified on GitHub after
  workflow files land. Verified 2026-08-30: the ruleset requires the eight
  contexts in [`.github/required-checks.txt`](../../.github/required-checks.txt)
  plus `codecov/patch` from
  [`.github/merge-only-checks.txt`](../../.github/merge-only-checks.txt), with
  `require_code_owner_review` on.

## Rollback records

- **`main` branch ruleset**, `gh api repos/pamin-labs/orchestrator/rulesets/20892179`.
  It requires the eight contexts in
  [`.github/required-checks.txt`](../../.github/required-checks.txt) — `quality`,
  `test`, `pr`, `security-fallow`, `security-dependencies`, `security-container`,
  `workflow-static`, `security-codeql` — plus `codecov/patch`, with
  `require_code_owner_review` on and deletion and non-fast-forward protection.

  The file is the single source; a list transcribed into prose drifts, which is
  how this record once said fourteen.

  To roll back: `gh api --method PUT repos/pamin-labs/orchestrator/rulesets/20892179
  --input <copy>` from a snapshot taken outside the repository. Worth knowing
  before it is needed, because a bad ruleset blocks everybody's merges at once.
  A snapshot is in [`../operations/snapshots/`](../operations/snapshots/).

## Next executable items

The three items that stood here are done and their evidence is in
[`archive/2026-08.md`](archive/2026-08.md): the first release is cut,
`codecov/patch` is enforced, and schema-level test isolation shipped.

1. **M7 is the active milestone** — executable engineering governance and
   versioned protocol. Its remaining scope is the delivery sequence in
   [`plan.md`](plan.md), which owns that list; this file records only what has
   been measured against it.
2. **Watch the nightly stress run** and replay any property failure from its
   reported seed and path. Green on the last three runs; one failure on
   2026-08-26.
3. **Windowing for the four lists that were capped to hide that nothing
   windowed them** — the gate transcript is 4000 server-capped rows rendered as
   4000 DOM nodes, and its filter box re-renders all of them per keystroke.
