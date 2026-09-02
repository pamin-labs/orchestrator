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

Measured on `fix/codex-login-home`, 2026-09-02.

- TypeScript, Oxlint, Biome: pass
- Tests: 2048 pass, 6 environment skips, 0 fail, 2054 across 253 files
- Coverage: 84.06% of statements, 74.34% of branches, 80.13% of functions
- Fallow audit against real coverage (`bun run audit:crap`): dead code 0,
  complexity 0, duplication 0, over 694 files
- Fallow security, full inventory: **1** candidate —
  `scripts/embedding-check.ts:126`, a non-literal URL passed to `fetch()` in a
  development script, not reached from any runtime entry point
- `bun run preflight`: every runnable step passed, 50s
- Block comments over eight lines: zero, enforced by
  `test/governance/comment-blocks.test.ts`
- All ten catalogues at 1135/1135
- Suite cost, measured on a ten-core machine: ~2.1 GB of system memory at peak
  and 16-24s wall clock, against 7.2 GB and 46s before this release. Recorded
  because it was a defect, not as a target: the same suite measures differently
  per machine, and a threshold on it would be a coin flip in CI
- The released version is not recorded here. `package.json` holds it, the tag
  proves it, and ADR 050 makes merging the bump the release — so a line here
  would be a third owner, stale from the next merge until somebody remembered

## Blockers and deviations

- **The first codex sign-in on a fresh install could not succeed.** The device
  login ran `codex login --device-auth` with `CODEX_HOME=/root/.codex-refresh`
  and nothing had ever created that directory — `writeLoginFiles` makes the decoy
  home, and the real one only appeared as a side effect of `seedHome`, which runs
  *after* a credential exists. codex 0.147.0 refuses to load its configuration on
  a CODEX_HOME that is not there, so it exited before printing a code and the
  panel reported a CLI whose output had changed. `prepareHome` is the one owner
  of a prepared home now, through the `CodexHomeIO` seam both paths already had,
  and a login that ends with a reason shows that reason instead of sending the
  boss into the image. The panel also opens codex's device page itself, as it
  already did for claude — neither container has a browser in it, so the
  difference was only that the tab was opened inside one branch. Fixed
  2026-09-02; guards in `test/mech/codex-device-login.test.ts` and
  `test/web/notes-settings-render.test.tsx`.
- **A sandbox key written to two homes could not converge.** `ourKey` stored it
  in `runtime_auth` and `writeConfig` wrote it into `~/.orch-cache/sandbox.toml`,
  which is never rewritten — so a rebuilt database against a still-running server
  meant 401 on every probe, no containers, and neither CLI able to sign in.
  `adoptServerKey` now takes the key back at boot from the running server's own
  `--config`, which is what the panel's `Read from server` button already did by
  hand. Fixed 2026-09-01; guards in `test/mech/sandbox-boot.test.ts`.
- **The login drove a terminal it had built out of a Python script.** A file in
  `/opt/orch` imported itself through `sys.path[0]`, outlived the server that
  wrote it, and ended each line with LF where Enter is CR — three defects in a
  terminal the daemon already offers. `src/mech/sandbox/pty.ts` speaks execd's
  pty-over-WebSocket instead, and is the only file that knows the wire format.
  Fixed 2026-09-02; [ADR 053](../adr/053-a-terminal-in-the-container-is-a-websocket.md),
  guards in `test/mech/codex-device-login.test.ts`.
- **A login stored a token nothing had ever asked the provider about.** A real
  sign-in printed `sk-ant-oat01-…` and what was stored began eight characters in.
  Measured: the stored value is refused by `/v1/models` and `/v1/messages`, the
  same value with `sk-ant-o` in front is accepted by both. No rule written
  against the text can tell a token from its tail — the provider can, and was
  never asked, so the panel said signed in beside a banner saying refused and
  both were honest. `finishClaudeLogin` runs the value through the credential
  banner's own probe before `saveAuth`. Which layer dropped those eight
  characters is **not** established: the pty splits on newlines only and the
  resize is measured to work (`stty size` reports `200 400`). Fixed 2026-09-02;
  guards in `test/mech/codex-device-login.test.ts`.
- **Six paths took a resource and none of them gave it back.** A container the
  reconnect could not reach, a retried create, a create that threw, the
  production pool (24 idle, the oldest untouched for five minutes), the suite's
  Postgres keeping every row it had ever deleted (635 MB in one database, its
  largest table holding 527,582 dead rows against zero live ones), and the
  integration smoke test booting the real server onto the developer's own sandbox
  server — one agent container and one egress container per full-suite run, and
  CI has nothing on 8080 so every one of those runs was green. Nine stranded
  containers were found by a machine running out of memory. Fixed 2026-09-02;
  `strandedCheck` reports them, and guards in
  `test/governance/a-test-boots-onto-nothing-real.test.ts`.
- **A fresh world per test file was what the suite's memory was.** `--parallel`
  implies `--isolate`, so all 253 files re-evaluated the module graph they
  import: 29-55 MB per file, flat across worker counts, ~7.2 GB at peak. The
  suite runs without it now. Five leaks isolation had been hiding were paid off
  to get there — happy-dom's network classes replacing Bun's, a catalog restored
  between tests where only the locale was, `startTheme` wiring a second keydown
  listener, a catalog emptied with a merging `load`, and a stubbed `matchMedia`
  deleted rather than put back. Fixed 2026-09-02; guards in
  `test/governance/preload-scope.test.ts`, and `bun run test:stress` — randomised,
  ten reruns, and no longer skipping the browser files — is what holds it.
- **Cancelling a login wedged every login after it, and a finished one waited on
  a stream that never ended.** The get-or-create slot was released in `done`'s
  `finally`, so an exec that ignored its abort left the slot held by a dead run;
  and `realLines` closed its queue when the SDK's `run()` settled, which on a
  live server it did not. The slot is released on `cancel()`, the stream ends on
  the stream, and the wait after a submit is bounded by `timeouts.loginVerdictMs`
  — the clock starts on the submit, so the boss's time in the browser is never
  timed. Fixed 2026-09-02; guards in `test/mech/codex-device-login.test.ts`.
- **Ctrl-C reported a clean shutdown as a failure.** `server.stop(false)` waits
  for every request to finish and an SSE request never does, so one open panel
  tab held the graceful phase to its full 10s deadline. `ctx.closing` aborts in
  `stopIntake` now. Measured end to end: exit 1 after 10.1s before, exit 0 in
  under a second after. Fixed 2026-09-01; guards in `test/http/stream.test.ts`.
- **Release archives offered scripts they could not run.** The development
  `package.json` shipped unchanged into an archive with no `scripts/`, `web/src`
  or `node_modules` — thirty-nine scripts, seven runnable, and `start` in the
  other set. `scripts/release-package-json.ts` rewrites it at package time and
  the release job checks every script's entrypoint exists in the archive. Fixed
  2026-09-01; guards in
  `test/governance/release-archive-runs-what-it-offers.test.ts`.
- **An unconfigured account was reported as twelve calls that said nothing,**
  hourly for a day, on an installation where `indexModel.runtime` was `codex` and
  only Claude had ever been signed in. An index pass asks nothing without a
  credential for its runtime. Fixed 2026-09-02.
- **CI's `test` job has been killed three times** — SIGTERM during
  `test:coverage:ci`, no named failure, on #40, #41 and #42, each time green on a
  rerun. Unexplained. It is the memory-heaviest job in the pipeline and this
  release cuts that job's peak by about 5 GB, which is the leading hypothesis
  rather than a diagnosis.
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
