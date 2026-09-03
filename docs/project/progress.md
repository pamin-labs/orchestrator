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

Measured on `fix/a-retry-inside-a-transaction-needs-a-savepoint`, 2026-09-03.

- TypeScript, Oxlint, Biome: pass
- Tests: 2056 pass, 7 environment skips, 0 fail, 2063 across 254 files
- Coverage: 84.06% of statements, 74.34% of branches, 80.13% of functions
- Fallow audit against real coverage (`bun run audit:crap`): dead code 0,
  complexity 0, duplication 0, over 694 files
- Fallow security, full inventory: **1** candidate —
  `scripts/embedding-check.ts:126`, a non-literal URL in a development script,
  not reached from any runtime entry point
- `bun run preflight`: every runnable step passed, 50s
- Block comments over eight lines: zero, enforced by
  `test/governance/comment-blocks.test.ts`
- All ten catalogues at 1135/1135
- Suite cost, measured on a ten-core machine: ~2.1 GB of system memory at peak
  and 16-24s wall clock, against 7.2 GB and 46s before this release. Recorded
  because it was a defect, not as a target — the same suite measures differently
  per machine
- The released version is not recorded here. `package.json` holds it, the tag
  proves it, and ADR 050 makes merging the bump the release — so a line here
  would be a third owner, stale from the next merge until somebody remembered

## Blockers and deviations

- **A name collision failed every group filed after it.** `newGroup` retries under
  a suffixed name, and Postgres aborts the whole transaction on a constraint
  violation — so inside a caller's transaction the retry's insert answered
  `current transaction is aborted, commands ignored until end of transaction
  block`, from the insert itself. Both callers that create several groups at once
  wrap the lot in one transaction: `orch task split` loops over the items, and the
  escalation that opens a requirement does it beside the turn it enqueues. Each
  attempt now runs in a savepoint (`attempt()`, a transaction when there is none
  open and a savepoint when there is, sharing the outer `onCommit` so an event
  still belongs to the outer commit). Fixed 2026-09-03; the guard reproduces the
  reported sentence verbatim with the savepoint removed.

- **Every index call carried three things it never opened.** Measured against
  codex 0.147.0 in this image, the same 1,631-byte prompt: **21,513 input tokens
  as shipped, 9,980 with three documented `-c` keys** — the bundled skills
  catalogue (−5,169), this repository's 15,122-byte `AGENTS.md` (−3,600) and a
  web-search tool (−2,456), for a call that reads a file head and writes one line
  under twenty words. `--ignore-rules` and `--ignore-user-config` are not the
  lever they look like — execpolicy `.rules` and `config.toml` respectively,
  21,513 either way — and `agents.enabled=false` measured zero. Turns keep web
  search; `allowedTools` still decides which roles may look things up. Fixed
  2026-09-03. And the index event now carries `cacheRatio`, which the shape it
  claimed to imitate has always had: twelve index rows a tick against a handful
  of turns is the sample `recentCacheRatio` reads, so the panel's figure was an
  average over whatever else was in it, drawn beside a row saying the indexer is
  the whole of the spend. **Not done**: the claude side of the same call measures
  **76,916** input tokens against codex's 21,513, and its trim is unmeasured.
- **A command that exits took its own output with it, so PageIndex never built.**
  `wrapForSession` redirects each stream to a file and reads both back, and the
  command sat in a brace group — `exit` inside one ends the *session* every caller
  in that container shares, before the two `cat`s run. The caller got exit 0 and
  two empty strings, which is a command that succeeded silently. `modelAsk` sends
  `codex … < prompt; rc=$?; rm -f prompt; exit $rc`, so every index call came back
  empty; the turn path sends the same shape and was spared only because
  `execLines` never uses the session. Measured through `execIn`: `echo hello` gave
  `hello`, `echo hello; rc=$?; exit $rc` gave `""`, and the same command forced
  one-shot gave `hello`. A subshell fixes it and stops a caller's `cd` leaking
  into the next command. The wrapper's own trailing `exit` had been a subshell
  since it ended the session once — the bug class was fixed in one of its two
  places. Fixed 2026-09-03; guard runs the wrapper through a real bash, because
  the defect was that the shell did something other than what the string looked
  like.

- **The index navigator's circuit breaker had no way back.** `record` clears the
  count only on a success and `tripped` returns before the call that could produce
  one, so the one thing that reopens it sat behind the door it locked — the only
  accidental way out was changing the model or the runtime, which changes the key.
  Measured live: tripped while codex had no credential, codex signed in at 14:04,
  still returning an empty string twelve times a tick at 00:50 under a panel
  sentence blaming an account that was fine. The count now carries the credential
  stamp the two index warnings already key on, and `index.ask` — which set ERROR
  only on a non-zero exit — now says what the CLI said when the answer is empty,
  which is how the cause below was found. Fixed 2026-09-03; guard in
  `test/mech/index-breaker.test.ts`.
- **Every claude turn ended `no_result` with the CLI's own refusal as its text.**
  The container runs as root — no `USER` in the image, `HOME` is `/root`, every
  path the orchestrator writes under it — and claude-code will not accept
  `--dangerously-skip-permissions` there. Read out of the pinned 2.1.233 binary
  rather than the docs, which do not mention the variable:
  `getuid()===0 && IS_SANDBOX!=="1" && !CLAUDE_CODE_BUBBLEWRAP` is the whole
  condition. The turn env sets `IS_SANDBOX=1`, which is true — ADR 005 makes the
  container the boundary — where dropping root would have moved `/root/.claude`,
  `/root/.codex`, `/root/.gitconfig`, `/work` and the mailbox to satisfy a check
  about a boundary that already exists. codex has no equivalent refusal: its
  0.147.0 binary carries no such string. Fixed 2026-09-03; guard in
  `test/application/executor.test.ts`, which pins the flag and the variable
  together because either can be dropped without the other noticing — and nothing
  pinned the claude flag at all, where codex's twin was pinned.

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
- **The stress job had never run a browser test.** Its document exclusion was
  removed and its glob was not — `test/**/*.test.ts` does not match `*.test.tsx`,
  so all 38 stayed out of the one job that hunts cross-file order dependence,
  under a comment saying they no longer were. Correcting the glob reproduced CI's
  `RangeError: Maximum call stack size exceeded` locally on the first run:
  `bundle-boots` mounts the panel into a shared document and
  `createRoot(...).render()` discarded the handle, so Radix's `document`-level
  focus scopes outlived `body.innerHTML = ""`. `main.tsx` names its root and the
  test unmounts it. Fixed 2026-09-03. **Not** proved: that the unmount is the
  fix — it reproduced once and eight targeted attempts since have not.
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
