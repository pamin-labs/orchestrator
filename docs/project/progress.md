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

Measured on `fix/ctrl-c-and-the-ticket-title`, 2026-08-31.

- TypeScript, Oxlint, Biome: pass
- Tests: 1997 pass, 6 environment skips, 0 fail, 2003 across 248 files
- Coverage: 84.00% of statements, 74.26% of branches, 79.90% of functions
- Fallow audit against real coverage (`bun run audit:crap`): dead code 0,
  complexity 0, duplication 0
- Fallow security, full inventory: **1** candidate —
  `scripts/embedding-check.ts:126`, a non-literal URL passed to `fetch()` in a
  development script, not reached from any runtime entry point
- `bun run preflight`: every runnable step passed
- Block comments over eight lines: zero, enforced by
  `test/governance/comment-blocks.test.ts`
- All ten catalogues at 1130/1130
- The released version is not recorded here. `package.json` holds it, the tag
  proves it, and ADR 050 makes merging the bump the release — so a line here
  would be a third owner, stale from the next merge until somebody remembered
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

1. **M7 is the active milestone** — executable engineering governance and
   versioned protocol. Its remaining scope is the delivery sequence in
   [`plan.md`](plan.md), which owns that list; this file records only what has
   been measured against it.
2. **Watch the nightly stress run** and replay any property failure from its
   reported seed and path. Green on the last three runs; one failure on
   2026-08-26.
3. **A group name that collides answers 500.** `(project_id, name)` is unique,
   `newGroup` has no retry and `src/http/handler.ts` has no 23505 mapping, so two
   ideas that slug the same fail at the shared insert. Pre-dates the title
   writer and is unaffected by it; the fix belongs at `newGroup`, which all four
   creation paths go through.
4. **The `orch` CLI hang was fixed by mechanism, not by reproduction.**
   `readPiped` bounds the first byte on a non-tty stdin. If a command still
   hangs in a non-interactive parent, run it with `< /dev/null` first: the same
   hang there means stdin is not the cause and the search moves to the mailbox
   poll (`src/orch/cli.ts`, up to 20 minutes, silent).
5. **The `sha-*` staging tags on `ghcr.io/pamin-labs/orch-agent` cannot be
   deleted, and the panel filters them instead.** Measured: 21 tags over 9
   manifests, with `latest`'s index pointing at the manifests
   `sha-<commit>-<platform>` names and `sha-<commit>` sharing its digest with
   `latest`, `0.1.3` and `0.1.4`. GHCR deletes versions rather than tags, so
   removing any of them removes a release. Revisit only if the release flow
   stops needing a registry reference to assemble an index from.
