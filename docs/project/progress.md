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

Measured on `chore/release-0.1.9`, 2026-09-03.

- TypeScript, Oxlint, Biome: pass
- Tests: 2088 pass, 7 environment skips, 0 fail, 2095 across 255 files
- Coverage: 84.38% of statements, 74.66% of branches, 80.47% of functions
- Fallow audit against real coverage (`bun run audit:crap`): dead code 0,
  complexity 0, duplication 0
- Fallow security, full inventory: **1** candidate —
  `scripts/embedding-check.ts:126`, a non-literal URL in a development script,
  not reached from any runtime entry point
- `bun run preflight`: every runnable step passed, 44s
- The suite starts its own PostgreSQL from `node_modules`, so it runs where an
  agent runs — no Docker. 1.0s to a usable database on macOS, 1.6s in the agent
  image as root ([`054`](../adr/054-the-suite-brings-its-own-postgres.md))
- Block comments over eight lines: zero, enforced by
  `test/governance/comment-blocks.test.ts`
- All ten catalogues at 1150/1150
- Suite cost, measured on a ten-core machine: ~2.1 GB of system memory at peak
  and 16-24s wall clock, against 7.2 GB and 46s before 0.1.8. Recorded
  because it was a defect, not as a target — the same suite measures differently
  per machine
- The released version is not recorded here. `package.json` holds it, the tag
  proves it, and ADR 050 makes merging the bump the release — so a line here
  would be a third owner, stale from the next merge until somebody remembered

## Blockers and deviations

- **A branch told to rebase once was never looked at again.** Watchdog rule 15
  nudges once per movement of the base (`rebase_seen`) and stopped measuring
  there, so an Engineer that ignored the nudge or failed the rebase looked the
  same as one that had done it, and the panel had no distance to show and no
  button to press. The rule now records `git rev-list --left-right --count` into
  `grp.base_ahead`/`base_behind` every tick — one 5ms session exec per running
  group, replacing the `merge-base --is-ancestor` it used to run — and the
  requirement header draws `↑n ↓m main` with a **Rebase onto main** button
  (`POST /groups/:id/sync`) that re-sends the same nudge through the same
  helpers in `src/mech/flow/rebase.ts`; a group still behind `nudgeReemitMs`
  after it was told is told again. The three hand-written copies of that
  nudge — watchdog, `landGroup`, PR conflict — are one `queueRebase` now, and
  `landGroup`'s lacked `conflict: true`, so the watchdog sent a second turn for
  the same movement. Fixed 2026-09-03; guards in `test/mech/watchdog.test.ts`,
  `test/mech/prwatch.test.ts` and `test/api/api.test.ts`.

- **The 2026-09-03 nightly failed two stress tests that nothing local repeats.**
  The theme hotkey walked two steps per press in all ten runs of its file, and
  the `span` row-cap probe chose Seq Scan + Sort in the first two of ten. The
  same seed (3515241165) over the same files passes here. Two hardenings, both
  named as such: the hotkey handler stands down on a chord another listener
  already claimed (`defaultPrevented`), and the probe vacuums before it asks,
  since an index-only scan is costed against the visibility map. Not proved:
  that either is the cause. Watch the next nightly.

- **The index dropped the oldest notes without saying so.** `noteLeaves` took the
  newest 500 at a hard-coded literal, and the tree is rebuilt from that list every
  pass — so a note past it does not page out, it leaves the index and stops being
  findable, on a blackboard that only grows. It is `pageindex.notes` now, and a
  pass that leaves anything behind says once how many and where to raise it. The
  stamp also covered files the index does not carry, so touching a lockfile woke a
  pass that loaded the tree and did nothing. Guards in `pageindex`, `server-policy`.

- **The index was losing ground, not catching up.** 822 nodes, 61 summarised down
  to 48, the indexer's bill 2.9M to 23.3M tokens. Seven findings, one subsystem: a
  node the pass could not answer for was blanked on all three exits and the
  emptiness climbed a level per tick, and a pass that spent its budget was never
  stamped fresh, so every tick rebuilt from a checkout. What counts as changed is
  git's blob hashes now; a pass reads only what it will summarise (1,159,899 bytes
  a tick to ~95,000) and sees the whole file up to 30,000 where an 1800-character
  head covered 17%. [#63](https://github.com/pamin-labs/orchestrator/pull/63).

- **The panel never rendered the Markdown its agents write.** Cards, journal
  entries and escalations are Markdown by ADR 016 and all of it reached the boss
  as source: `## Goal` over a column of `-`, `| --- |` where a table was. The
  plan card is now `@uiw/react-md-editor`, source and preview side by side and
  scrolling together, the right half read-only; every read-only surface goes
  through one `Markdown` component over markdown-it, `html: false`, since agent
  text is rendered through `dangerouslySetInnerHTML`. Both wear `.wmde-markdown`
  and both highlight code — the editor's Prism, markdown-it's highlight.js — on
  one palette under two class vocabularies, anchored at `html[data-color-mode]`
  since the library's own `[data-color-mode*=dark] .wmde-markdown-var` outranks a
  plain one. `web/dist` 2.33 MB → 3.67 MB. Guards `markdown-render`, `theme-boot`.

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
