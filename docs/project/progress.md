- **The live-sandbox `126` is diagnosed and fixed.** It reproduced once the probe
  stopped discarding its output, and named itself immediately:
  `code=126 out= err=container unavailable: Egress sidecar container failed to
  start.` — `126` is this repository's own `EXEC_UNAVAILABLE`, not a shell's
  "cannot execute". `data/opensandbox-server.log` has the cause five times over:
  the server draws a random host port for the egress sidecar without checking it,
  so two containers starting together collide on
  `failed to bind host port 0.0.0.0:57714/tcp: address already in use`. A turn
  died whenever Docker picked a busy port.

  Retried once in `createMountedSandbox`, which is safe precisely there: `remember`
  runs after it returns, so a failed create leaves no group pointing at a
  container. The classifier matches the message the *client* is handed, not the
  Docker text — that stays in the server's log, and a classifier written against
  it would have retried nothing. Three live runs green since; two earlier
  hypotheses (slow boot, provisioning race) were tested and both were wrong.

# Project progress

Read this file first when resuming work. Update it after a verifiable unit, not
after each edited file. Historical implementation narrative belongs to Git
history, release notes, and ADRs.

## Current milestone

M7 — executable engineering governance and versioned protocol.

## Baseline

- Branch: `refactor/api-split-and-settings` merged to `main` as #7; work continues
  on branches cut from it
- TypeScript, Oxlint, Biome, and Fallow audit: pass
- Tests: 1620 pass, 6 environment skips, 0 fail
- Coverage: 81.96% of statements, 72.40% of branches, 77.21% of functions
- Untested exports: 1 of 6,966 analysed (`missingBinaries`, which returns nothing
  and is pinned as the deployment claim it expresses). Untested files: 3, all
  entry points — the two declared in `.fallowrc.json` and `web/src/app/main.tsx`,
  which `bundle-boots` builds and boots rather than imports
- Fallow complexity: zero functions over threshold, against real coverage rather
  than the export-reference estimate
- Block comments over eight lines: zero, enforced by
  `test/governance/comment-blocks.test.ts`
- Test time is not recorded as a target. The same suite measures differently per
  machine, and a threshold on it would be a coin flip in CI

## Verified complete

- Hono route schemas feed typed handlers and generated browser/CLI clients.
- External JSON is validated before entering business code.
- Group sandboxes, file mailbox transport, and credential vault boundaries are
  implemented and covered by live tests when OpenSandbox is available.
- GitHub is the project source; host Git is not part of runtime operation.
- `src/contracts/states.ts` and executable invariants cover stored lifecycle states.
- Existing full quality chain is green at the baseline SHA.
- Governance work has landed on `refactor/api-split-and-settings`; the former
  `codex/engineering-governance` worktree is historical and is not the active
  implementation path.
- Project plan and progress responsibilities moved under `docs/project/` and
  were reduced to active product state; TypeScript and 772 tests remain green.
- `AGENTS.md` is now the real engineering entrypoint, `CLAUDE.md` is its
  compatibility link, and a source guard prevents legacy documentation paths;
  TypeScript and 773 tests are green.
- The engineering constitution is split across architecture, standards,
  operations, and ADR documents; PR plans carry the required change-radius,
  failure, security, compatibility, test, and rollback evidence.
- Dependency governance now prefers maintained commodity libraries when they
  remove project-owned infrastructure, while forbidding two simultaneous owners
  for the same enforcement or runtime responsibility.
- TypeScript project references, type-aware Oxlint, and a directory-owned Fallow
  DAG have non-overlapping ownership. `entry` contains only undiscovered scripts,
  and the default new-only audit needs no health baseline. Fallow reports zero
  dead-code, duplication, boundary, cycle, coverage, or private-leak findings.
- Oxlint now rejects deprecated APIs, unsafe arguments, import-type side
  effects, unsafe catch callbacks, promise-executor returns, loop captures, and
  implicit button types. Zod 4 and Bun SQLite deprecations are removed; Fallow
  also gates stale suppressions and misplaced dev/optional dependencies.
- `/api/v1/*` and `/orch/v1/*` are the only protocol surfaces. Typed client
  contracts include middleware errors and durable idempotency discovery,
  inspection, and operator recovery without re-running an unknown side effect.
- HTTP composition no longer re-exports unrelated panel, flow, attachment, or
  lesson policy. Agent identity and group access have explicit owners, and the
  former `src/api/shared.ts` catch-all has been deleted.
- Cancellation, durable correlation, transactional state/evidence writes,
  after-commit event fan-out, health/readiness/metrics, and graceful shutdown
  are implemented with focused failure-path tests.
- CI is read-only and separates type, lint, architecture, tests, security,
  workflow, ownership, and PR-plan gates. Releases bind a verified `main` SHA to
  immutable binaries/images, checksums, SBOMs, provenance, and an atomic tag.
- CI actions now use their current supported majors at immutable SHAs. A local
  composite owns pinned Bun plus frozen install, Fallow renders one audit as
  fork-safe annotations and summary, and actionlint verifies its release
  checksum and attestation before execution.
- Fallow security enables its complete official catalogue, including the
  opt-in hardcoded-secret and secret-to-network categories. Pull requests gate
  only newly reachable candidates; nightly keeps the full candidate inventory
  visible for verification without duplicating CodeQL's SAST ownership.
- Configuration loading/settings, persistence database/event bus, process
  text/shell/running helpers, and observability context/redaction now live under
  `src/platform/**`; a narrow build-info zone exposes only the shared package
  version to executable entry points.
- CLI argument/command dispatch and Claude stream event parsing now have narrow
  owners under `src/orch/commands` and `src/runtime/providers`; the former giant
  switches no longer produce Fallow complexity findings.
- Queue selection, ranking, filtering, and keyboard policy now live in a tested
  feature model; the queue view and its helpers have no remaining Fallow
  complexity/CRAP findings.
- GitHub request retries, cancellation, ETag handling, response decoding, and
  repository-hold policy are separate verified steps; the former cyclomatic-50
  request function has no remaining Fallow finding.
- Turn delta construction now belongs to `src/application/turn`; executor turn
  lifecycle, delta, unread, checkpoint, resolver, and watchdog paths have no
  remaining Fallow complexity/CRAP finding with net-negative production LOC.
- Scheduler capacity claims and group/slice admission are separate policies;
  preflight checks, escalation answering, and default-branch discovery also have
  no remaining Fallow finding while preserving their behavior suites.
- App navigation/selection policy now lives in a pure feature model with two
  fewer production lines; authentication vault shaping, DRAFT validation, split
  validation, and config walking also have no remaining Fallow finding.
- PR polling/error classification, knowledge ranking/query/search, ownership
  admission/conflict detection, and package gate detection now have focused
  policies with no remaining Fallow finding and combined net-negative LOC.
- Progress has real server-rendered behavior coverage for empty, active,
  delivered, queue, slice, and concurrency states; Row/Seg policy is simplified,
  all four findings are gone, and production LOC is net negative.
- Tables and evidence now have direct SSR behavior coverage before calculation
  simplification; lease parsing/digest and shared CLI login streaming are also
  simplified. Thirteen findings are gone with combined net-negative production LOC.
- Picker has direct SSR behavior coverage; watchdog rules and sandbox reconnect,
  creation, mount fallback, vault, and restore stages are separated. Six findings
  are gone with combined net-negative production LOC.
- Project indexing and timeline/workspace rendering have no remaining Fallow
  finding. Requirement SSR coverage removed three CRAP-only findings; Home and
  Usage render coverage is in place for the remaining focused cleanup.
- Release archives carry a version-reporting bundled CLI, Linux/Windows x64 use
  Bun baseline targets, required archive contents are verified, and interrupted
  publication documents its immutable resume points instead of claiming no
  external state can remain.
- Full suite reached 856 pass and 0 fail. Six OpenSandbox tests are gated on a
  live server; nine HTTP smoke cases also skip only in restricted environments
  that cannot bind loopback. Normal CI must run the HTTP smoke suite.
- Clean TypeScript build, hard Oxlint gate, formatting, web build, performance
  budgets, and graph-pinned Fallow Review pass; the review accepted four anchored
  decisions with no rejected or stale judgments.
- Architecture/API, security/reliability, and test/performance reviewers report
  no reproducible P0 or P1 findings. Actionlint and zizmor report no workflow
  findings after the final release-order fix.
- The dependency standard graded candidates on net deletion alone, which had
  rejected MSW, tempy, remark and config schema validation — every one of them
  the correct call for a reason the metric could not express. Adoption now needs
  any one of net deletion, semantic fidelity, or a capability needed now or
  plausibly later; declining needs a measurement and a reopen condition. The
  enforcement matrix was rewritten around whether a capability is ours to build
  at all, after one of its rows turned out to be a category error that had been
  quietly steering decisions.
- Coverage is measured for the first time, by instrumenting at load time with
  `babel-plugin-istanbul`. Bun's own `--coverage` cannot answer these questions:
  it has no Istanbul reporter, ignores `NODE_V8_COVERAGE`, and its lcov carries
  no per-function or branch records — so CRAP had no source data and every score
  was an estimate. The plugin must be the first preload entry, since a module
  graph is fetched before it is evaluated.
- With real coverage the complexity gate went from 11 estimated findings to 73
  actual ones, 57 of them functions that were simply untested rather than
  complex. All 73 are cleared — by behaviour tests and separation, with no
  suppression, no threshold change and no baseline file.
- Work found while writing those tests, each its own commit: the diff view's
  right pane word-diffed new against old and rendered the old line on both sides
  tinted as the addition; the structured log's scrubbing was unverifiable inside
  a reporter callback; the Claude login spun for fifteen seconds against a CLI
  that had already exited; and a settings boundary guard pinned one spelling of
  a gate, forcing the source to carry a duplicate expression to satisfy it.
- In-memory test databases restore a serialized schema instead of replaying
  forty migrations, which is most of a run: 10.75 s to 7.0 s.
- The source root is empty. Six files that sat above every subsystem moved into
  the one they belong to, and with them went the last Fallow zone that named a
  file instead of a directory — a boundary written as a list is a boundary that
  drifts on the next root file somebody adds. A guard now asserts every zone
  pattern is a directory.
- `test/` was one flat directory of 128 files; it now mirrors the source zones,
  with `support` for harness code and `governance` for the suites whose subject
  is the repository. The stress runner excluded non-replayable suites by naming
  two files, which would have silently replayed the third; it excludes the
  `live/` and `integration/` directories instead.
- A file in `src/contracts` was read by exactly one zone. That directory is
  reachable from everywhere by design, which makes it the one place a misplaced
  type draws no boundary error, so the guard is now explicit: every shared
  contract must be imported from at least two zones.
- `orch --claim=value` produced a flag literally named `claim=value` and lost
  the text. Commands that read a missing flag fall back to standard input, so
  the command hung on a terminal with nothing on screen. Splitting a command
  line is not this project's logic; `node:util.parseArgs` owns it.
- The CLI then moved to `commander`, which refuses an unknown flag instead of
  accepting it: `--clam` now answers "Did you mean --claim?" rather than leaving
  `--claim` unset. Production code is roughly break-even in lines — the help text
  moved from a template that described the flags from a distance into
  declarations attached to each flag, where it cannot drift.
- Tracing and metrics are the OpenTelemetry SDK's. The hand-written OTLP body,
  in-flight ceiling, drop counter, label escaping and Prometheus renderer are
  gone. `PrometheusExporter` is deliberately unused — it opens a port on every
  interface and would walk around the loopback gate ADR 012 puts on `/metrics`.
  The 512-series cardinality ceiling survived as an SDK view. Neither provider is
  the `@opentelemetry/api` global: composition installs one, tests install their
  own.
- Twenty-one functions across flow, git, knowledge and the escalation chain took
  the whole mechanism context to read one table. They take `db: DB` now. Five
  candidates were checked and correctly left taking `Ctx`.
- The delivery card had a grammar only this repository could read. Cards are
  Markdown, parsed to an mdast AST by `remark`; the overlap, split, criteria and
  filler rules are unchanged and no longer split lines themselves. Cards already
  stored parse through a marked legacy path. The twelve-line cap was recounted
  over content rather than lines, since headings and a table header carry none.
- `codecov.yml` and `.github/dependabot.yml` were read by services and validated
  by nobody; both fail silently, which removes a gate without a word. ajv checks
  them against vendored SchemaStore schemas. The `@schemastore/*` npm packages
  were the obvious answer and ship TypeScript types only.
- Every pull request now gets one sticky comment with its test pass rate, failing
  test names, Fallow findings and size budgets, and Codecov reports changed-line
  coverage as the only failing coverage status. `ci` keeps zero write permissions
  and uploads artifacts; a `workflow_run` job does the writing, because a fork
  pull request can never be granted `pull-requests: write`.
- A pull request link was built with a pattern whose name capture matched
  slashes, so a crafted project remote pointed the panel's merge badge at a
  different repository. Fixed at the shared assembler, where the sibling
  `repoHref` already had the check.
- 技能 is machine-scope and its endpoint was the only `project` query in the
  panel API without `.optional()`, so opening it with no project selected
  answered a Zod error and listed nothing. Both halves mattered: `.optional()`
  short-circuits on an absent value, and the callers were sending `project=`.
- Watchdog rules declare their own cadence through croner, and the last-run time
  is a row. One rule had carried a module-level `lastSweep` — process memory, so
  every restart swept again and two ticks each saw the other's zero. The other
  twenty-three stay on every tick: their per-rule spans landed a day earlier and
  the data has not, and guessing cadences is what put the throttle in the rule
  body. Rules also gained names, because a span reading `watchdog.7d2` split a
  50-second tick into twenty-four parts that still could not say which.
- Anything that waits now has to carry a span, stated in `AGENTS.md` and the
  observability standard rather than left as an example. Two container round
  trips inside the tick were untimed, and `treeHeads` returned an empty map on a
  failed container while its span ended green — the caller keeps that benign
  answer, the span no longer claims it succeeded.
- The `setting` table had nineteen authors across six files, two of which had
  independently invented the same "null removes it" rule. One reader and one
  writer now live beside its schema. The conversion turned an absent key from
  `undefined` into `null`, `Number(null)` is 0 where `Number(undefined)` is NaN,
  and the watchdog read a never-run rule as one that ran at the epoch; the suite
  caught it and the trap is now asserted at the layer it came from.
- Retrieval was blind to most of the world and rescanned the corpus to answer.
  `terms` matched Latin and split Han per character, so Korean, Russian, Thai,
  Arabic and Greek notes produced zero terms and were invisible to search —
  silently, because an empty term list reads as a document about nothing. ICU's
  word breaker is in the runtime and all eight scripts now produce words. Orama
  took the scoring: 33.4ms a query over four hundred re-tokenised documents
  became 0.32ms over an index, and the `LIMIT 400` that cost imposed is gone, so
  notes older than the last four hundred can be found at all.
- Every turn span said it belonged to no project. `scopeAttributes` only emits
  `project.id` when given one and `turnScope` never was, so the panel's project
  scope filtered on a column nothing set and rendered empty on a project that had
  been running all day. Fixed at both ends: the read path derives it through
  `grp` for the rows already stored, and three writers now set it for the spans
  that leave over OTLP, where no collector has heard of our tables.
- Nothing in the span table had ever carried `status = 'error'` — 1636 rows
  across sixty-five minutes of real work including failures. Two spans wrapped
  functions that report failure by returning it, so erroring only in a `catch`
  could not error at all. The tick's own container round trips, the model call
  the code had already complained was invisible, the lease, the gate, the PR poll
  and the reconnect are all timed now, at the funnel rather than at each caller.
- Two fan-outs had no ceiling and the reasoning that kept them uncapped was
  backwards: the CPU cap is per container, and every exec in a fan-out targets a
  different one, so N caps sum against the host rather than contending inside
  one. Ten groups asked for 2.5 hosts' worth at once.
- The `note` table had ten writers in six column shapes and the `setting` table
  had nineteen in three. Both have one now. The note conversion failed first
  time on a lesson worth keeping: binding NULL to a `NOT NULL DEFAULT` column
  overrides the default rather than falling back to it.

- `orch ctx query` is the command every role is told to run first and was the only
  waiting path in the system with no span. Its whole justification is that it costs
  less than the grep rounds it replaces, and that was the one claim nothing here
  could measure. It now opens `ctx.query`, with `ctx.pageindex` and `ctx.assemble`
  timed separately — the two halves are not comparable costs, since the lexical half
  is an in-memory index at 0.32ms while the other spends up to three serial model
  calls. A walk that throws now ends its span red; the `catch` that hides the failure
  from the agent predates the span and is why it was worth adding.
- The 系统耗时 report has a budget for the first time, measured rather than guessed:
  **705ms** for the system scope over 90,000 spans, which is one idle day (the
  watchdog alone writes ~26 spans every 30 seconds). Five window-function queries
  over the whole table, synchronous, so while it computes it blocks every other
  request and the SSE heartbeat. The seed reproduces the real 94%-unscoped skew,
  because that skew is what makes the system scope the expensive read.
- `telemetry.ts` promised a seven-day window and a 200k retention cap; retention is
  `SPAN_MAX_AGE_MS` (24h) and the cap is `SPAN_MAX_ROWS` (1,000,000), and `windowMs`
  is already `.max(SPAN_MAX_AGE_MS)` in the same file — so seven days was unreachable
  through a schema written twenty lines above the sentence claiming it. Both now read
  from the constants instead of restating them.
- The benchmark seeded `task.status = 'open'`, which is not in `TASK_STATES`
  (`pending | in_progress | done`). Migration 044's constraint trigger made it a hard
  failure; it had been meaningless data before that.
- "Roles are configuration, not code" was a comment, not a fact: forty-odd role
  names were hardcoded across the flow, so adding a Composer meant editing dozens
  of call sites. `roles/*.yaml` now declares `capabilities:` and the flow asks for
  one — `roleWith` resolves it and throws on nought or two, and the server checks
  all ten at boot. The guard is a fixture role with no `qa` anywhere that must
  still be dispatched by `handToQa` with no code change; it was shown failing
  first (`Expected: "composer", Received: "qa"`).
  Left as literals with reasons in the commit bodies: the `gates_json` "qa" key,
  the escalation chain states in `src/contracts/states.ts`, and
  `PLANNING_ROLES` in `scheduler.ts`, which is a DRAFT-freeze list rather than a
  dispatch and fails safe for a role that is not in it.

- A group given PR feedback went deaf and blocked everyone behind it.
  `dispatchFeedback` moved it PR_OPEN → RUNNING and nothing moved it back, while
  `pollPr` returns null for any other status — so every later comment, red check and
  conflict was read by nobody, and the group still held `merge_seq` at the head of a
  strictly serial queue. The flip bought nothing: PR_OPEN is already in
  `DISPATCHABLE_GRP_STATES`. Removing it was the whole fix, and the stall rule then
  had to stop naming two states where it meant every dispatchable one.
- Half of a review was invisible. `state` was on neither transport, so APPROVED and
  CHANGES_REQUESTED were the same string and a bodyless approval — the common shape —
  was dropped by a filter on `body`. Line-level threads were never requested at all,
  and a failing check arrived as the bare word `build`. All three now reach the group,
  with the check summary deliberately kept out of `pr_checks_sig`: summaries carry run
  numbers, and folding one in would wake the group every 30 seconds forever.
- 系统耗时 opened in **739ms** and now opens in **262ms**, measured over 90,000 spans.
  Indexes were tried first and rejected on measurement — `(started_at, grp_id,
  project_id)` and `(started_at, name)` plus ANALYZE each left SQLite on `span_scope`
  and made the total worse (655 → 716 → 728ms). The cost was sorting, not scanning:
  `traceList` sorted every span in the window to return twenty, and `stageStats` paid
  a third full sort for one status message per stage.
- "Roles are configuration, not code" was false where it was stated. Ten capabilities
  are declared in `roles/*.yaml` and the flow asks for a capability, never a name. The
  guard is a fixture role called `composer` — a name appearing nowhere in the source —
  dispatched by `handToQa` with no code change. A capability no role claims, or two
  roles claiming one, is a named error rather than a silent `undefined` role.
- Two config contradictions were live bugs. `escalation.ts` chose its language with
  `language === "en"`, which is false for every value the setting can hold including
  `"English"`, so the English branch was unreachable; there is one exported
  `isChinese` now. And `config/default.yaml` told container users to set
  `host: 0.0.0.0`, which `ConfigSchema` refuses — the schema is right (these routes
  have no login) and the instruction was wrong.

- The retrieval walk now has an off switch, and the first measurement of what it
  buys. An empty `indexModel.model` means no navigator — both readers of `askIn`
  already treat its absence that way. Measured on a 500-note corpus, three
  questions: the lexical half answers in 12.6ms; the walk adds two model calls per
  question and **192 characters**, about 1% more context, because `ctxBudgetChars`
  was already full. Stable across model latencies of 300/900/1500ms — its cost
  scales with the model and its contribution does not.

  Then the missing case was measured, and it changes the reading. Ask "which
  validation library did we pick?" of a note that says "we chose zod over ajv
  because it ships types" and lexical retrieval returns **nothing** — the question
  and the answer share no word, which is the one thing BM25 cannot cross and the
  exact gap a model walking summaries exists to close. Ask "zod or ajv?" and it is
  found instantly. So the honest verdict is neither "keep" nor "cut": the walk is
  near-worthless when the asker already knows the vocabulary and is the only thing
  that works when they do not. Conditional, not default — and the switch is now
  there to make that arguable with data instead of prose.
- An idle project paid **four container execs per tick** for a repo map that never
  changed — `listTree` plus a `treeHeads` that ships every tracked file's contents
  out of the container (0.8 MB here, 4.0 MB on a large repository) only for
  `saveMap` to find the render byte-identical. Gated on a HEAD stamp in the
  `setting` table: **one exec**, 41 bytes back.
- A requirement's own retrieval was invisible to its budget. `chargeIndex` wrote to
  the `indexer` agent row alone, so a group calling `orch ctx query` every turn —
  which the contract tells it to do first — never moved its `spent_tokens`, the
  number `sliceBudgetTokens` stops a runaway with. The project-scoped rebuild stays
  unattributed on purpose: charging it to whichever group was open is a wrong
  number rather than a missing one.
- The SSE write chain had no ceiling and one rejection poisoned it permanently. It
  is fed by one `bus.live()` per token from up to four concurrent turns, so a
  browser that stopped reading accumulated closures without bound; and every later
  `.then` produced another rejected promise, each unhandled, reaching the
  process-wide reporter that emits a bus event into the same writer. Bounded, with
  the loss counted rather than silent.
- The `event` table had no retention at all — the only `DELETE FROM event` was
  project deletion. The conversation (`say`, `boss_say`, `note`, `escalation`) is
  kept: it is the record, and the unread cursor walks it. The machine's own
  narration is not; 成本's chart asks for 24 hours and nothing reads `state_change`
  back at all.

- A review thread had no way to be closed. `dispatchFeedback` read threads to the
  group and the reply did not exist, so an agent that fixed what a reviewer asked
  could say so in a commit and nowhere else, and a human closed every thread by
  hand. `orch pr resolve --thread <id>` goes through GraphQL's
  `resolveReviewThread` on the same seam `pollViaGraph` uses. Two refusals decided
  in code rather than asked of the agent: the thread must be on this group's pull
  request — repository as well as number, since PR #7 exists in every repository
  the token can write to — and its file must be inside `owns_json`. Anything else
  stays open and goes to `orch ask-boss`, which is the human backstop.
- The first Drizzle step is the check, not the schema. `schema.ts` describes what
  the 46 migrations leave, and `test/platform/schema-equivalence.test.ts` compares
  it against them by reading `table_info`, `index_xinfo` and `foreign_key_list`
  from two in-memory databases — one replayed, one generated through
  `drizzle-kit generate`, which is the production path rather than a hand-rolled
  render. It earned its place on arrival: `grp.spent_tokens` and
  `slice.spent_tokens` were declared nullable against migrations that say NOT NULL,
  and it named both columns and both sides. Two things it cannot cover, stated
  rather than left to be found: the state triggers, which Drizzle's DSL has no form
  for, and the body of a partial index's WHERE.
- `drizzle-orm`/`drizzle-kit` are pinned to the **v1 beta** line, not `latest`,
  which is 0.45.2 and has not moved since 2026-03-27 while v1 replaces the
  migration layout. And the number that decides the next step was re-measured
  against the installed package: `drizzle-orm/bun-sqlite` is **synchronous**, so
  the 423 `await` conversions and the 310 `openMemory` replacements this file
  budgeted are the price of **Postgres**, not of the ORM. ADR 037 charges them to
  that decision, where they belong.

- 系统耗时 opened in 266ms and no longer blocks the process to do it. The five
  queries are synchronous, so while one computed, every other API request and the
  SSE heartbeat waited behind it on the one thread — a reloading tab was enough to
  stall the fleet. Cached per scope and window under the heartbeat that writes the
  spans: **3621ms cold → 0.28ms on a hit**, measured over 90,000 rows. Two traps
  the guards caught: a module-level cache answers one database's question with
  another's numbers, and rounding the window's end *down* drops the spans written
  since — a wrong report rather than a stale one.
- `main` was written into eight places, four of them strings an agent reads. A
  group whose repository has no `main` was told to `git fetch origin main`, and
  that fails inside the turn as a git error it cannot act on, nowhere the boss
  looks. `baseBranchFallbacks` is the list; the project's own `base_branch` and
  GitHub's `default_branch` still win over it.
- Every watchdog threshold was a literal while `watchdogIntervalMs` beside them was
  settable, so the panel could change how often the rules ran and nothing about
  what they decided. Grouped as `watchdog.*`. Also settles a misreading: the 5–30s
  clamp on `readinessPeriodMs` is a *derived* self-check period, not the boss's
  interval being overridden — the watchdog timer reads it unclamped.
- A blocking `orch ask-boss` registered its waiter after `route()`, and `route()`
  can hand the question to a stand-in that answers inside the same tick. All three
  answering paths end in `w?.(answer)`, so an answer arriving first was discarded
  without a trace and the agent blocked forever on a question already answered.
  Surfaced as one full run in three timing out. The key has one owner now —
  `awaitAnswer`/`answered` — so a fourth answering path cannot reintroduce it.
- `openMemory`'s `TRUNCATE` and a previous test's still-settling query were left to
  the deadlock detector, which picks the victim itself: the abort landed on the
  stray and arrived as a failure in the *next* test. `lock_timeout` under
  `deadlock_timeout` makes the truncater always lose, so nothing but it is ever
  cancelled. Eight consecutive full runs green afterwards, 1701 tests in ~27s.
- The six live OpenSandbox tests pass, 6/6 under `ORCH_LIVE_SANDBOX=1`. Running
  them found four things, three of them real: the agent CLI was provisioned as
  source no container can run (677ddac); a blank line does not survive the session
  transport, so every diff-hunk gap was closed up — `printf 'a\n\n\nb\n'` returns
  `["a", "b"]` from `runInSession` and `["a", "\n", "\n", "b"]` from `run`; and
  `VERSION` read package.json from module scope, so every `orch` verb inside a
  container died at import with `ENOENT: /package.json`. The fourth was the suite's
  own — it asserted `refs/heads/` where `keepBranch` deliberately writes
  `refs/orch/`. Nightly should be green.
- **The retrieval question is measured, and the answer is that it has never been
  asked.** From the pre-migration database, 98,056 spans over 2026-08-19:
  `index.ask` ran **36 times, succeeded 0 times**, spent **738.5s** of wall clock
  (mean 20.5s, max 24.4s), and accounts for **36 of the 56 error spans in the
  whole system — 64%**. Each `orch ctx query` that reached the tree paid ~20.5s to
  learn nothing and fell through to the lexical half, which ADR 020 measured at
  0.32ms. So the "59% of the cache-read bill" line is not refuted — it is
  untestable, because the layer has never returned an answer to compare.

  Why is not recoverable from that data: the span recorded `exit 1` and nothing
  else, while the panel reads `status_message`. The boss was told 43 times
  ("PageIndex 建不起来：12 次调用全部没有返回") with no reason attached, and both
  runtimes were tried and reverted, so it is not one model name. `index.ask` now
  carries the CLI's own words, scrubbed and clipped. Nothing is cut and the
  default stays on — see [ADR 040](../adr/040-the-retrieval-walk-has-never-answered.md).
  `pageindex.enabled` is the switch for the comparison once calls succeed.
- `scripts/` was outside `bun run lint`, and that is where the async migration
  hid. Ten findings, two of them `no-floating-promises`: `benchmark.ts` called
  five newly-async span queries without awaiting one, so the telemetry budget
  Wave 1 added reported **67µs against a 600ms ceiling** — five promises being
  constructed — and could not have gone red for any regression. `seedSpans` had
  the same shape, so its 90,000 inserts raced the whole run rather than preceding
  it, which is the whole of the `snapshot: 7.96e+3ms > 90ms` failure. Awaited:
  telemetry report **176–178ms** on PostgreSQL (739ms → 281ms was the SQLite
  path), snapshot **2.6ms**, watchdog tick 6.8–10.5ms; every budget clear, and
  the telemetry one shown able to fail. A test now fails if any directory holding
  TypeScript is outside the lint target.
- **One unreproduced live-sandbox failure, kept here rather than called a flake.**
  One run in seven had three tests fail, the first at `test -x /usr/local/bin/orch
  && ls /var/orch` returning **126** — the shell's "found but could not execute" —
  337ms into the first test, so the container existed and provisioning had not
  finished. Six runs since have been green: cold (server killed first), warm
  (server reused), and immediately after three back-to-back full suites, which is
  what preceded the red one. Two hypotheses were tested and both were wrong — the
  22s wall clock was a *consequence* of failing early, not a slow boot, and a cold
  `ensureServer` start does not reproduce it. `provision()` is awaited inside
  `openSandbox`, so it is not a provisioning race either.

  The reason it cannot be taken further is the assertion: `expect(orch.code).toBe(0)`
  discarded both output streams, so a container that said something kept it. Same
  defect class as `index.ask`'s `exit 1`, and fixed the same way — the probe now
  prints `code`, `out` and `err`. A container is the one place where re-running is
  not a way to find out. No cause is named here, because naming one would be a
  guess printed as a diagnosis.
- **Where an idle fleet's 24 hours actually went**, read back from the 98,056
  spans the pre-migration database still holds. No agent turn ran in that window
  at all — 7,707 watchdog jobs, **zero** `agent_turn` — so every second below is
  the cost of doing nothing:

  | span | calls | total | mean |
  |---|---|---|---|
  | `watchdog.repo_map` | 2,766 | **6,351s** | 2,296ms |
  | `sandbox.exec` | 6,382 | 6,046s | 947ms |
  | `git.ls_tree` | 1,184 | 3,819s | 3,226ms |
  | `git.ensure_mirror` | 1,184 | 2,608s | 2,203ms |
  | `index.ask` | 36 | 738s | 20,513ms |

  `watchdog.repo_map` is 95% of the whole watchdog tick, and `git.ls_tree` and
  `git.ensure_mirror` are nested inside it — their call counts (1,184) match the
  1,185 ticks whose stamp could not be read exactly. Fixing that one branch
  removes all three, about **6,300s per 24 idle hours**.

  Both follow-ups that measurement left open are now closed. The gate's own
  `rev-parse` cost ~947ms of container exec on every tick — the map's input is a
  push, so it is asked on `watchdog.repoMapEveryMs` (five minutes) instead of on
  every 30s tick, which is ~90% of that gone and a knob in the panel. And
  `ensureMirror` no longer fetches for callers that do not read refs.
- **Wave 5.6: the instrument was incomplete, and that is what got fixed.** Its
  instruction is to confirm where a turn's wall clock goes *before* changing prompt
  assembly, and no turn ran in the span history, so there was nothing to read.
  Reading the code instead found the real gap: `runAgentTurn`'s own comment names
  four stages — prepare, checkpoint, the provider call, settling the result — and
  only three had spans. The missing quarter is ten serial awaits, two of which
  enter a container (`preserveTurnBranch` bundles the branch into the mirror,
  `reconcileOwnership` runs git against the checkout), so "the turn took nine
  minutes" could resolve to the provider or to `finishTurn` with no way to tell.
  `turn.settle` closes it. `assemble.ts`, hard constraint #1 and
  `cache-position.test.ts` are untouched, as the plan requires — the next fleet
  that runs a turn will have the four numbers the decision needs.
- `ensureMirror` fetched unconditionally, so all three callers paid a network
  round trip none of them had asked for — measured, **1,184 fetches costing 2,608
  seconds in one day**. Two never needed it: `pushBranch` only sends `refs/orch/*`
  outward, and `keepBranch` fetches a *local* bundle and already retries with an
  explicit `fetch origin` on the one failure that means the mirror is behind.
  Split into `ensureMirror` (it exists) and `freshMirror` (its refs are current),
  and only `listTree` — the caller that reads refs — takes the second. The
  question the old comment asked, "whether that is worth a cache", turned out to
  be the wrong question: two of the three callers wanted no cache and no fetch.
- **The query-plan check the plan's table asks for now exists, and its SQLite
  answer did not transfer.** `progress.md` recorded indexes being tried and
  rejected — on SQLite, where `span_scope (grp_id, slice_id, started_at)` trapped
  the planner behind an unconstrained middle column and the real cost was sorting.
  PostgreSQL plans the system scope as `Index Scan Backward using span_age`, three
  buffer hits, 0.022ms, and drops out at the LIMIT. `test/platform/span-query-plan.test.ts`
  asserts the plan on 20,000 rows at the real 94% unscoped skew, and was shown
  failing by dropping `span_age` — which becomes `Seq Scan` plus `Sort`.

  That proof cost something worth writing down: the per-file test database is a
  template *copy that is kept*, and `openMemory` only empties rows. A `DROP INDEX`
  therefore outlived its own run and every later run of that file inherited it,
  until the database was dropped. Noted at `openMemory`.

## Blockers and deviations

- **The `pageindex` config keys are recorded in the wrong commit.** They belong to
  `55ee9e2`; they were swept into `5234fd6` (event retention) by a `git add` on
  `config.ts`/`load.ts` that took another agent's unstaged hunks with them. The
  tree is correct and complete — only the attribution is wrong. Not rewritten:
  the commit is pushed with thirteen on top of it, and rewriting shared history to
  fix a wrong label costs more than the label does. This is exactly the failure
  `AGENTS.md` names when it says to stage owned files by name.

- The `main` branch ruleset required a status check named `check` that no
  workflow defined, so it could never report while none of the fourteen quality
  jobs that do run was required. Fixed: the fourteen real job names are required
  and `require_code_owner_review` is on.
- The first full Fallow security inventory surfaces 40 verification candidates
  (17 SQL, 13 SSRF, eight dynamic-regex, one redirect, and one secret-shaped
  literal). They are not declared vulnerabilities or suppressed; final security
  review must disposition the paths while CI blocks newly reachable candidates.
- Live OpenSandbox tests remain environment-gated and are skipped without a
  running sandbox server.
- Repository settings such as branch protection, secret scanning, push
  protection, and required checks must be verified on GitHub after workflow
  files land; repository files cannot enable all of them.
- No compatibility aliases will be kept for the pre-release unversioned API.

## Rollback records

- **`main` branch ruleset**, snapshotted before and after the Phase G4 change:
  the live state is whatever `gh api repos/pamin-labs/orchestrator/rulesets/20892179` answers as of
  this entry. It requires the **8** contexts in
  [`.github/required-checks.txt`](../../.github/required-checks.txt) — `quality`,
  `test`, `pr`, `security-fallow`, `security-dependencies`, `security-container`,
  `workflow-static`, `security-codeql` — with `require_code_owner_review` on, plus
  deletion and non-fast-forward protection.

  It said fourteen until this entry, naming `quality-format`, `test-main` and
  friends: the nine-jobs-into-three consolidation renamed them and the list here
  was not moved with them. The file is the single source now and the live ruleset
  matches it; a list transcribed into prose is the same drift that produced the
  `check` bug below, one layer up.

  All fourteen were verified against `.github/workflows/*.yml` as real job
  names, which is the check that matters: the bug this replaced required a
  status named `check` that no workflow defined, so every pull request waited
  forever on a report that could never come while the fourteen jobs that do run
  were required by nothing.

  To roll back: `gh api --method PUT repos/pamin-labs/orchestrator/rulesets/20892179
  --input <(gh api repos/.../rulesets/20892179)` from a copy taken outside the repository. Worth knowing
  before it is needed, because a bad ruleset blocks everybody's merges at once.

## Next executable items

1. **Run the release workflow in dry-run mode — blocked on a version bump, not on
   effort.** `checks` refuses before anything builds: it requires
   `inputs.version` to equal `main`'s `package.json` version *and* `v<version>` to
   be unpublished. `main` is `0.1.2` and `v0.1.2` is published, so every dispatch
   dies on "already published and immutable releases are not re-cut". Bump
   `package.json` on `main` to the next version first; which version, and whether
   now is the time to cut one, is the boss's call.

   Then dispatch with `dry_run` ticked (`release.yml:10`, default true) and confirm
   `image-push`, `manifest`, `publish` and `promote-latest` are all skipped. What
   only a hosted run exercises: the image build on x64 **and** arm64, Trivy against
   the built image, SBOM generation, and provenance attestation.

   The publication half no longer depends on that run to be trustworthy. A test
   walks every step in `release.yml` for a publishing verb — `docker push`,
   `gh release create`, `imagetools create`, a registry login, either attest action,
   `push: true` — and fails unless it sits under `!inputs.dry_run`. Naming the four
   guarded jobs was a list a fifth job walks past, and a passing dry run only ever
   proves that *today's* steps were guarded.

2. **`codecov/patch` is in the ruleset. Done**, and the blocker was a misreading:
   `commits/<sha>/status` returns an empty array because Codecov posts a **check
   run**, not a commit status. It had been uploading all along. Verified live on #9
   with enforcement active. It is deliberately *not* in
   `.github/required-checks.txt` — `release.yml` reads that to gate on the release
   sha's check runs, and no `main` commit ever carries `codecov/patch`, so it lives
   in `.github/merge-only-checks.txt`, read by the ruleset command alone.

3. **Schema-level test isolation is done.** A namespace per worker replaces a
   database per file: `template0` is 7,521 kB against 808 kB of our own tables, so
   87% of every per-file database was a copy of the system catalogue. The
   container went **3.00 GB → 193 MB**, and the cleanup that `TRUNCATE` did in
   33,745ms a suite is ~2,000ms of `DELETE`. IntegreSQL was not needed — the
   pooling it sells is one line here, `BUN_TEST_WORKER_ID` instead of `Bun.main`.

   What that leaves, measured on a quiet machine: the suite is ~13.3s wall clock,
   of which the database is ~0.4s. Every further attempt was tried and refuted
   with data — `--no-isolate`, merging test files, per-file namespaces, lower
   concurrency, a smaller pool, probing before delete, batching fixtures. The
   remaining 11.1s is 1,715 tests doing their own work, and shortening that is a
   per-file exercise with no lever in it.

4. **Monitor the nightly stress run** and replay any property failure from its
   reported seed and path. CI, security and CodeQL are green on `main` after #7.

## Done since this list was written
- **The panel reads in nine languages, and the compiler owns the ids.** 811
  messages under `web/src/locales`, extracted by Lingui from `<Trans>` and
  `` t`…` `` macros — no hand-written keys, and no Chinese copy left in
  `web/src` (`test/governance/panel-speaks-english.test.ts` holds that).
  English is the source; 中文, 日本語, 한국어, Español, Français, Deutsch,
  Português and Русский are all at 811/811. `README`'s table is generated by
  `bun run i18n:progress` and checked in CI, `i18n:validate` parses every
  message as ICU, and `test/web/catalogs-render.test.tsx` renders each catalog
  through `startLocale` — the path the browser takes — so a locale that is in
  the picker but missing from `CATALOGS` fails rather than silently reading in
  English. Each catalog is its own chunk: `main.js` carries none of them.

  The panel's language is the browser's, set in Settings → 外观, and no longer
  follows `output.language`: that knob sits in the cache prefix, so reading a
  pane in another language would have rotated every session in the fleet.

  ADR 041 has the Bun findings, the babel boundary against ADR 015, and the
  measured cost: `bun run test` +10.5% CPU, `build:web` 0.22s → 0.25s, bundle
  1.70MB → 1.78MB.

- **`ORCH_COVERAGE=1` was the only mode that ran both loader transforms, and
  they did not compose.** `oxc-coverage-instrument` rewrites the initialiser of
  `const { t } = useLingui()` into a sequence expression, and the Lingui macro
  then refuses the file — in all 21 panel files that call it. `bun run test` was
  green throughout; CI's coverage job was not. Expansion now runs first and
  hands its source map to `inputSourceMap` + `composeInputSourceMap`, which is
  the documented way to instrument a file something else already rewrote:
  measured on `ui/bits.tsx`, 12 functions and 29 statements before and after,
  all on their disk lines. `retainLines` was tried first and rejected — it
  drifted one declaration by 4 lines.

- **`schemaAt("__proto__")` returned `Object.prototype`.** `shape` is a plain
  object, so indexing it walks the prototype chain and the `!next` guard never
  fired; nothing was exploitable, because `path in SETTING_DENIALS` found the
  same inherited key one line up. Two prototype-chain reads cancelling out is
  not a guard. Both are `Object.hasOwn` now, which is what makes the
  `fallow-ignore` on `apply`'s `Object.assign` an argument rather than a
  suppression.

- **`繁體中文` was read as English.** `isChinese` anchored on the first
  character, and that is the second entry in the list the knob itself offers —
  so the setting a Chinese-reading boss is most likely to pick did nothing, in
  `say()` bodies and in escalation prompts alike. The check now lives in
  `src/contracts/config.ts` beside the schema it interprets, because the panel
  needs the same answer.

- **The plan card's six section headings were Chinese literals, and three
  independent readers matched them.** `roles/dispatcher.yaml` told the agent to
  write `## 目标`, `src/mech/util/validate.ts` parsed for it, and the panel
  matched it by prefix — three parties aligned on one Chinese string while
  `output.language` was free to be any of nine. They are protocol tokens that
  happen to look like Chinese, the same category as `application/json`, so they
  are `goal`, `non-goals`, `accept`, `slices`, `risk`, `objection` now, matched
  case-insensitively, with the old headings kept in an `ALIAS` table because a
  queue can hold cards written on either side of the change. `dispatcher.yaml`'s
  example slice had to become `add tests` rather than `add test cases`:
  `validate.ts`'s `testOnly` pattern carries neither `more` nor `cases`, and the
  wrong wording would have made the teaching example silently legal. Verified
  against the compiled pattern before writing it.

- **155 Chinese strings under `src/` were never a translation problem.** ADR 035
  puts errors in category 2 and CLAUDE.md says the same in one line, so
  `docker 装了但没启动` and `密钥不对，服务器不认` were a rule violation, not a
  missing catalog — reading them that way is what made the batch tractable, since
  none of them needs nine catalogs. Preflight's `detail`/`fix` pairs, the sandbox
  server and image diagnostics, the auth errors, `ghlogin`'s device-flow failures
  and `checkout`'s silent-skip reasons are English. The `say()` bodies are
  untouched: they are category 3 and follow `output.language`, which is why
  `authflow.ts` correctly reads `GitHub 没连上：the authorization was denied on
  GitHub` — a category 3 wrapper around a category 2 error. The baseline the
  governance guard ratchets against went 407 → 252, of which 44 are `say()`'s own
  table.

- **A guard that could not fail, for the third time in one branch.**
  `test/platform/lang.test.ts` asserted `!say(...).includes("{")` — against a
  function whose whole body replaces every `{word}` with `String(args[k] ?? "")`.
  It could never be red. Replaced with a set comparison of the placeholder names
  in each row, and it immediately found six that had been rendering as empty
  string in a green suite: `slice.autoaccept: {tier}`, `gate.reconcile: {reason}`,
  `group.blocked: {path}` and `{target}`, `group.unblocked: {target}`,
  `wd.budget_80: {pct}`. This is the same shape as `settings-boundary.test.ts`
  seeing 37 of 61 knob paths and `panel-speaks-english.test.ts` never visiting a
  `RegExpLiteral`: not a missing guard, a guard that looks present and stops
  anyone from writing a real one.

- **The escalation gate read two languages while the panel grew to ten.**
  `isReserved` decides which questions an agent may never answer on the boss's
  behalf — money, merging to `main`, credentials, production, changing scope. It
  was five English patterns and one Chinese one, written when the panel spoke
  two languages; an agent writes its question in `output.language`, so a Japanese
  or Russian one walked through. Fifty probes — five topics across ten locales —
  and the old gate caught eight. Two of the misses were in the languages it was
  written for: `budget increase` is a word order nobody uses, and `subscri`
  inside `\b(…)\b` could never match, because subscribe and subscription both
  continue into another word character. The one topic with a recurring bill
  attached had a dead keyword from the day it was written. Now
  `Record<Locale, readonly RegExp[]>`, so the compiler stops the eleventh
  language rather than the boss discovering he was never asked — which it
  collected on the same afternoon, when adding `zh-Hant` failed to compile until
  its row existed.

- **Traditional Chinese is generated, not translated.** `scripts/i18n-hant.ts`
  runs `zh.po` through opencc-js with two term tables: five corrections where
  `s2twp` over-converts (映象 for 映像, 閘道器 for 閘道, 程序 — which is Taiwanese
  for *program* — for 行程) and sixteen it leaves in Mainland form. `zh-Hant`
  is ordered before `zh` in `LANGUAGES` because CLDR's likelySubtags resolves a
  bare `zh` to Simplified, and `isChinese` is a prefix test because `=== "zh"`
  would have given a Traditional reader **English** — worse than before the
  locale existed. The guard asserts counts rather than presence, so an opencc-js
  upgrade that quietly restores 映象 is caught while every other check is green.

- **A prompt firewall on the role files, and nowhere else.** `promptpurify`'s
  deterministic layer refuses to load a role whose prompt impersonates an
  instruction, naming the file, the rule and the span to delete. Checking the
  *assembled* prompt was built, measured and rejected: `src/runtime/codex.ts:36`
  is `argv.push("--ignore-user-config", "--ignore-rules")`, so an engineer asked
  to audit this project's own runtime trips the gate every time — a fixed string
  in our source, not a probabilistic false positive. The classifier is not wired
  at all: this repository's benign content scores a median 0.545 while six of
  eight injections written against this orchestrator score 0.25–0.40, so the
  attacks rank below ordinary source code and no threshold separates them. ADR
  042 carries the numbers and the condition under which the rejected half can be
  reopened.

- **Two concurrent suite runs shared their namespaces and emptied each other.**
  A test namespace is `t_<tag>_w<BUN_TEST_WORKER_ID>`, and that id restarts at 0
  every run, so a second `bun run test` takes the same schemas as the first and
  deletes its rows mid-test. It reports as duplicate keys, absent foreign parents
  and `relation "agent" does not exist` scattered across files that share
  nothing — two agents each spent a full suite diagnosing a branch that was fine,
  because a corrupt run and a broken branch look identical. `scripts/test.ts`
  takes an `O_EXCL` lock and refuses the second run by name; a lock left by a
  killed run is cleared and said out loud. `emptied()` was accused first and is
  innocent: its deletes are a data-modifying CTE inside a transaction, which
  PostgreSQL runs to completion whether or not the query reads them.

- **ADR 041 said Lingui could not reach the server, and that was only half
  true.** The reason it gave was real — `release.yml` builds the server with
  `bun build --compile`, the CLI has no `--plugin`, so the `.po` plugin cannot
  run there. But that constrains *importing a catalogue*, not *running the
  library*. Measured: a `bun build --compile` binary importing `@lingui/core`
  and `@lingui/message-utils/compileMessage` renders Russian plurals correctly
  — 1 срез, 2 среза, 5 срезов, **11 срезов, 21 срез**, the two everyone gets
  wrong — for 10 extra modules and 49,536 bytes (63,495,650 against
  63,446,114). Macros need the build plugin; the runtime does not. That is what
  makes a server that speaks ten languages possible without reopening the
  decision 041 actually made.

- **Where each kind of text gets its language, written down once.** Panel text
  follows the *interface* language and is rendered by the panel; text that
  leaves this machine for a person — the notify webhook, the parts of a prompt
  an agent writes for a human — follows `output.language` and is rendered by
  the server in ten languages; code, commits, branch names, protocol keys, logs
  and `/readyz` stay English and are not translated at all. The split is by
  *function*, not by whether a browser is involved: that earlier test made the
  webhook English-only, which is not a language a boss chose.

- **The design for it is Lingui's, not ours.** `msg({ id, message })` takes an
  explicit id (`@lingui/core/macro`), `i18n._(id, values)` takes a plain string
  id, and the catalogues already hold both. So the server names a sentence and
  the panel renders it, with no descriptor table beside the catalogue, no
  hand-written interpolator beside ICU, and no parity test — the generated
  server table exports the ids as a literal union, so a server naming a message
  the panel never declared fails to compile. Three things that were about to be
  invented here already existed; what is left of the invention is a wire schema
  of two fields, because that much has to cross HTTP.

- **A boss whose outward language is Korean gets English prompts, and the code
  says so in an `if`.** `src/api/orch/escalation.ts:310` and `:339` branch on
  `isChinese(ctx.config.language)` to pick between a Chinese prompt and an
  English one — the same two-language pair `say()` had, in the one place the
  panel's ten catalogues cannot reach, because this text goes into a model
  prompt rather than onto a screen. The new rule puts the parts of a prompt a
  person reads under `output.language`, so this is a real gap and not a
  category-3 exemption; it is out of scope for the change that is landing, which
  is why it is written down rather than left in the diff. `answerDraftContext`
  also picks `常驻岗` or `standing` the same way, and that string reaches the
  model as data.

- **The panel showed three languages at once, and each one was following a
  rule.** The sandbox pane's frame was Chinese, its diagnostics English, its
  server status Chinese again. Now: panel text follows the interface language
  and the panel renders it; text leaving this machine for a person follows
  `output.language` and the server renders it in ten languages; code, commits,
  protocol keys, logs and `/readyz` stay English. `say()` had been
  `isChinese(lang) ? ZH_SAY : EN` — a language *pair* — so a boss whose
  `output.language` was `한국어` had read an English feed since that function was
  written. `src/`'s Chinese literal count fell 236 → 167, and what is left is
  protocol, regexes and one prompt branch.

- **`lingui extract` will not update a `msgstr` it has already written.** Under
  an explicit id the source locale is a translation like any other: a new id
  gets its message, an existing one is left alone. So deleting the server's copy
  of the English bought one author for *new* messages only — reword an existing
  one and the panel moves, because a `MessageDescriptor` carries its own
  English, while `/readyz` and the console stay on `en.po` through the generated
  table. `english-has-one-author.test.ts` compares the two, and found a bug in
  its own `.po` reader on its first run: it stopped at the first line of a
  `msgstr` the formatter had wrapped.

- **The mutation had not taken effect, for the second time in this branch.**
  That is how the above was found — an edit to a `message` was made, the table
  regenerated, and the guard stayed green. The first instinct, "the test is not
  sensitive enough", was wrong both times. The earlier one left `NEVERMATCHxx`
  in a shipped pattern because the pristine copy it was `cmp`-ed against had
  been taken *after* the injection. A mutation that does not move the artefact
  proves nothing about the test, and looks exactly like a test that proves
  nothing.

### One missing CLI flag was read as a missing capability, and a layer got built around it

`bun build --compile` has no `--plugin`. `Bun.build({ compile, plugins })` does,
and `scripts/build-web.ts` had been calling it that way for weeks. ADR 041 read
the first fact as "a Lingui macro cannot reach the server" and everything below
existed to carry a sentence across a boundary that was never closed:

| deleted | lines it was there to hold |
|---|---|
| explicit ids on 135 messages | so the server could name a hash it could not compute |
| `web/src/shared/messages.ts` + `web/src/features/settings/checks.ts` | two descriptor tables, 70 + 52 + 13 entries |
| `said()` in `lang.ts`, `CheckSaid`/`CheckKey` in `preflight.ts` | the typed doors onto those ids |
| `scripts/i18n-messages.ts` → `src/platform/text/messages.generated.ts` | 143 lines of catalogue for a runtime that "could not import one" |
| `test/governance/english-has-one-author.test.ts` | two copies of the English, kept in step by a test |
| the placeholder lists in `lang.test.ts` and `preflight.test.ts` | 27 + 13 hand-copied value names |

An emitter now writes `say: msg\`merged into main\``, the same call the panel
writes. The wire carries `{ id, message, values }` and both sides call `i18n._`
on it — the catalogue row when the reader has one, the `message` beside the id
when not. **English stopped being a special case**: it is the second branch, the
way every untranslated message already was.

Proof it reaches the artefact, which is where the original ADR was wrong — a
standalone binary, built through `scripts/build-server.ts`, run:

```
влито в main | 已合入 main | main にマージしました | merged into main
```

Cross-compiled from darwin-arm64: `bun-linux-x64-baseline` → ELF x86-64,
101.2 MB; `bun-darwin-x64` → Mach-O x86_64, 76.7 MB. Both under the release
job's 150 MiB ceiling, and `__ORCH_VERSION__` lands in both.

### The 135 messages kept their nine translations, and the migration proved it

Under `@lingui/format-po` a hashed message is written `msgid "<the English>"`;
only an explicit id gets `#. js-lingui-explicit-id` above it. So the migration
was to replace each explicit id with the English from `en.po` and re-extract —
and `lingui extract` then reports **934 messages, 0 missing in all nine
locales**. A template that had drifted by one character would have shown up as
that locale's missing row. `zh-Hant.po` came back byte-identical from
`i18n:hant`.

### Three places the macro now has to be wired, and the one that bites

`Bun.build` in `build-web.ts` and `build-server.ts`, `Bun.plugin` in
`test/support/loader.ts`, and — new — `bunfig.toml`'s **top-level** `preload`,
for `bun run src/composition/server.ts`. Measured before writing it: a top-level
`preload` is read for `bun run` and *not* for `bun test`, which is what keeps it
from registering an `onLoad` ahead of the test loader's. Bun does not chain
them, so a second registration would have silently taken coverage
instrumentation out.

`test/support/loader.ts` lost its `touchesPanel` gate — the 3s it saved across
204 processes was buying an answer to "can this file reach a macro" that is now
always yes. Timed on one file, warm cache, the difference is inside noise (0.35–
0.42s with the transform, 0.46s with it registered for nothing): the expansion
is content-addressed, so the steady-state cost is a file read.

`src/mech/sandbox/sandbox.ts:agentCli()` builds the agent CLI at **runtime**
with `Bun.build` and no plugin, so a macro reaching `src/orch/**` throws inside
every container. Nothing new was written for it: `version.test.ts` already
builds that bundle and runs it, and an injected `msg` in `cli.ts` turned two of
its tests red.

### The catalogues left `web/src`

`web/**` is a Fallow zone; `platform` may not import from it. They live in
`locales/` now, which is also why `tsconfig.src.json` and `web/tsconfig.json`
both name `locales/po.d.ts`.

### Two hardcoded lists replaced, and one deleted outright

- `traditional-chinese.test.tsx` asserted `映像: 15, 閘道: 3, 行程: 4 …` — absolute
  counts, red twice this branch for new copy with nothing wrong. It now walks
  `MAINLAND`/`OVERCONVERTED` from `scripts/i18n-hant.ts` and computes each rule's
  *wrong* form as what unpatched `s2twp` produces for that word: 21 rules covered
  instead of 6, and adding copy cannot move it. Shown red by putting `映象` back
  in the shipped catalogue.
- `refusals-carry-an-id.test.ts` kept three English refusals copied out of the
  code. `bad()` takes a descriptor and nothing else now, and the exemption says
  its own name at the call site — `badEnglish("this server has no GitHub
  client")` — so the test asserts only that both doors are in use and that no
  literal reaches `bad()`.
- The placeholder guards did not need replacing. A `msg` template writes the ICU
  and its values from the same interpolation, so "a `{path}` no caller fills" is
  no longer a thing that can be written down.


- **A comment claiming to enforce a rule, sitting on the line that breaks it.**
  `contracts/said.ts` says values are never text — a parameter carrying an
  already-translated fragment is a sentence in two languages — and the change
  that wrote that rule broke it in five places. The worst of them carried four
  lines saying `{why}` is a value, not a key, which `contracts/said.ts`
  refuses, directly above a `{why}` holding a sentence rendered in
  `output.language` and handed to a panel that renders in the browser's. A
  comment that asserts compliance is harder to find than no comment, because
  the reader believes it.

- **The fix grew the next variant of the defect it was fixing.**
  `${{ why: st.why }}` became `${{ why: renderSaid("en", st.why) }}` while the
  first instance was being repaired — the same fault one layer in, and
  invisible to both greps that found the original, because a rendered value
  reads exactly like an ordinary one. The guard that covers it is AST rather
  than a pattern, and earned that immediately: a probe aliased to `render(`
  escaped both greps and the test caught it. What it forbids is the position,
  not the function — and the judgement turned out to be the tag, since a plain
  template literal is a join and a `msg` template is a key, so the two legitimate
  places that concatenate rendered strings need no exemption.

- **A type migration's blast radius is larger than the places that changed
  type, and three tools each see part of it.** `reason: string → Said` left a
  plain template literal writing an event body, which would have shipped
  `[object Object]`. `grep` for `msg` templates could not see it — it is not a
  `msg` template. `tsc` accepted it — a template literal takes anything.
  Oxlint's `no-base-to-string` is what said so.

- **Trust boundaries are about where data enters, not about what a type
  permits.** Requiring `message` on the whole schema was the wrong reading of
  "validate unknown data at trust boundaries": descriptors flowing out of our
  own macro are not unknown, and Lingui declares `MessageDescriptor.message`
  optional, so the strict version cost 149 type errors and, once split, stopped
  at hono's inferred response types — going further meant the panel
  re-declaring the wire shape, which is the second owner this work spent its
  length deleting. One line on `MetaSchema` — the JSON read back out of
  `event.meta_json`, which is the only genuinely unknown input — buys the same
  guarantee.

- **Half the emitters is a design nobody wrote down.** `bus.emit` has taken a
  `say` descriptor since the first commit of this branch, and 62 call sites used
  it. Sixty-four did not, and nothing said so — so a Korean boss read
  `interrupted (boss), killed 2` under a heading that had been translated for
  him. What made it invisible is that both spellings compile, both store a row,
  and the untranslated one only looks wrong to a reader who is not reading
  English. The guard judges the *shape of the expression*: a string literal or a
  template with three letters in a row is a sentence this repository wrote, an
  identifier or a call is somebody else's words passing through. Seventeen
  emitters are legitimately the second kind, which is why "does it have `say`"
  could not be the whole rule.

- **A formatter is a language too.** `Intl.NumberFormat("en-US")` on every token
  count, `toLocaleTimeString("zh-CN")` on the settings save, and a hand-built
  `HH:MM` in the timeline column — three formatters, three different pinned
  languages, none of them the reader's. The panel had been made to speak ten
  languages while still writing their numbers in one. `1834000` is `1.8M`,
  `183.4万` and `1,8 Mio.`, and those are not translations of each other.

- **`i18n.number` and `i18n.date` are deprecated in Lingui v6.** Reaching for
  them was the obvious move and oxlint's `no-deprecated` refused it within the
  minute: the library's current answer is `Intl` at `i18n.locale`. The rule in
  `AGENTS.md` about reading the installed version rather than recalling the API
  paid for itself here without anyone having to remember it.

- **The macro can name a value but not say how to format it.** A date inside a
  `msg` template has to be rendered before it goes in, which pins it to the
  *server's* locale inside a sentence the panel renders in the reader's. ICU
  says it — `{at, date, short}` — and `msg({ message })` is the way to write
  raw ICU past the template macro. `lingui extract` reads it, the runtime
  compiler resolves it, and a `Date` survives the JSON round trip as an ISO
  string that `Intl` still accepts. Measured before writing it, because the
  alternative was believing a blog post.

- **An article is not a value.** `revoked ${answered_by ?? "the"} answer` put
  the English word "the" on the wire and rendered as `撤销了 the 的答复` in
  every language that has no articles. Four sentences replace it. The same
  shape, one layer over: `ensureCheckout` threaded three reasons into one
  shared tail, which is `contracts/said.ts`'s "values, never text" for the
  sixth time on this branch — three repeated clauses is what not doing it
  costs, and it is cheap.

- **Two of the twenty-three "mechanism" literals were prose.** The baseline said
  `src/` still holds Chinese literals that break if translated, and it was right
  about twenty-one of them. The mask in `redaction.ts` was not one: it lands in
  logs, in `/readyz` and inside event bodies that ten catalogues render around
  it, so a German reader got `「凭据已抹掉」` inside a German sentence. Nor was
  the attachment header, which was the same sentence typed into
  `mech/util/attachment-text.ts` and into `web/src/ui/attach.ts` with a comment
  on each saying the other had to move with it. A ratchet counts; it does not
  read.

- **The fix for prose-as-a-protocol-key is not to translate it.** Ten spellings
  to match and no way to know which language an already-stored row used — the
  `escalation` bug again, worse. The panel stops reading the header: the block
  is the trailing run of `- path` entries plus the line above it, whatever that
  line says. Then briefly the wrong lesson was applied on top — the header got a
  `msg` template and nine translations — before the obvious question: who reads
  it? The panel strips it, so nobody but the agent, and ADR 035 §2 keeps what a
  model reads in English. Nine rows nobody would ever have read.

- **A formatter is a language, and `.replace("K", "k")` is editing CLDR.** The
  lowercase was there to match the settings rows, comparing a number that gets
  read with a value that gets typed back into a box. Measured on the way out:
  `new Intl.NumberFormat` per call is 10.05µs against 0.225µs reused, 45×, on a
  table that formats hundreds of numbers a frame. The comment claiming "the
  engine caches the format instance behind the constructor" was written from
  memory and was wrong.

- **`i18n.number` and `i18n.date` are deprecated in Lingui v6.** Reaching for
  them was the obvious move; oxlint's `no-deprecated` refused it within the
  minute. The library's answer is `Intl` at `i18n.locale`.

- **98 lines of reformatting around two real changes.** `.fallowrc.json`'s zones
  and rules were re-expanded by an editor, so a reviewer had to diff the
  boundary table by eye to find that only `entry` and `ignoreDependencies` had
  moved. Also stale: `biome.json` still ignored `**/*.generated.ts` for a file
  this branch deleted, and `i18n-progress.ts` kept its own copy of `--check` —
  which is the thing `scripts/generated-file.ts` was extracted from this exact
  pair to hold.

- **The panel's source language changed and its comments did not.** 172 of them
  went on naming 待办, 成本, 批准开工, 轮次与上下文 — labels the source now spells
  in English, so a reader grepping for what a comment says finds nothing. Not a
  translation task: a stale reference that happened to be in another language.
  `AGENTS.md`'s first coding rule already said English for comments, and both
  Chinese guards parsed the file and then walked only its literals. `ast.comments`
  is on the same parse.

- **What stays Chinese is what is *about* Chinese**, and saying which is the
  whole judgement: 21 literals (endonyms, the regexes recognising what a boss
  typed, the parser for Chinese agent cards, CJK escalation patterns, one Unicode
  range) plus 28 comments quoting them. `test/`'s 922 Chinese assertions are the
  point rather than an oversight — they are what makes a catalogue derived
  mechanically from another branch's JSON a tested thing.

- **The layer i18n never reached was a setup script.** `make-github-app.ts`
  served a Chinese HTML page and printed Chinese to a terminal, with no
  `config.language` to read and no catalogue loaded. Nobody looked because it is
  not the panel and not the server.

- **DRY, found by asking rather than by a tool.** `i18n._(id, values, message)`
  written out on both sides including the comment explaining its third argument;
  ten locales listed in `lingui.config.js` beside a comment asking a reader to
  keep them in step with `LOCALES`; four guards each spelling out the same
  `parseSync` options; two CJK character classes that disagreed about kana for
  no reason either guard could state — the panel's could not see a Japanese
  literal at all. Fallow reports duplication at twenty lines; all of these are
  shorter than that and none of them were found by it.

- **Lingui ships two `t`, and this branch used both.** `@lingui/core/macro`'s
  renders against the global instance and returns a string that never changes
  again; `@lingui/react/macro`'s `useLingui` binds to the provider's and
  re-renders on `activate`. Eight files imported each, and which a given line
  got was whichever import was at the top. It was not broken — `I18nProvider`
  re-renders the subtree, so a global `t` inside a component was re-evaluated
  anyway — but it was one rule with two spellings, and only one of them survives
  a `React.memo`. 103 call sites in thirteen panes moved to the hook, and 24
  more that drew a module table with `i18n._(…)`: the same defect one API over.

- **The 13 helpers that keep the global `t` are a constraint, not a leftover.**
  The macro only expands `useLingui` in a variable declaration, so a plain
  function cannot have one. What a helper can do instead is return a `msg`
  descriptor and let the caller render it, which is what the module-scope tables
  already did — four helpers moved that way because a parameter default runs
  before the hook, and `imageHint` turned out shorter inlined than exported.

- **Four places to write a sentence, and the place decides which.** The rule was
  spread across eleven comments before it was a table in `AGENTS.md`: `<Trans>`
  in JSX, the hook's `t` inside a component, `msg` outside one, `say:` on an
  emitter. `a-component-takes-t-from-the-hook` is what makes the second row
  checkable — the outermost enclosing function is the component, and a `t` or
  `i18n._` inside one that is not a hook binding is the finding.

- **`Said` cannot be deleted in favour of `MessageDescriptor`, and the attempt
  is worth recording.** They are the same three fields, so the obvious move is
  to use Lingui's type through `src` and keep the Zod schema only for the wire.
  Done — 20 files, `renderWith` deleted, `renderSaid` down to `i18n._(sentence)`
  — and it does not converge at the boundary. `exactOptionalPropertyTypes` makes
  Zod's `.optional()` `string | undefined` where Lingui's is `string`, hono
  infers a response type from *what the handler returns*, and the panel declares
  its schema as `z.ZodType<InferResponseType<…>>`, which demands equality rather
  than assignability. So every wire boundary would need a hand-written
  conversion, and there are about twenty. Reverted: one type through `src` plus
  a two-line `renderWith` is the shorter road, and now the comment above it says
  which two roads were compared.

- **A rule in `AGENTS.md` that neither call site followed.** "Audit a branch
  with `--base main`" was written after the trap bit once, and then `preflight`
  and `ci.yml` both invoked `fallow audit` with no base at all. Measured: 15
  changed files and 45 functions against 287 and 5140 — the local audit had been
  scanning only what had happened since the last push, and saying `✓ No issues`
  about it. `.fallowrc.json` cannot hold the base (its `AuditConfig` has `gate`,
  `css`, three baseline paths, `cacheMaxAgeDays` and `typeAware`, and no base),
  so the pin is `FALLOW_AUDIT_BASE=origin/main` on all three `audit` scripts —
  which is the one place that covers CI's `bun run audit --`, preflight's
  `audit:crap`, and a person typing `bun run audit`.

- **`--gate all` was measured rather than argued about, twice, and rejected.**
  It fails on findings *inherited* into changed files. At the 15-file scope and
  again at the real 287-file one, the inherited columns are `dead_code: 0`,
  `complexity: 0`, `duplication: 0` and `styling: 4` — and counting those four
  leaves the verdict `warn` and the exit code 0. It gates nothing new. What it
  costs is measurable: it skips the base-snapshot attribution pass, so
  `duplication_introduced: 1` and `styling_introduced: 80` both read 0 under it,
  and those numbers are what `ci.yml` renders as PR annotations. Faster (3.3s
  against 5.0s) for exactly that reason. The trigger to revisit is an inherited
  column going non-zero in a category that can reach `fail`.

## Thirty schedulers were dispatching into the tests that came after them

`review-pipeline`'s retro test failed on CI a second time, having already been
loosened once — `1cda0ce`, "the assertion depended on which turn the scheduler
finished last". The first fix treated the symptom, and this is what was under
it.

- **`setup.ts` closed one scheduler and twenty-two files built thirty.** Its own
  comment named the scope it wanted — "Nineteen files build a Scheduler; this is
  one file" — and `stopSchedulers` only ever saw the one `testContext` makes.
  Measured by counting live instances at each `beforeEach`: **30 still accepting
  by the end of `test/mech/review-pipeline.test.ts`**, one per test, after the
  fix **0**.

- **What a stale one does is claim the next test's work.** A finished job ticks
  from a detached `.finally`, and the tests in a file share one database that
  `openMemory()` empties between them. The stale sweep takes the current test's
  `pending` row, runs it against the *previous* harness's executor, and the spec
  lands in a `specs` array nothing is asserting on. Different victim each run,
  and re-running is green — which is why two rounds of reading the scheduler
  found nothing wrong with it. Nothing is.

- **`test/support/scheduler.ts` is the one registry, and it deleted two.**
  `test-context.ts` and `job-queue.test.ts` had each written this factory for
  themselves; the third copy is the shared one.
  `a-test-closes-its-scheduler` keeps it — `new Scheduler(` under `test/` is a
  governance failure outside the factory — and was shown failing against a real
  reverted call site. A guard that has to spell the shape it forbids exempts
  itself by `import.meta.path`, not by a name a rename would leave behind.

- **Not claimed: that this is the CI failure.** It did not reproduce locally —
  the file alone, `test/mech` under six competing CPU hogs, and two full suites
  under eight. What is measured is the leak and its removal, and that the leak's
  shape and the failure's shape are the same one. If the retro test fails again,
  this was not it.

## Nightly had never been green, and three jobs failed three different ways

Four scheduled runs, four failures, and nobody had read the log.

- **`sandbox-live` and `test-stress` had no database.** `ci.yml`'s test job runs
  `bun run db:test:up`; neither of these did, and `openMemory()` is how every
  test in them reaches one. Both died on `ERR_POSTGRES_CONNECTION_CLOSED` in
  under a minute. `sandbox-live` reported "Ran 2 tests" — two unnamed failures
  from a module-scope `boot()` that threw — under a step named "the six live
  tests, and proof they ran". Fixed and verified by dispatch: **1m52s green, the
  six ran.**

- **`security-full`'s `bun run audit` examined nothing.** `fallow audit` is
  scoped to changed files by design and that job runs on `main`, where the base
  is `main` — three consecutive nights printed `✓ No issues in 0 changed files`.
  The same audit runs per pull request in `ci.yml` against a real diff and a real
  coverage file, so the step is gone rather than rescoped: a second owner
  reporting on an empty set. Run from a branch it *does* fire, and with no
  coverage file every CRAP score falls back to the export-reference estimate —
  11 phantom complexity findings, the trap `AGENTS.md` documents.

- **`test-stress` was missing three things `scripts/test.ts` gives every caller
  that goes through it.** It spawns `bun test` itself. No document (`dom.ts`
  gates on `Bun.main`, which names one file only under `--isolate`, and this run
  deliberately is not — 195 failures, 20 of 21 distinct ones `HTMLElement is not
  defined`). No run lock, so two passes share schema names and empty each other's
  tables — reproduced on myself by starting a second one. No `--timeout=20000`,
  where Bun's 5000ms default sits 571ms above this suite's p99.9 and this pass
  runs at Bun's *default* concurrency. All three now come from the one place that
  measured them.

- **And it immediately earned its keep.** 195 failures to **6**, one distinct
  test: `sending a DRAFT back records the reason and re-runs the dispatcher`,
  6 of 10 reruns. A `SELECT` with no `ORDER BY` read positionally — `at(-1)` on a
  row order nothing had assigned, which is insertion order on a fresh heap and
  something else once pages have been reused. Green every time the file ran
  alone, which is why nothing had caught it. It is the only unordered
  positional read of a table in the suite: `chain.ts`'s `jobsFor` orders, and
  every other `at(-1)` is over an in-memory array.

- **Then it earned its keep again, on CI, with a seed this machine had not
  drawn.** 120 failures across six unrelated files, all asserting Chinese and all
  getting English: `say-falls-back-to-body` ends on `i18n.activate("en")` and has
  no `afterEach` putting it back, so every file after it in the process read the
  wrong catalogue. Invisible under `--parallel`, where each file has its own.
  The active locale is a process-global like the five `setup.ts` already resets
  in `beforeEach` — whose own comment says a rule every caller has to remember is
  one the twentieth forgets — so it is reset there now, and `token-units`'s
  private `afterEach` is gone with it. Replayed at CI's seed: 15,600 pass, 0 fail.

- **The rule that should have caught it had a back door.** `preload-scope` held
  every `package.json` script containing `bun test` to `--parallel` or
  `--isolate`; a script that spawns `bun test` from TypeScript has no such
  string. It reads both argv shapes now and names every script that runs the
  suite, so a third is a decision rather than a silent third way.
  `stress-runner`'s duplicate half is gone. Shown failing on each half.

## The test database is three times slower when it is full of dead rows

Measured while chasing something else, and it explains most of the local timing
spread this branch has been quoting.

- `emptied()` uses `DELETE`, which is the right call per test — measured at 5x
  faster than `TRUNCATE` on tables holding single-figure rows — and **never
  returns a page to the OS**. One worker schema held `span` at 2,000 live rows
  and **995,781 dead** ones, 134 MB. The data directory is a 4 GB tmpfs, so that
  is resident memory by design.
- Recreating the container: **857 MB → 117 MB**, and the suite went from ~90s to
  **33s**. `bun run db:test:down && db:test:up` is worth doing between long
  sessions.
- Caching in CI was measured and rejected: `.cache/tsc` cold-to-warm is 2.27s →
  0.07s, `.cache/lingui` 0.72s → 0.46s, and `.fallow` is inside the noise (4.09s
  cold against 4.34s warm). Against a `test` job of 197–250s that is 2.5s, and a
  cache of *analysis results* is the failure mode this branch has already paid
  for three times. The dependency cache in `setup-bun` is the one that earns its
  keep.

## Found and not fixed

- **The old-generation collector only collects its own name.**
  `dropMyOldGenerations` drops schemas sharing its `w<worker>[x<isolate>]`
  suffix, and worker assignment moves between runs — so an isolate namespace's
  older migration hashes are never asked for again. Measured: 594 relations,
  7.6 MB, against 1,716 relations and 1,025 MB for the live generation. Small,
  monotonic, and the collector's comment explains why it is not a whole-generation
  sweep ("ran serially on the one connection and took minutes").


- `test/support/factories.ts` is on Fishery's `onCreate` with the database as a
  transient — 407 lines to 172. It was deferred until the driver moved, and the
  driver has moved: `TableFactory.insert`, the string-built `INSERT`, and the five
  bare `INSERT INTO`s in test files are all gone.

- Secret scanning and push protection are both `enabled` on the repository.
  `secret_scanning_non_provider_patterns` and `secret_scanning_validity_checks`
  remain off: they are paid features, not oversights.
- The first merged CI, security and CodeQL runs on `main` all passed.
