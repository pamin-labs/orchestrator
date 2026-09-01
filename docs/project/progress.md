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

Measured on `fix/name-collisions-and-the-nightly-flake`, 2026-09-01.

- TypeScript, Oxlint, Biome: pass
- Tests: 2018 pass, 6 environment skips, 0 fail, 2024 across 253 files
- Coverage: 84.26% of statements, 74.58% of branches, 80.13% of functions
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

- **A sandbox key written to two homes could not converge.** `ourKey` stored it
  in `runtime_auth` and `writeConfig` wrote it into `~/.orch-cache/sandbox.toml`,
  which is never rewritten — so a rebuilt database against a still-running server
  meant 401 on every probe, no containers, and neither CLI able to sign in.
  `adoptServerKey` now takes the key back at boot from the running server's own
  `--config`, which is what the panel's `Read from server` button already did by
  hand. Fixed 2026-09-01; guards in `test/mech/sandbox-boot.test.ts`.
- **The login pty runner imported a module from its own directory.** Python puts
  a script's directory at `sys.path[0]`, so `/opt/orch/pty.py` imported itself
  and `claude setup-token` never started — reported as "the CLI needs a pty",
  which the login was supplying. Renaming it alone did not hold: `/opt/orch`
  outlives the server, so the old file stayed beside the new one and was found
  instead. Launched with `-P` now, which drops `sys.path[0]` whatever is in the
  directory. Fixed 2026-09-01; guard in `test/mech/login-pty-runner.test.ts`
  reproduces the stale file.
- **Release archives offered scripts they could not run.** The development
  `package.json` shipped unchanged into an archive with no `scripts/`, `web/src`
  or `node_modules` — thirty-nine scripts, seven runnable, and `start` in the
  other set. `scripts/release-package-json.ts` now rewrites it at package time
  and the release job checks every script's entrypoint exists in the archive.
  Fixed 2026-09-01; guards in
  `test/governance/release-archive-runs-what-it-offers.test.ts`.
- **Ctrl-C reported a clean shutdown as a failure.** `server.stop(false)` waits
  for every request to finish and an SSE request never does, so one open panel
  tab held the graceful phase to its full 10s deadline and `shutdownRuntime`
  returned 1. `ctx.closing` now aborts in `stopIntake` and the stream handler
  ends on it. Measured end to end: exit 1 after 10.1s before, exit 0 in under a
  second after. Fixed 2026-09-01; guards in `test/http/stream.test.ts`.
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
   reported seed and path. The 2026-08-31 failure is fixed: a test leaving work
   in flight committed after the reset's delete took its snapshot, and a blind
   `setval(seq, 1, false)` then wound the sequence back behind the survivor. The
   reset is `max(id) + 1` now, measured at 0.675ms more per call — about 1.1s
   over a suite of ~1694. The 2026-08-26 failure was a different step in the same
   job — `perf:bench` exiting 1 — and has not recurred in the five nightlies
   since; it is unexplained, not fixed.
3. **The `orch` CLI hang was fixed by mechanism, not by reproduction.**
   `readPiped` bounds the first byte on a non-tty stdin. If a command still
   hangs in a non-interactive parent, run it with `< /dev/null` first: the same
   hang there means stdin is not the cause and the search moves to the mailbox
   poll (`src/orch/cli.ts`, up to 20 minutes, silent).
4. **The `sha-*` staging tags on `ghcr.io/pamin-labs/orch-agent` cannot be
   deleted, and the panel filters them instead.** Measured: 21 tags over 9
   manifests, with `latest`'s index pointing at the manifests
   `sha-<commit>-<platform>` names and `sha-<commit>` sharing its digest with
   `latest`, `0.1.3` and `0.1.4`. GHCR deletes versions rather than tags, so
   removing any of them removes a release. Revisit only if the release flow
   stops needing a registry reference to assemble an index from.
