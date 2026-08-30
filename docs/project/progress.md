- **`./orch-server` brings up its own database.** The README's quickstart —
  `curl | tar`, then `./orch-server`, on a machine with Docker — could not work
  on any machine: the server opens PostgreSQL before it listens, and neither
  README nor any file a new user reads mentions `ORCH_DATABASE_URL`. The
  fallback the docs *did* name was not in the archive either; `release.yml`
  copied `roles config drizzle` and left `docker/` behind, so the one turnkey
  database this project owns was unreachable to everyone who installed the
  documented way.

  Unset now means `docker compose … up -d --wait` on the compose file shipped
  beside the binary, the variable still winning when it is set
  ([`051`](../adr/051-the-download-brings-its-own-database.md)). The password is
  a 600 file under `dataDir` because `POSTGRES_PASSWORD` is read once, on an
  empty volume, and a per-boot password would authenticate against nothing from
  the second start onwards. The published port is Docker's to choose — the
  compose file's `${ORCH_POSTGRES_PORT-5432}` publishes `127.0.0.1::5432` on an
  empty value — and the server asks `docker compose port` which one it drew,
  rather than assuming the one it asked for. Picking it ourselves would race the
  sandbox server's own ephemeral ports, which is a race this repository has
  already lost once.

  Measured on the compiled `darwin-arm64` binary, run out of a staged archive:
  no variable set and a fresh `dataDir` → `local PostgreSQL on 127.0.0.1:32770`,
  `/readyz` reporting `database: migrated and queryable`, panel 200. A second
  boot green against the volume the first made; a stop and start moved the port
  32768 → 32769, which is why it is asked for every time. `ORCH_DATABASE_URL` in
  a `.env` beside the binary is read and skips the container entirely — that
  path was undocumented and is now in both READMEs, as the place to put a secret
  that `config/default.yaml` cannot hold because it is committed.

  Five new guards, each shown red first: a regenerated password, a dropped
  `ORCH_DATA_DIR`, an error that stops naming its two ways out, a container that
  published nothing, and `docker` removed from the archive's copy list.

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

- Branch: `feature/project-discovery`, cut from `main` after #9 merged; the
  numbers below were carried from that branch and are re-measured per entry
- TypeScript, Oxlint, Biome, and Fallow audit: pass
- Tests: 1823 pass, 6 environment skips, 0 fail, 1829 across 225 files
- Coverage: 82.91% of statements, 73.12% of branches, 78.24% of functions
- Untested exports: 1 of 7,784 analysed (`EGRESS_IMAGE`, a constant naming the
  image the egress sidecar runs). Untested files: 3, all entry points — the two
  declared in `.fallowrc.json` and `web/src/app/main.tsx`, which `bundle-boots`
  builds and boots rather than imports
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

1. **Cut the first release under [ADR 050](../adr/050-the-bump-merging-is-the-release-request.md).**
   There is nothing to dispatch: `release.yml` runs after `ci`, `security` or
   `codeql` completes on `main`, reads the version from `package.json`, and
   releases it when `v<version>` is not published. Merging the bump is the
   request.

   That makes the next merge of a version bump the first run of the publishing
   half, which nothing has ever exercised — `dry_run` was the default, so every
   run to date stopped before `image-push`. What only a hosted run reaches: the
   image build on x64 **and** arm64, Trivy against the built image, SBOM
   generation, and provenance attestation, the last of those through
   `attest-build-provenance` and `attest-sbom` freshly on v4.

   A failure there is recoverable and that is the design: nothing publishes until
   every evidence gate passes, and `checks` refuses only a version already
   *published*, so the same version can be attempted again. A tag bound without a
   release resumes onto the same source.

   The publication half does not depend on a rehearsal to be trustworthy. A test
   walks every step in `release.yml` for a publishing verb — `docker push`,
   `gh release create`, `imagetools create`, a registry login, either attest
   action, `push: true` — and fails unless it sits in a job carrying
   `needs.checks.outputs.release == 'true'`. Naming the guarded jobs was a list a
   further job walks past.

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
- **The panel reads in nine languages, and the compiler owns the ids.**
  *(Superseded on 2026-08-23: ten languages, 1092 messages, and the catalogues
  moved to `locales/` — the entry 250 lines below records the move, and ADR 044
  the final shape. The numbers in this paragraph are what was true the day it
  was written.)* 811
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
  table. *(Superseded: 42 across 11 files at the end of the branch —
  `test/governance/server-chinese-baseline.json` is the number that is current
  by construction.)*

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
  says so in an `if`.** *(Closed later in the same branch, and not the way this
  entry expected: `answerDraftPrompt` is scaffolding for a model, which ADR 035
  exempts, so both halves became one English one rather than following
  `output.language`. `grep -rn "isChinese" src/` returns two comments.
  `answerDraftContext` returns `"standing"` unconditionally.)* `src/api/orch/escalation.ts:310` and `:339` branch on
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
  protocol, regexes and one prompt branch. *(Superseded: 42, and the prompt
  branch is gone.)*

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
locales** *(mid-branch; 1092 across ten at the end)*. A template that had drifted by one character would have shown up as
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

## A review pass over PR #9, and what it found

The branch changed design three times — react-i18next to Lingui, hand-written
ids to macros, `bun build` the CLI to `Bun.build` the API — and each pivot left
the previous one's shape somewhere. A read of the whole diff, plus
`fallow audit`, turned up five defects, one merge, and about forty places where
a hand-written table had a platform API underneath it.

### Five things that were wrong

- **A browser that refuses `localStorage` rendered nothing at all.**
  `startLocale()` is awaited before `createRoot().render()`, and it read storage
  outside its own `try` — on the strength of a comment saying
  `@lingui/detect-locale` owned that. `detectFromStorage` is a bare
  `globalThis.localStorage.getItem(key)`. Chrome's "block all cookies" and
  Firefox's `dom.storage.enabled=false` make the *getter* throw, so the entry
  point rejected: a blank page, which is the failure the `catch` above it was
  added to fix for a 404'd chunk. `setPreference` had the mirror bug — it wrote,
  swallowed the refusal, then *re-read the store*, so under the same policies
  picking a language silently did nothing.
- **`scanners-scan` could not see any of the nine guards this branch added.**
  Its pattern was `new Glob(`; every new guard writes `new Bun.Glob(`. Five of
  ten literal patterns invisible, and `toBeGreaterThan(3)` green on the other
  five. The one test whose entire job is "no guard scans nothing".
- **`i18n-progress` reports 100% for a catalog with no messages.** This file
  exists because `"100%"` once counted a row whose translation was the English;
  `total === 0 ? 100` is the same reasoning one step up.
- **`URL.pathname` is percent-encoded**, in the three places that build an
  absolute path into the checkout. Under `~/My Projects` the `OURS` pattern
  matches nothing, which by its own note is not a build error but every macro
  left unexpanded.
- **`hourOnly` blanked the minutes of an already-whole hour** — a no-op except
  on a half-hour offset, where it labelled `Asia/Kolkata`'s 14:30 bucket 14:00.
  Its formatter was byte-identical to `clock`'s.

### Intl already knew

The largest single finding, and the one worth carrying forward. `localeOf` was
ten ordered regexes; `endonymOf` ten literals; the settings page had five `msg`
descriptors for `min`/`hr`/`day` and two for `Just now`/`waiting {span}`.
`Intl.Locale.maximize`, `Intl.DisplayNames`, `Intl.NumberFormat({style:"unit"})`
and `Intl.RelativeTimeFormat` answer all four, in ten languages, from the CLDR
the runtime already ships — and get three things right the hand-written versions
got wrong: `ドイツ語` in the language knob (no Japanese word for German existed
in the table), the missing space in `20分钟`, and `il y a 20 min` where an
interpolated suffix cannot put the phrase in front. Sixty translated rows left
the catalogues. Recorded as a rule in ADR 044.

### The knobs' free-text parser had no caller

`parseDuration`, `parseCount`, `parsePercent`, a 21-entry alias table and three
of the four `WANTS` rows. Every shape returns its own editor — a digits box and
a unit menu — before the text box is reached, so the comment on `Amount` saying
*"the parser stays — `20 分钟`, `3h`, `8M` all still work"* was the last thing
left of it. `units.ts` 276 → 194 lines.

### Nine guards had a copy of one loop

`test/support/ast.ts` had taken the parse options and the `CJK` class and
stopped there. It now owns the CJK walk (the two guards using it had already
drifted — one could not see `RegExpLiteral`), the glob loop, and the exemption
rule, which was "from the marker to the first blank line or the first line
starting with `)`, `]` or `}`" and is now babel's `leadingComments`. Two more
hand-written bracket matchers went with them; a third guard was a regular
expression over raw source, so a *comment* saying `cfg.language` failed the
build.

### Two enums for one fact

`ask-boss` took a `kind` that chose a queue heading and fell back to `other`,
and a `reserved` topic that chose the routing and fell back to sixty lines of
per-language keyword regex. One required word does both now, and the property
the merge cost — the old flag could only ever raise — is bought back at the
answering end, where a second reader that is not the asker is shown the
question. ADR 045.

### Also

- `bun run audit` on a push to `main` scanned `origin/main..HEAD`, which is
  nothing. Verbatim the reason it was taken out of `nightly.yml`.
- The suite's PostgreSQL was three copies of one step under three copies of the
  same six-line comment; it is an input on the composite action all three jobs
  already use.
- `fallow audit --gate all` is at zero findings for the first time on this
  branch: the last unused export and the last clone group are gone.
- ADR 041 is superseded by 044. Six of its passages described a design replaced
  while the branch was still open, including the bundle table — which said
  +4.7% where the artefact measures −13.4%, because the two findings that moved
  it (React's development runtime, and the ICU parser) are not i18n.

## A third pass, and what a user found that three explorers did not

The branch was read twice more — three parallel explorers over the whole diff,
two design passes on the pieces ADR 042 and 045 had left open, and the branch's
own tooling turned on itself again. What actually opened the round was a
screenshot: a Chinese page with one line of Portuguese in it.

### The screenshot

`readJson` rendered the `Said` the moment the response landed, and four call
sites keep that string — `Repos` in `useState` until the next fetch, each knob
row until the boss fixes the value. `I18nProvider` re-renders every `useLingui`
consumer on `activate`, but a string in state consumes nothing. So the heading,
the button and the host-check banner all followed the locale menu and the red
line between them did not.

Fixed at `readJson` rather than at the four call sites: `ApiResult` carries
`said` beside the server's own `text` and nothing is rendered until it is shown,
so there is no pre-rendered string left to store. That half is what stops the
fifth caller doing it again. `translation-resubscribes` learned `saidText(`,
`refusalText(` and `labelOf(` — the same defect one `memo` away.

It is the branch's own lesson, one turn further on. Separate the key the machine
matches on from the prose a person reads, then separate the descriptor from its
rendering.

### Hardcoded language lists, once that was the thing being searched for

Reviewing the ADR 046 commit, the boss asked why a two-language lexicon was
being defended in a branch whose whole argument is that they do not work. Three
more turned up, and one of them was not in Chinese, so no guard here could see it.

- **`FILLER`** refused a journal containing `basically` or 其实. The comment
  written for it called it "a cost nudge, not a correctness gate"; the code
  returns `ok: false`, which is a 400. And `validateJournal` caps the body at six
  lines four lines above — "be terse", counted rather than recognised, in every
  language. A lexicon beside it was a second enforcement owner of one rule.
- **`NOT_ENGLISH`** in `checkPrMessage` was kana, Han and hangul: three
  hand-picked ranges from when the only other language was Chinese. `перенести
  проверку`, `μετακίνηση ελέγχου` and `نقل الفحص` all passed. Unicode has the
  rule itself.
- **`validateSelfReview`** counted `ok`, `met` and `not met` as verdicts and
  refused a fixed list of English non-answers, so `looks ok` counted and
  `bestanden` did not. `pass|fail` is what the two role files hand out.

`src/` is at 26 Chinese literals across 10 files, from 407 across 36, and the
four left in `validate.ts` are `ALIAS`'s legacy DRAFT headings — retiring at
0.2.0 against an assertion `version.test.ts` now carries, rather than against
three comments saying so.

### The one that was refusing correct work

`GENERIC_GATE` is a false-positive *suppressor*: when it misses, the enclosing
"nested acceptance criteria" refusal fires. Measured on one card written seven
ways — German, French, Spanish, Portuguese and Russian **refused**, English and
Chinese accepted because the pattern knew those words, Korean and Japanese
accepted only because `테스트통과` is five characters and falls under an
eight-character floor. The verdict depended on script density, twice per card
since approval re-validates. The card's own `## accept` is the list, already
parsed four lines above the call. ADR 046.

### The wall ADR 042 built around turned out not to be one

042 deferred L2 fencing because promptpurify's nonce is random per call and its
preamble names it in the system text, so fencing appeared to move
`StablePrompt.hash` every turn. Reading the installed package: the caller cannot
supply a nonce and the fence primitive is not exported, so 042's own proposed fix
is unreachable — and the nonce does not belong in the hashed half anyway. It
buys the property that an attacker cannot *close* a fence they cannot guess, and
that needs it only where the fence is. A constant notice in `systemAppend`, every
fenced block in the delta, and `needsRotation` cannot see fencing at all. ADR 047.

042 also claimed L2 has no false-positive cost. It does: hardening strips
indentation and chat-template tokens from what it fences, which is why `mail.body`
is not fenced — `finishLease` puts a test log there.

### Measured

| | |
|---|---|
| `bun run test` | 1848 pass, 6 skip, 0 fail, 1854 across 226 files |
| `bun run preflight` | fifteen steps, 116.7s, all green |
| coverage | 82.91% statements, 73.12% branches, 78.24% functions |
| `fallow audit --gate all` | no issues in 340 changed files |
| `web/dist/main.js` | 1,470,385 B |
| `endonymOf` over the ten | 55.6µs → 0.147µs |
| the CLDR name table | eager 2.08ms → lazy, and never built on the panel's path |
| `buildMessages` at 20kB | 0.306ms, CPU only |

### Not taken, with the measurement that decided it

- **Deleting ADR 041.** It was added and superseded inside one branch, which
  reads as redundant, but it is the record of why a hand-written key layer looked
  necessary and of the measurement that removed it.
- **`getFormat()`/`FormatterWrapper` in `i18n-hant.ts`.** The API is real and
  filename-in, filename-out; `hant(po, existing)` is deliberately string-in,
  string-out so a guard can drive it over three messages.
- **Merging the two bundle guards.** Measured 484ms and 722ms on different
  workers; merging would make a static assertion inherit a viewport fake and a
  temp directory to save a third of a second.
- **The eight-character floor in `overlapError`.** Still counts characters, so a
  dense script says more per character. It fails *lenient* — declines to refuse,
  which is how a hard refusal should fail — and the test says so rather than
  pretending uniformity.

## A fourth pass, on the shape rather than on the language

The boss read the ADR 046 commit and asked why a two-language word list was
being defended in a branch whose argument is that they do not work. That
question, turned into a search for the *shape*, is what this round is.

### The shape, and the three guards that could not see it

A guard that counts Chinese literals cannot see an English one. Two of the four
found here were English, and one was not a word list at all — three hand-picked
Unicode ranges. Every one of them was a **hard gate**:

- **`FILLER`** refused a journal containing `basically` or 其实. Its comment,
  written one commit earlier, called it "a cost nudge, not a correctness gate";
  the code returns `ok: false`. And the six-line cap four lines above already
  enforced terseness, in every language — a second owner of one rule.
- **`GENERIC_GATE`** was a false-positive *suppressor*, so a miss refused a
  correct card. Measured on one card written seven ways: German, French,
  Spanish, Portuguese and Russian refused; Korean and Japanese accepted only
  because `테스트통과` falls under an eight-character floor. Script density
  decided the verdict.
- **`NOT_ENGLISH`** in `checkPrMessage` was kana, Han and hangul, so
  `перенести проверку` and `نقل الفحص` walked past ADR 035's "commits are
  English, always".
- **`validateSelfReview`** counted `ok`, `met` and `not met` as verdicts and
  refused a list of English non-answers, so `looks ok` counted and `bestanden`
  did not.
- **`--why has to say it in a sentence`** was `why.length < 10`: `需求二已完全覆盖`
  is eight units and four words and was refused, while `ok i think` is ten units
  and two words and passed.

Each replacement is something the runtime or this repository already owns —
`terms()` for word counting, `\p{Script=Latin}` for the script test, the card's
own `## accept` for the boilerplate list, the line cap for terseness, and the
`pass|fail` the role prompts hand out.

### The same defect as the screenshot, in two more places

**The timeline** rendered `meta.say` at ingest and appended the string to
`useState`, so every row was frozen in the language its SSE frame arrived in —
the surface with the most rows. **The burn chart's tooltip** drew the bucket key
`08-13 20` beside a trend axis this branch had already taught to say `13.08.`.

And two disclosure buttons guessed a display width from `text.length`: at
`line-clamp-3` and `max-w-[72ch]` a CJK glyph is about two columns, so a
150-glyph Korean verdict was clamped **with no way to open it**. `useClamped`
asks the browser.

### Sentences that never reached a catalogue

`standup.ts` composed three in English and handed them to `bus.emit` as
`body: item.body` — an identifier at the emit site, so
`an-event-names-its-sentence` saw data passing through. `batchForBoss` composed
another two and pushed them straight at the webhook, twelve lines below the
`Notifier` method that renders its own summary in ten languages. Both are the
same blind spot: the guard reads the emit site, and the sentence was written one
file away.

### Two live bugs that were not about language at all

- **A card that lost the payload race left its fenced block behind.** Introduced
  by the fencing commit; `escalationCard` and `digestCard` pushed their quoted
  span as a side effect while only the last card survived.
- **The boundary turn lost the command it exists to issue.** `group.ts` enqueued
  `{ boundary, idea }` and `idea` is later in the list, so `orch owns <id>
  --path …` was replaced by "The boss wants: …". In production, before this.

### Measured

| | |
|---|---|
| `bun run test` | 1854 pass, 6 skip, 0 fail, 1860 across 226 files |
| `bun run preflight` | sixteen steps, all green |
| `fallow audit --gate all` | no issues in 351 changed files |
| `web/dist/main.js` | 1,470,667 B |
| preflight's second suite run | deleted — CI runs only the instrumented one |

### Not taken, each with the measurement

- **`slug.ts`'s eleven-word English `STOP` list.** Pointing it at `terms()`
  looked like deleting the last hand-written lexicon in `src/`. Retrieval drops
  words carrying no *search* signal and a branch name wants the opposite:
  `slug("remember-me")`, a name the caller chose, came back `remember`.
- **`terms.ts`'s missing German, Spanish and Dutch stop lists.** Its own comment
  has the measurement — `die`, `no` and `hier` would each eat an English word,
  and `net` and `hit` are identifiers here.
- **`mdast-util-to-string` for `textOf`.** Five lines, but it is transitive
  today and adopting it means promoting it to a direct dependency.
- **The eight-character floor in `overlapError`.** Still counts characters. It
  fails *lenient*, which is how a hard refusal should fail.

## A fifth pass, on what two owners look like when neither is Chinese

Four passes had gone over this branch and it was green — `typecheck`, `lint`,
`fallow audit --gate all` on 356 files, no `TODO` in the tree, nothing left in
*Next executable items* that is not the boss's call. So this pass looked for the
shape the earlier four were not scanning for: **a rule written down twice**,
where neither copy is in the wrong language and so no guard here could see it.

### A twenty-six-row transcript of a four-line rule

`KNOB_SHAPE` keyed a config path to `ms|seconds|percent|count`. Its own guard
then checked the table against `/(Ms|Seconds|Fraction)$/` — so the rule existed
as a rule *and* as a hand-written copy of itself, and every one of the
twenty-six rows followed the suffix with no exception. `shapeOf(path)` is the
rule; the guard now asserts completeness instead of transcription, and was shown
failing with the `Ms` row commented out.

It also answers for a path the table had no row for. `intervals.notifyBackoffMs`
is `z.array(count)` — a reminder ladder — and the suffix says `ms`. Unreachable,
because `scalarValue` sends only `type === "number"` to `numberValue`. But the
ladder does render as `300000, 900000, 3600000` on the settings page, which is
the defect `units.ts` exists to prevent, in the one shape it cannot reach. In
**Found and not fixed**.

### The fifth Intl, in the place four passes had already walked past

"Intl already knew" was the largest finding of the review pass and it named four:
`DisplayNames`, `RelativeTimeFormat`, `NumberFormat({style:"unit"})`,
`Segmenter`. Five call sites still wrote `names.join(t`, `)`, which made `", "`
a catalogue row translated nine times — and a joined string cannot produce the
conjunction, so every one of those sentences was missing the word its language
puts before the last name. `Intl.ListFormat`. 1100 messages to 1099.

`type: "unit"` reads like the mode for a plain enumeration and is not: it is for
measurement, so CLDR renders `zh` with **no separator at all** — `abc`, and `ja`
with a space. That much is pinned. What is *not* pinned, and is the better
finding: `style: "narrow"` looks like the remaining answer and its output moves
with the runtime's ICU data — the same commit renders `zh` narrow as `a、b和c`
on Bun 1.3.14/macOS and `a、b、c` on the Linux runner. The first cut of that test
asserted the local answer and went red on CI, which is the second time this
branch has measured one machine and written down a universal. The sixth call site
— repository paths in a monospace span — is a plain `join(", ")` for that
reason: data, like the SI symbols in `duration()`.

### Two owners for which word names a card's goal

`validateDraftCard` parsed a card through `fieldOf`; the panel matched the same
heading with a `(goal|目标)` regex of its own, across the `web/src` boundary.
They had disagreed once already — `startsWith("目标")` against a Markdown card —
and that fix left the second copy standing. The vocabulary is
`src/contracts/card.ts` now and the panel keeps only the two *shapes* a heading
can have.

The guard that was **not kept** is the point of this entry. "Both sides read the
same goal off the same card" passes against the old two-owner code too, because
both spellings were in both copies — a guard that cannot be shown failing is
evidence of nothing. What replaced it is `nothing but the contract maps a
Chinese heading to a card section`, red against the previous `prose.ts`.

Two ratchets moved with it: the 0.2.0 shim list in `version.test.ts` goes from
three markers across two boundaries to two in one, and the Chinese-literal
baseline moves four counts between files — both edits required, since it refuses
a shrinking count as well as a growing one.

### A dependency argued away in a sentence

`scripts/lingui-catalogs.ts` said "there is none for Bun, which is the only
reason this file exists rather than a dependency". `bun-plugin-lingui-macro` is
on Lingui's own tooling page — community, MIT, v1.1.3, 2026-04-07 — and does
both this file's job and `lingui-macros.ts`'s. Nothing in the branch named it,
and `docs/standards/dependencies.md` says declining needs measured evidence.

Read at 1.1.3 and declined on four, the first of which is not an option it takes:
a compilation error is a `console.warn`, so a broken plural becomes a blank span
in one language instead of a failed build. Then: no seam for the test loader
(its map is `sourceMaps: "inline"`, and `oxc-coverage-instrument` wants an
object), no cache (+22% CPU), and a `filename` relative to `process.cwd()`,
which is the bare-basename coverage failure this repo already pinned absolute.
ADR 044 carries it with the reopen condition.

### The PR body disagreed with itself in six places

The top table and the Evidence block at the bottom were measured a round apart:
1855 against 1817 passing, 226 against 223 files, sixteen steps against fifteen,
356 against 324 changed files, 1,470,702 B against 1,470,287, and a message count
of 1092 against the README's own generated 1100. The same defect this branch
found in ADR 041's bundle table. One run now, one set of numbers, quoted nowhere
else.

### Measured

| | |
|---|---|
| messages, all ten catalogues at 100% | 1099 |
| `bun run test` | 1860 pass, 6 skip, 0 fail, 1866 across 227 files |
| `bun run preflight` | sixteen steps, all green, 73.2s |
| `fallow audit --gate all` | no issues in 358 changed files |
| `web/dist/main.js` | 1,470,333 B |
| coverage | 83.09% statements, 73.13% branches, 78.30% functions |

### Not taken, with the measurement

- **Trimming the comments.** 28% of the changed `.ts`/`.tsx` is comment, and the
  top files run 60–85%. But `origin/main` is already 4.0 stacked JSDoc blocks per
  kloc against this branch's 5.3 — it is the house voice, not something this
  branch introduced, and `comment-blocks.test.ts` already caps a block at eight
  body lines. What was deleted is the one that was *wrong*: a second comment
  promising the free-text unit parser still takes `3h`.
- **Adopting `bun-plugin-lingui-macro`** — four measurements above.
- **`localeOf`'s free-text branch.** It looks like hand-written fuzzy matching,
  and it is, but it serves `output.language`, which ADR 035 and 043 argue has to
  stay free text. There is no `Intl` locale matcher.
- **`SECTIONS` and `KNOBS_ELSEWHERE`.** Hand-written path lists, but grouping and
  order are not derivable from anything and a guard already holds them.

### One finding was wrong, and the branch had already fixed it

Recorded here because the commit that carries it says otherwise, and a claim in
a commit body outlives the round that made it.

`refactor(knobs)` says the reminder ladder "still renders as three seven-digit
numbers, which is the defect `units.ts` exists to prevent, one shape out of its
reach", and an entry went into **Found and not fixed** saying the same. It is
**false**. The reasoning went from "`shapeOf` answers `ms` for
`intervals.notifyBackoffMs` and no number editor asks" to "so nothing gives that
knob a unit" — which does not follow, and was never checked against the render.

`mapValue` sends the path to `Ladder`, which splits every step through
`splitDuration` and draws it as a `DurationAmount`. It landed earlier in this
same branch, under `refactor(knobs): delete what the unit buttons needed`, and
`test/web/knobs-render.test.tsx` has held it since: *the reminder ladder is a
row per step, not a line of JSON* — three `第 N 级` rows, and an assertion that
no input holds the JSON. Re-run to confirm before writing this: 6 pass.

The half that is true is the one the test pins: `shapeOf` answers for a path no
number editor ever asks about. That is a property of reading a *name*, and it is
unreachable because `Ladder` gets its unit from `splitDuration` directly and
never asks `shapeOf` at all. The comment on that test said "the day an array
editor wants a unit is the day this line has to be read", which was the same
mistake in smaller type — that day is behind us, not ahead.

Not amended in place: five commits are pushed with CI on them, and this is the
failure `AGENTS.md` already names for a wrong label in a pushed commit — the tree
is correct, the claim is not, and the correction is cheaper written down than
rebased in. The generalisation is the one this branch keeps re-learning in
another costume: **a reachability argument is not a rendering argument.** Nothing
here is allowed to say what a pane shows without having rendered it, which is why
`knobs-render.test.tsx` exists.

## A sixth pass, on prose that restates a vocabulary the compiler owns

The fifth pass looked for a rule written down twice. This one asked a narrower
question and got more out of it: **where is a typed vocabulary restated as
prose** — in an error message, in a prompt, in a role file — with nothing
between the two. Every hit is the same failure: the word list grows, the prose
does not, and nothing fails.

### The gate's second reader was asked about a transcript

`chain.ts` shows a reserved question to a model that is not the PM, and the
paragraph it shows was `TO_BOSS` typed out in sentences. Its own comment said so
— "the list is `TO_BOSS` said in sentences" — and read as a note about placement
rather than as the defect it was describing.

`TO_BOSS` is a `Set`, and a `Set` cannot make a missing sentence a compile error.
So a sixth reserved topic would have raised at the **asking** end and been
invisible at the **answering** one, which is the half where the damage happens,
with nothing red: `chain.test.ts` pins the membership, and membership is not what
the second reader is shown. `RESERVED` is a tuple now and the prose is
`satisfies Record<Reserved, string>`. Shown failing by adding `env`: three type
errors. The generated string was diffed against the paragraph before the
paragraph was deleted — byte-identical.

### Two more of the same, found by asking the same question again

`validate.ts` spells `trivial|normal|hard` twice in rejection prose, beside the
`z.enum` that owns it — and four lines above, the same file already interpolates
`DRAFT_FIELDS` for exactly this reason, with the reason written out. A rejection
naming a tag the parser no longer accepts sends the model to write one it will
refuse.

`roles/*.yaml` carry four hand-typed lists: the nine ask kinds twice, "the first
five are the boss's alone" twice, the six card headings once. `dispatch.ts`
derives its `--help` from the contracts; the prompts, which are the only manual a
sandboxed agent has, did not. `roles-quote-the-contract` is the guard. Its third
assertion is the one worth having — "the first five" is a **positional** claim,
so it goes wrong the moment `RESERVED` and the head of `ASK_KINDS` disagree, and
no test of either list alone can see that.

A guard rather than templating the role files: templating moves the vocabulary
somewhere an author cannot read while writing the paragraph around it, for a list
that changes about once a release.

### And a fallback that live code had started writing into

`raise()` took `kind?: string | null` and four of its eight callers passed
nothing — a PR closed without merging, a PR that will not open, an approval that
did not take, a group out of budget. All four are the boss's own queue and all
four drew no topic chip, on the null branch `select.ts` keeps for rows filed
*before* the vocabulary existed.

Three of the four had the answer one line above them, in the `hold()` they sit
beside: `reason: "merge"`, `reason: "budget"`. The word was already written down
and the question next to it did not carry it.

Two owners, each doing the half it can: `AskKind | null` makes a wrong word a
compile error, and `every-question-names-its-topic` reads the call sites for a
missing one — because `kind` has to stay optional for the API path, where the
CLI has already refused it. Both halves shown failing, including the assertion
that the scanner reaches eight calls at all: this guard's failure mode is
otherwise silence, which reads exactly like success.

### Measured

| | |
|---|---|
| `bun run test` | 1864 pass, 6 skip, 0 fail, 1870 across 229 files |
| `fallow audit --gate all` | no issues in 360 changed files |
| new guards | 2, each shown failing before it was kept |

### Not taken

- **A helper for `raise` + `bus.emit`.** The two share eight lines at six sites,
  and `fallow` reports no duplication because four constant fields is not a
  clone. Two call sites is not a pattern; the emit's `say` differs at every one.
- **`kind` required on `EscalationRequest`.** It is the same object
  `api/orch/escalation.ts` builds from a validated body, where the CLI already
  refuses a missing one — requiring it in the type would push a redundant
  assertion into the API path to satisfy the compiler.

## The two compatibility shims are gone

`docs/project/plan.md` puts "compatibility aliases before the first public stable
release" out of scope, and two of them had been standing since ADR 016 made cards
Markdown: `ALIAS` in `src/contracts/card.ts` mapped the six Chinese headings a
card carried before the keys became ASCII, and `draftLegacy` + `legacySlices` in
`src/mech/util/validate.ts` parsed the one-line `key : value` form.

The reason they survived is worth writing down, because it was a good reason that
had stopped being one: `test/governance/version.test.ts` held a guard scheduling
their deletion for 0.2.0 and *requiring them to be present* until then. That is a
release schedule enforcing what the scope rule forbids, and the schedule won for
two releases because it was executable and the rule was prose.

The precondition the code itself named — `validate.ts` said "once no `note` row
with `draft_card` predates the Markdown format" — is a query, so it was run rather
than guessed: this machine's database holds **zero** `draft_card` rows, which
cannot speak for a live deployment but is the answer here. A stored card in the
old shape would now be refused, and the repair is one `UPDATE` of that row's
`body`, not a parser kept forever.

### What replaced them is how they fail

`draftMarkdown` already returned `null` for a card with no headings; the fallback
swallowed that. Now it is a rejection that names the six headings to write —
the Dispatcher rewrites from the rejection, so a refusal it cannot act on is the
same defect as a card that silently reads empty. The Chinese-heading card fails
as `missing sections`, which already named them.

Two readers, not one: `cardGoal` in `web/src/shared/prose.ts` drew a goal off the
inline form too. Left alone it would have shown the boss a goal for a card the
parser refuses — the exact split `no reader maps a Chinese heading to a card
section` exists to prevent, so it left with the parser's copy.

### Shown failing

The new guard was proved red before it was kept: with `fieldOf` teaching itself
the six Chinese headings again, `the two retired card shapes are refused by name`
fails; with the deletion in place it passes.

### The fixtures were the interesting part

Sixteen tests failed on the deletion and **none** of them was a parser test. They
were flow tests — group approval, DRAFT filing, the state snapshot, the HTTP
smoke — every one of which filed its card in the pre-Markdown grammar. Four web
fixtures did the same. The old shape had outlived its own code path inside the
suite, which is how it stayed invisible: the tests that exercised the pipeline
were all speaking a dialect the product had stopped emitting.

Two governance guards then priced the change correctly. The Chinese-literal
ratchet demanded its baseline follow the file *down* — `contracts/card.ts` 4 → 2 —
so the room cannot silently reopen; the eight-line comment cap refused an
eleven-line explanation. Both were doing their job on the first try.

### Measured

| | |
|---|---|
| `bun run typecheck`, `bun run lint` | pass |
| `bun run test` | 1860 pass, 6 skip, 0 fail, 1866 across 229 files |
| `fallow audit --gate all` | no issues in 14 changed files |
| deleted | `ALIAS`, `INLINE_FIELD`, `draftLegacy`, `legacySlices`, two scheduling guards |

### Not taken

- **The `navigator.language` and GitHub noreply readers.** `web/src/i18n.ts` and
  `git/ghlogin.ts` also accept older forms, and they stay: those validate input
  from a browser and from GitHub, which still send them. A compatibility alias is
  ours to retire; an external format is not.
- **Deleting `no reader maps a Chinese heading to a card section`.** Half its
  assertion — that the contract still holds all six words — went with `ALIAS`.
  The other half matters more now, not less: a reader that grows its own `目标`
  regex would accept a heading `validateDraftCard` refuses outright.
- **A migration for stored cards.** Nothing to migrate here, and writing one for
  a database this repository cannot see is speculation. The query that decides is
  recorded above instead.

## The Engineer had no cheap way to ask, and bootstrap's manual was wrong twice

Two prompt defects of the same class: **a role file stating something the
deterministic layer does not do.** A role file is the only manual a sandboxed
agent has, so a false sentence there is not a documentation bug — it is a move the
agent will not make, or one it will make wrongly.

### "Blocked on something only the boss can decide?"

That was the entry condition on the Engineer's only ask paragraph. The paragraph
below it is accurate — it lists all nine kinds and says the first five are the
boss's alone — but the *opening* tells the reader when the paragraph applies, and
an acceptance criterion it cannot pin down is not something only the boss can
decide. So the Engineer reads the whole block as not applying to it and guesses.

`src/api/orch/escalation.ts:80` is `chain: TO_BOSS.has(b.kind) ? "boss" : "pm"`,
and `RESERVED` is five kinds — `spec` reaches the **PM**, which can answer it
itself (`chain.ts` lets a stand-in answer any non-reserved kind, checked twice:
by the stored kind, and by a second reader shown the question). `qa.yaml` has had
"ask the PM for a better criterion" for as long as the file has existed. The
Engineer had the same road and no sign pointing at it.

The cost of not having it was already written down, in `sendBack`: "two failed
attempts usually means the acceptance criteria are wrong, not the code". Guessing
is not the cheap path — it is two rejected slices and then the boss anyway.

### Two false sentences in `bootstrap.yaml`

"It runs on the host, in this worktree, because the sandbox denies your own
process the writes an install needs." Both halves are wrong. `runInstall`
(`start.ts:99`) is `execLines(ctx, { grp: grpId }, cmd, { cwd: WORK })` — the
group's own container — and the agent's turn runs through the *same function*
with no confinement at all: `claude.ts` passes `--dangerously-skip-permissions`,
`codex.ts` passes `--dangerously-bypass-approvals-and-sandbox`, both with the
comment "the container is the boundary". There is no write the orchestrator can
make that the agent cannot.

Worse than inaccurate: `docs/project/plan.md` puts "silent fallback from
containers to host execution" out of scope, so the manual claimed we do the thing
the scope rule forbids. The real reason for the indirection is recording —
`orch setup` stores the command, and `ensureSandbox` replays it when a reaped or
killed container is rebuilt (`test/mech/restore-workspace.test.ts`). Run it
yourself and the next turn wakes in an empty container.

"…reach the package registries, and nothing else" describes an allow-list. The
sandbox has `denyDomains` and ADR 005 measured why: an allow-list cannot enumerate
every registry a project needs. An agent that believes it is behind an allow-list
does not try to fetch a toolchain — and fetching toolchains is exactly what the
next unit of work needs it to do.

### Both claims are now guarded, and both guards were shown failing

- `a role naming a kind as the PM's is naming one the PM can answer` — reserve
  `spec` in `RESERVED` and it goes red. Narrowed with the contract's own
  `isAskKind` predicate rather than an assertion; oxlint refused `as never`, which
  is the rule working.
- `the role that describes the sandbox network describes the one in the schema` —
  rename `denyDomains` to an allow-list key and it goes red beside the paragraph
  that would have become false.

### Measured

| | |
|---|---|
| `bun run typecheck`, `bun run lint` | pass |
| `bun run test` | 1862 pass, 6 skip, 0 fail, 1868 across 229 files |
| new guards | 2, each shown failing before it was kept |

### Not taken

- **A new CLI verb for asking the PM.** There is nothing to add: `orch ask-boss`
  already routes by kind, and the name is the only misleading part. Renaming a
  verb every role file and the CLI help quote, to fix a sentence, is the expensive
  half of the fix.
- **A length budget on role prompts.** The lost-in-the-middle argument says to cut
  them, and this change *added* four lines to one. The audit is its own unit —
  doing it here would mean touching every role file twice.

## A project whose stack has no row now takes its gates from what CI runs

`detect.ts` is a table of six stacks. Miss it — Elixir, Zig, Swift, OCaml, a
Makefile whose target is not called `test` — and `detectGates` returns `[]`, which
`gate.ts` treats as **fail every slice**, with a message telling the boss to write
the gates by hand. That is the whole product refusing to work on a project it does
not recognise, and no table will ever have every row.

There is exactly one machine-readable statement of "what a clean machine does with
this repository" that exists in every language: the CI workflow. `Bun.YAML` is
already a dependency-free parser here (`load.ts:334` uses it for config and
roles), so reading one costs nothing new. `runsIn` walks the document
structurally rather than by key path, because a reusable workflow nests its jobs
and a matrix step is still a step.

### It is a fallback, not an override

A recognised stack keeps its convention. A CI step is written for a machine that
has the services CI starts — this repository's own test job needs a PostgreSQL
container — so preferring CI would trade "no gate" for "a gate that cannot pass",
and the second is worse: the first is visible as a missing gate, the second reads
as the agent's fault, once per slice.

### Only what could be a template

`lease.ts` tokenises on whitespace and never invokes a shell, so `make deps &&
make test` would hand `&&` and `make test` to `make` as arguments — a gate that
looks like it ran and did half of nothing. Anything with shell grammar, a
redirect, a substitution, or a `${{ … }}` only the runner can expand is skipped
rather than mangled.

### Measured, on this repository's own workflows

Running the extractor against `.github/workflows` — a repository the fallback
would never be used for, since `package.json` matches a rule — found two defects
that no fixture had:

| | first attempt | after |
|---|---|---|
| test | `bun run i18n:check` | `bun run test:coverage:ci` |
| lint | `bun run format:check` | `bun run lint` |

`check` in the test vocabulary matched `i18n:check`, and "first match in file
order" matched `format:check` before the `bun run lint` four steps below it. So
`check` left the vocabulary, and a command that *ends* in the gate's own name now
beats one that merely mentions it. Both cases are kept as a test.

The remaining answer is honest rather than good: `test:coverage:ci` is the slow
variant, and this repository's `ci.yml` never runs a plain `bun run test` at all.
That is the argument for the fallback being a fallback.

### Measured

| | |
|---|---|
| `bun run typecheck`, `bun run lint` | pass |
| `bun run test` | 1866 pass, 6 skip, 0 fail, 1872 across 229 files |
| `fallow audit --gate all` | no issues in 22 changed files |
| new tests | 5, covering an unknown stack, a rejected template, a recognised stack, silence, and the two measured defects |

### Not taken

- **CI overriding a recognised stack.** Above: a CI command assumes CI's services.
- **An unbounded read of the workflow directory.** Eight files, filtered by
  extension before anything is opened, once per project at its first clone.
- **Guessing at a step's `name:`.** It is prose in whichever of ten languages the
  author wrote it in; the command is the only part that is not.

### Two findings the audit made, both kept

`fallow audit` refused the change twice, correctly: `detectFromCi` was an exported
second door into detection with the rule table not in front of it, and both
`ciCommands` and `detectProject` breached the cognitive threshold once the
workflow read was inlined. The first is now internal — `detectGates` is the one
door — and the other two are split into `commandsIn` and `readWorkflows`.

## The gate believed any suite that exits 0

Three review layers ran on a slice and not one of them could tell a test from a
test-shaped file. `runGates` reads an exit code. `reconcile` compares claimed
paths against `git`. QA reads the diff — the same diff the same model wrote, with
its own prompt telling it not to re-read the module. So the cheapest way to turn a
slice green was to weaken a test, and the system had no layer that would notice.

This is the one thing Uncle Bob's pipeline has that ours did not: the Hardener,
the agent whose whole job is proving the tests would have caught the bug. His tool
is mutation testing. Ours cannot be — a mutation tool is a per-language dependency
and we run inside somebody else's repository — but the *question* generalises with
nothing but git: **put the slice's source back and run the project's own tests. If
they still pass, they distinguish nothing about this change.**

That is CLAUDE.md's own rule — "a new guard is shown failing before it is kept" —
which had been a human discipline enforced by whoever remembered it. The interview
this came from is blunt about that: "把人类的纪律强加给智能 Agent 可能是一个错误。
我们不需要强加纪律，但需要坚持人类的价值观." Keep the value, change the mechanism.

### Evidence, never a verdict

`recordDiscrimination` always returns without touching the slice's fate. A
refactor that legitimately edits its tests would go red on every slice, and a gate
with false reds is a gate somebody switches off. What it produces is a third word
in `gates_json` — `blind` — which the panel does not colour (`STOPS` is a
whitelist, `failed` tests for `"fail"`), and a question on QA's card: name the
criterion these tests discriminate, or fail the slice. The judgement stays where
judgement belongs.

### The parts that had to be right

- **Nothing runs on an unclean worktree.** Every step restores from a git object,
  so work that is not in one is work this would destroy. `git status --porcelain`
  is checked before the first write, and the check is skipped, not forced.
- **A new file is removed, not left standing.** `git checkout <base> -- path`
  cannot undo a file that base never had. Leave it and the tests written for that
  new module still pass — the check would report "distinguishes nothing" about a
  slice that distinguishes fine. Shown failing: comment out the `git rm` and the
  fixture goes red.
- **The restore is verified, not assumed.** `git checkout HEAD -- …` writes index
  and worktree, so a removed file returns with it; `stillClean` then asks git
  again, and a dirty answer raises to the boss rather than letting an agent commit
  from it. Shown failing: comment out the restore and two fixtures go red.
- **Non-zero is the healthy answer, compile errors included.** A test naming a
  symbol this slice introduced cannot build without it, and failing to build *is*
  the test discriminating.

### Measured

| | |
|---|---|
| `bun run typecheck`, `bun run lint` | pass |
| `bun run test` | 1876 pass, 6 skip, 0 fail, 1882 across 230 files |
| `fallow audit --gate all` | no issues in 43 changed files |
| new tests | 7 unit (no container), 2 end-to-end on real git |
| cost | one extra run of the `test` gate, on a slice that changed both code and tests |

The two end-to-end cases are the same slice shape twice, differing only in whether
the test would fail without the change — which a static gate template cannot
express, so the fixture's gate is a real command reading the worktree. Both were
shown failing with `discriminate: false` in config.

### Two guards caught the change on the way past

`knob-units` refused a settable knob with no section on the settings page — "a
control the boss cannot find" — so `discriminate` has a home beside `gateRetries`.
Then `version.test.ts` refused it again over six untranslated strings: the CLI
asserts an empty stderr, and lingui writes its missing-translation warning there.
Nine catalogues, filled by hand, `zh-Hant` generated.

### Not taken

- **Mutation testing.** Per-language dependency, installed into a repository we do
  not own. This measures a suite that distinguishes *nothing*, not one that
  distinguishes weakly, and that is the honest ceiling.
- **Failing the slice on `blind`.** Above: false reds are how a gate gets disabled.
- **Running it without a `test` gate.** A project verified by a build or a lint has
  no question to ask here, and asking it with the wrong resource would answer
  about something else.

## Every stack but this one arrived to find no compiler

`docker/agent.Dockerfile` holds bun, node, git and ripgrep — what *this* project
needs. A Rust crate, a Go module, a Python service, an Elixir app: the clone
succeeded, the install failed, and the group reported a broken repository. The
gate table was only the visible half of "orchestrator works on TypeScript
projects"; this was the other half, one layer down.

A longer image is not the fix. That same Dockerfile records why — 340.9s per group
for an agent to install a toolchain itself, against 3.8s for a prepared image —
but five toolchains preinstalled is a slow pull for the four nobody uses, and it
still has no row for the sixth.

### Rented, not written

[mise](https://mise.jdx.dev/dev-tools/) reads what the repository already declares
— `mise.toml`, `.tool-versions`, `.nvmrc`, `.python-version`, `.go-version`,
`.ruby-version`, `.java-version`, the `toolchain` line in `go.mod` — and installs
exactly that. One binary in the image, and the per-language install logic that
would otherwise have grown in `detect.ts` never gets written. `detectToolchain` is
a list of **filenames**, deliberately: a table of languages is the shape
`detectGates` is being moved away from, and a toolchain table would be that table
with longer rows.

Two details are what make it work non-interactively, and both are mise's own
documented answers rather than something invented here:

- **Shims on PATH**, not `mise activate`. Activation is for an interactive shell
  and nothing here has one; a shims directory means a gate command sees the
  toolchain without knowing mise exists.
- **`MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS`.** Idiomatic version files are off
  by default (`idiomatic_version_file_enable_tools` is `[]`) because outside a
  container they are somebody else's files. In here they are the whole point: a
  repository pinning its Go in `.go-version` and nothing else is exactly the one
  that arrives to find no compiler.

Pinned and checksummed like the Node tarball above it, and checked against the
release's own `SHASUMS256.txt` rather than against a second download of the same
bytes.

### Two ordered steps, not one string with an `&&` in it

`config_json.install` became `toolchain` then `install`, run by `runSetup` in that
order and both recorded — so a container rebuilt after its TTL replays both,
rather than waking with a checkout it cannot compile. The alternative was joining
them with `&&`, which is how you hide an ordering inside a string; the plan for
this round said `setup: string[]`, and two fields with names turned out to be
smaller and say more. Nobody has a third step.

`bootstrap.yaml` is told the toolchain is already handled and to check `mise ls`
before concluding a language is missing — otherwise the role whose job is "leave
this worktree able to build" would install a second copy of a compiler that is
already on its PATH.

### Measured

| | |
|---|---|
| `bun run typecheck`, `bun run lint` | pass |
| `bun run test` | 1879 pass, 6 skip, 0 fail, 1885 across 230 files |
| `fallow audit --gate all` | no issues in 45 changed files |
| image | one binary, pinned to 2026.8.10, both architectures checksummed |

### Not taken

- **`setup: string[]`.** Speculative generality: two named steps are the two steps
  that exist, and a list would have to be validated, ordered and explained.
- **Preinstalling toolchains in the image.** The measurement above cuts both ways:
  paying once beats paying per group, but only for a toolchain that gets used.
- **A `cacheDirs` entry for `/opt/mise`.** It would make the download per host
  rather than per container, and the field exists for exactly that — but
  `SandboxSpecSchema` warns that concurrent groups sharing a directory is how
  `node_modules` produced EEXIST, and nothing here has measured whether mise's
  install directory is safe to share. Left until it is.

## The next layer already has its parser, and it is being thrown away

The plan for this round had one more deterministic layer in it: **project-level
dependency boundaries**, the thing Uncle Bob describes as "一份 Agent 无法违反的
规范文件". `StoredProjectConfigSchema` carries gates, install, toolchain, shared
and sandbox — nothing about architecture — so a project driven by orchestrator
gets no boundary enforcement at all, while this repository enforces its own with
CLAUDE.md invariants 1–6 and fallow.

The plan's mechanism was a substring scan over import-shaped lines in the changed
files, with the ceiling written into a comment: dynamic requires missed, comments
mentioning a path falsely hit. That mechanism is now the wrong one, and the reason
is in this repository already:

`src/mech/knowledge/symbols.ts` parses six languages with real tree-sitter
grammars — go, javascript, python, rust, typescript, tsx — and its
`NOT_A_DECLARATION` filter **discards exactly the nodes a boundary check needs**:
`import`, `package`, `use_declaration`, `extern_crate`. The edges are already
being parsed and thrown away. ADR 034 is the decision that put them there
("symbols are parsed not matched"), and a substring scan beside a working parser
would be the same defect that ADR closed, one directory over.

Two consequences worth recording before the work is done:

- **No new dependency, and no regex.** Reuse `symbols.ts`'s parser and grammar
  table; a language with no grammar in the binary yields no edges, which fails
  open — the direction a boundary check has to fail, since a gate that blocks
  legitimate work is a gate somebody switches off.
- **A ratchet is probably better than an authored rule.** Authored rules need
  somebody to write them, a proposal path, and an approval tier. The edges are
  derivable, so the cheaper question is "does this slice introduce a cross-module
  edge that did not exist before?" — the same shape as the Chinese-literal
  ratchet this repository already trusts, and it needs no configuration at all.
  What it needs is a baseline, which is the part to measure before committing to.

## The reviewer's citations are measured before they are policed

The plan for this round had a layer requiring QA's verdict to cite something that
ran — `gate:<name>`, `lease:<id>`, a changed path — with each reference checked
against the slice's own rows. Writing it out is what killed it: **a citation that
resolves proves nothing about diligence.** The `test` gate runs on every slice, so
`gate:test` is a reference any reviewer can write without having looked at
anything, and the check would have felt like a floor while measuring only that a
name exists.

`--claim` works because git can *contradict* it — claimed files against changed
files. The reviewer's equivalent has exactly one contradictable form: a name that
is **nowhere in the worktree**. That is the shape a fabricated citation has, and
nothing else in a note is decidable.

So the layer that shipped is the measurement, not the gate. `citedPaths` pulls the
names out of the note — `mw.ts:31`, `src/a.ts`, `menu.png`, and not `0.1.2`,
`e.g.` or `github.com` — and each is looked up by basename with `git ls-files -co`,
which covers tracked files and the artefacts a browser lease wrote beside them.
Whatever is nowhere lands in the verdict event's `meta.unresolved`, where the boss
reads it on the slice's timeline. The verdict is filed either way.

This is deliberate, and the rule is the repository's own: **prove the hole before
writing the guard.** Nobody here has data saying a reviewer ever cited a file that
does not exist. If this never fires, that is a gate nobody has to build; if it
fires, the refusal writes itself and the message can name what was missing.

`qa.yaml` is told the names are looked up, because a measurement nobody knows
about measures the wrong population.

### Measured

| | |
|---|---|
| `bun run typecheck`, `bun run lint` | pass |
| `bun run test` | 1881 pass, 6 skip, 0 fail, 1887 across 230 files |
| new tests | 5 extractor cases, 1 end-to-end: `a.txt` resolves, `mw.ts` does not, verdict still 200 |

### Not taken

- **Refusing an unresolved citation.** See above: the hole is unproven, and the
  first version of this guard would have been sensitive to its own case.
- **`--evidence` as a structured flag.** It is the right shape when the data can
  be contradicted — `--claim` earns it — and the wrong ceremony when it cannot.
- **A pattern built from the note's own text.** `git ls-files -- '*name'` does the
  globbing with the name as an argument, so no regex is ever constructed from
  agent prose. Preflight flagged that exact class one commit ago.

## The Hardener shipped inert, and only a probe said so

The discriminator refuses to run on an unclean worktree — every step restores from
a git object, so work that is not in one is work it would destroy. That is the
right rule. What it was not measured against is **when the work is committed**.

`takeCheckpoint` commits the worktree at the *start* of a turn, so a turn's output
sits uncommitted until the next turn begins. The gate job is enqueued by
`task done`, inside the writer's own turn. So at review time the branch does not
contain the change being reviewed, `discriminate` found an unclean worktree, and
recorded nothing at all — on every slice.

Both end-to-end fixtures had committed their work explicitly, which is how a layer
with two passing tests can be dead in production. The probe was three lines: file
the same slice without the commit, print `gates_json`.

```
before   {"gate":"pass","self":"pass","reconcile":"pass"}
after    {"gate":"pass","self":"pass","reconcile":"pass","discriminate":"blind"}
```

The fix is one `checkpoint(git, WORK, …)` before the check, with the same helper
`takeCheckpoint` uses, so the commit carries the same trailers and sign-off and
`squashWip` collapses it like any other. Earlier than that commit would have
happened, not different in kind. The probe is now the test, and it is shown
failing by removing the checkpoint.

This is the rule the repository already writes down, met from the other side: a
guard that has only ever been green is evidence of nothing, and two green fixtures
proved only that the fixtures committed.

### And the two mise claims were reasoned, not measured

Shipped one commit earlier: `mise install --yes` as the toolchain step, and a
shims directory on PATH. Both were read off the documentation rather than run.
Measured now, against the pinned binary:

- `-y, --yes` is a global flag — `mise install --yes` parses.
- `mise install` **does** create shims (`shims/jq -> mise`), which the command's
  own help does not say: it says "installing alone will not activate the tools".
  Activation is `mise activate` for a shell; shims are the other mechanism and
  they are written at install time.
- A shim resolves per directory: in the configured worktree it runs mise's
  version, outside it falls through to whatever the image has.

The image itself is still never exercised — `release.yml` builds it, verifies its
digest and provenance, scans it with Trivy and writes an SBOM, but runs no command
inside it. A `docker run … mise --version` after the `load: true` build would have
answered the question above without a laptop, and is worth adding.

### The image is exercised now, on the runner that builds it

The two commands added to `image-build` are the two that were just run against a
locally built image, not a guess at them:

```
docker run --rm $image sh -c 'bun --version; node --version; npm --version; git --version; mise --version; rg --version'
    2026.8.10 linux-arm64

echo 'jq 1.7.1' > $probe/.tool-versions
docker run --rm -v $probe:/probe -w /probe $image sh -c 'mise install --yes; jq --version'
    mise jq@1.7.1 ✓ installed
    jq-1.7.1
```

That second one is the whole toolchain feature end to end: a repository pins a
version, `mise install` runs, and the tool is on PATH through the shims directory.
It runs on both legs of the matrix without qemu, because each platform builds on
its own native runner.

Also verified while there: `tar --strip-components=2 mise/bin/mise` lands the
binary on PATH, `/opt/mise` is 1777 as intended, and the shims directory is first
in `PATH`.

**Correction to the commit that added this:** it said the Dockerfile change had
never been built. Preflight builds it on every run — `orchestrator-agent:preflight`,
`--platform linux/amd64` — so it had been built each time and never *run*. The
distinction is the whole point of the step, so getting it wrong in the message is
worth fixing rather than leaving.

**And a stale note beside it:** `scripts/preflight.ts` records that "the arm64
build of this image currently fails, so a developer on Apple silicon is testing
the CI image rather than one they could run". It does not fail any more — this
image was built natively on arm64 here and its `mise --version` answers
`linux-arm64`. The comment stays where it is until the next change to that step
proves it in CI, but it is recorded here as known-stale rather than trusted.

### One script, three callers

The check now lives in `scripts/image-smoke.sh` and is called by preflight (which
already builds the image), by `security.yml` on **every pull request**, and by
`release.yml` on both architectures. A check that lives in one workflow answers
about one moment: at release is the wrong time to learn that the image does not
run, and arm64 is only covered by the release matrix, since that is the only
caller with a native runner for it.

## A project with nothing to run is a question, not a verdict

`gatesFor` returning `[]` meant "fail this slice", so a project whose stack no
rule recognises failed its first slice, then the next, then every one after —
each burning a retry against feedback no Engineer can act on. **Nothing an
Engineer does adds a gate.** The message even said so, and said it to the wrong
reader, once per slice, forever.

Absent and empty were the same value and are not the same answer:

| `config_json.gates` | means | what happens |
|---|---|---|
| absent | nobody has looked | one question to the boss per project, group held |
| `[]` | the boss looked and there is no floor | `gate: none` recorded, slice goes to review |
| names | the floor | unchanged |

Detection was writing `[]` when it recognised nothing, which is detection
answering a question that belongs to the boss. It leaves the key absent now.

The question is deduped on `no-gates:<projectId>` and filed at `chain: "boss"` —
this is one of the few things a stand-in genuinely cannot decide, since it is a
choice to accept work with no deterministic floor. The group is held rather than
sent back, so the slice keeps its retries for something a retry can fix.

`none` is the fourth word `recordGate` accepts, and like `blind` it is evidence
rather than a colour: `STOPS` draws the layer, `failed` tests for `"fail"` alone,
and a pull request that says `gate: none` has said something true that
`gate: pass` would not have.

### Measured

| | |
|---|---|
| `bun run test` | 1884 pass, 6 skip, 0 fail, 1890 across 230 files |
| new tests | 2, one per answer — the boss is asked once and the slice keeps `retries: 0`; an empty list reaches QA with `gate: none` |

### The audit's finding here was the phantom CLAUDE.md warns about

Plain `bun run audit` reported `carryOver` over the complexity threshold — a
function this change does not touch — because it reads whatever
`coverage/coverage-final.json` holds and estimates the rest "from export
references". `audit:crap`, which regenerates coverage first and is what preflight
runs, reports nothing. The page says exactly this; it is recorded again because
it cost a minute to re-derive.

## The one file that answers all three questions, read rather than run

A repository shipping `.devcontainer/devcontainer.json` has already written down
what this branch spent three commits working out: which image it develops in,
which toolchains it needs, and what to run once the clone exists. It is a spec
somebody else maintains, and reading it costs one file.

**Read, never run.** `@devcontainers/cli` consumes this file by *creating a
container*, and we have one — OpenSandbox is the boundary (ADR 005). Running it
would nest a container runtime inside the runtime, to learn three fields.

| field | becomes |
|---|---|
| `features` | `mise install --yes go@1.22 node@latest` — the tool version is in the feature's **options**, never its tag: `features/go:1` is version 1 *of the feature* |
| `postCreateCommand` / `updateContentCommand` | the install step, but **below** the rule table: a lockfile is the stronger statement, and `postCreateCommand` is often a whole developer setup |
| `image` | said to the boss and nothing more — which image a group runs in decides what every future turn has, and `Settings → Sandbox` is where that is decided |

Only the official `ghcr.io/devcontainers/features/*` namespace, and only the
names mise knows as tools. `docker-in-docker` is not a language and a third-party
feature does arbitrary things.

### The JSONC reader is written here, and the registry is why

`devcontainer.json` permits comments and trailing commas, and the templates that
ship it use them — so `JSON.parse` reads nothing from the one file that states a
whole environment. The correct library is `jsonc-parser` (Microsoft, no
dependencies) and its last release is **2024-06**, which
`docs/standards/dependencies.md` says to ignore. `json5` is 2022-12.
`comment-json` is current and pulls `esprima` — a whole JavaScript parser — to
strip comments. Reopen if any of them ships again.

So: a pass over the text, not a regex, because a regex cannot see that the `//`
in `"ghcr.io/devcontainers/..."` is inside a string. That is the defect the
ten-line version has on the first real file it meets, and it is a test.

### Measured

| | |
|---|---|
| `bun run typecheck`, `bun run lint` | pass |
| `bun run test` | 1890 pass, 6 skip, 0 fail, 1896 across 231 files |
| new tests | 3 for the reader (strings holding `//`, escaped quotes, commas), 3 for the fields |

### Not taken

- **`@devcontainers/cli`.** Above: it creates containers.
- **Applying the image.** A detected image that silently replaced the group's
  would change every turn's environment on the strength of a file nobody was
  asked about.
- **A table of features to tools.** The map is the *namespace* — a published
  registry where the feature is named for the tool — plus a set of which names
  mise knows. A feature outside it is left alone rather than guessed at.

## A declared task ranks with the conventions, not below them

`detectGates` had three layers: the rule table, then the CI fallback, then
nothing. Two sources were missing from the first layer, and both are a project
*stating* its test command rather than following a convention:

- `Taskfile.yml` with a `test:` task → `task test`
- `mise.toml` with `[tasks.test]` → `mise run test`, and mise is already in the
  image for the toolchain

Both are opened, not counted. A `Taskfile.yml` whose tasks are `build` and
`deploy` is not a project that runs `task test`, and the file existing says
nothing about what is in it — which is the difference between this and a marker
like `Cargo.toml`. `Bun.TOML` parses the second one, the way `Bun.YAML` already
parses the first, so neither costs a dependency.

**devfile is not here, deliberately.** Its `commandGroup: test` answers exactly
this question, and it is a Red Hat/Eclipse Che format that few repositories
outside that ecosystem ship — a rule that fires for almost nobody, over a nested
shape (`commands[].exec.group.kind`), is a row that will be wrong before it is
right. Reopen when a project that uses one turns up.

### Two real complexity findings, both taken

Not the CRAP phantom this time: `stripJsonc` was 21 cyclomatic and 34 cognitive
as one loop with four inline branches, and `detectProject` had grown to 151
lines. The scanner is now a loop over four named steps — `endOfString`,
`endOfLine`, `endOfBlock`, `closesNext` — which also makes the escape rule
readable, and the image announcement left `detectProject` as its own function.

### Measured

| | |
|---|---|
| `bun run test` | 1892 pass, 6 skip, 0 fail, 1898 across 231 files |
| `fallow audit --gate all` | no issues in 55 changed files |

## The boundary layer, built the way ADR 034 already decided

`StoredProjectConfigSchema` carries gates, install, toolchain, shared and
sandbox — nothing about architecture. This repository enforces its own with
invariants 1–6 and `fallow`; a project driven by orchestrator got nothing.

The plan for this round proposed authored rules (`boundaries: [{from, deny}]`)
checked by a substring scan over import-shaped lines, with the ceiling written
into a comment: dynamic requires missed, a comment mentioning a path falsely hit.
Both halves turned out to be wrong, and the repository said so:

- **The parser is already here.** `symbols.ts` parses six languages with real
  tree-sitter grammars, and its `NOT_A_DECLARATION` filter discards exactly the
  nodes this needs — `import`, `package`, `use_declaration`, `extern_crate`. A
  regex beside a working parser is the defect ADR 034 closed, one directory over.
- **Authored rules would have shipped inert.** They need somebody to write them,
  a channel to propose them and a tier to approve them — and a feature nobody
  configures is a feature that never fires, which this branch has already learned
  once today. The edges are derivable, so the answerable question is not "is this
  edge right" but **"is this edge new"**: the repository's own history is the
  statement, the same shape as the Chinese-literal ratchet already trusted here.

### Measured into shape, three times

`importsIn` was written against the grammars and then run against six languages,
which is the only way the shapes come out:

| | first attempt | after |
|---|---|---|
| Go | the whole `import (…)` block, plus each path with its quotes | `fmt`, `example.com/x/y` |
| Python | `from mypkg.sub import thing` → `"mypkg.sub import thing"` | `mypkg.sub` |
| Rust | correct from the start | `crate::mech::gate` |

One generic fallback became one branch per node type, using the field each grammar
gives — `import_spec.path`, `import_from_statement.module_name` — because Go
spells its string node `interpreted_string_literal` and a generic `string` lookup
never matched it.

Then the resolver, the same way: `areaOf("src/gate.ts")` answered `src/gate.ts`
until it dropped the filename first, and a prefix walk answered `src` for `zod`
on the strength of `src` existing — which would have made **every third-party
package an edge**. A module name has to match a directory outright now; only a
relative path, whose last segment really is a file, may walk.

### Evidence, and the third reason is the honest one

`gates_json.boundaries: "new"` and the pairs on the event. Not a verdict, for
three reasons, and the third is not a hedge: the baseline is built from the files
an indexing budget read, so an unread area has no edges *recorded* rather than
none (checked, and an unread area is skipped); a language with no grammar here
contributes nothing; and **a new edge is often simply correct**. What it must not
do is pass silently — an agent wiring `web/src` into `src/mech` is exactly the
change a reviewer wants pointed at.

The baseline rides on the watchdog pass that already reads every tracked file to
build the repo map, so the graph costs one `Set` and no new I/O.

### Measured

| | |
|---|---|
| `bun run test` | 1899 pass, 6 skip, 0 fail, 1905 across 233 files |
| `fallow audit --gate all` | no issues in 61 changed files |
| new tests | 4 for the edge model, 3 for the check, 6 languages through the extractor |

`fallow` also caught the two functions sharing a nine-line parse preamble; they
share `parsed(rel, src, read)` now, which is also where the "free the tree either
way" comment belongs.

## What the mise cache measurement answered

`/opt/mise` is **not** a `cacheDirs` entry, and the reason is not the one the plan
expected. Concurrency was the open question: four `mise install` runs racing on
one empty shared directory all exit 0, with correct version symlinks — mise locks
its installs, and the `node_modules` EEXIST that `cacheDirs` warns about does not
happen here.

The blocker is trust, not races. A package cache holds archives; `/opt/mise/installs`
holds **executables that every gate then runs**. Sharing it between group
containers means a compromised toolchain in one group is code execution in every
other — and the group boundary is the product's main security claim. Paying the
download per container is the cheaper side of that trade.

If it is ever worth revisiting, the shape is per-project rather than fleet-wide:
groups of one project already share a repository and a branch, so they share a
blast radius already.

## The prompt-slimming premise does not hold at our sizes

The plan carried one more item from the interview: "把初始提示词精简到绝对最小值……
然后再在此之后使用确定性工具", because a long prompt puts its own rules in the
middle where a model stops attending to them. The work was to cut the role files.

Measured before cutting, which is what the item did not survive:

| in the stable prefix | chars |
|---|---|
| `ORCH_CONTRACT` | 5,360 |
| the largest role prompt (`dispatcher`) | 4,604 |
| the smallest (`pm`) | 1,045 |
| `FENCE_NOTICE` | 351 |

The whole fixed prefix is about **7k characters — under 2k tokens**. The
interview's "10 pages" is 20k characters of rules; we are an order of magnitude
below the case the advice is about. And the biggest fixed section is not a role
file at all: it is the protocol contract, which every role pays on every turn.

What actually fills a window here was measured long ago and is written in
`load.ts`: **tool results are 90% of a transcript**. Which is why `qa.yaml` and
`engineer.yaml` already spend paragraphs on that and not on brevity — "reading a
large file you did not need is the most expensive mistake available to you".

So the size argument buys nothing, and cutting on it would be trading a real risk
(removing something load-bearing from the only manual a sandboxed agent has) for
an imagined one.

### What did survive is a correctness argument

Three passages in `dispatcher.yaml` restated what `validateDraftCard` says when it
refuses a card — the twelve-line count and what counts toward it, the 1–5 slice
range, that every column is required. Two owners for one rule, and the validator's
copy is the one that arrives at the moment it is needed, with the actual numbers
in it. The prompt now says the refusal will name what to fix and tells the writer
not to carry the numbers from there.

The judgement a validator cannot make stays: what `trivial` versus `hard` costs
the boss, and that over-tagging burns quota.

### Not taken

- **A character budget guard on role prompts.** A ceiling nobody derived, over a
  number that is not the constraint. `docs/project/progress.md` records the same
  reasoning for the web bundle in ADR 019.
- **Cutting `ORCH_CONTRACT`.** It is the largest fixed section, and it is the
  protocol: the CLI verbs, what a lease is, how a turn ends. Every line of it is
  the manual for something an agent cannot discover by trying.

## The measure Uncle Bob gates on, rented rather than written

He measures CRAP, cyclomatic complexity and module size; this repository measures
them on itself with `fallow` and on the projects it drives not at all. That was
the one real gap left against his pipeline.

**A tree-sitter scorer was written first, and then thrown away.** It worked — the
node names were read off the grammars (Rust spells `if` an expression, Go spells a
switch case `expression_case`, Python has an `elif_clause` where TypeScript nests
another `if_statement`), it scored four languages correctly by hand-check, and it
cost no dependency. It covered **six** languages, which is the number of grammars
in this binary and the ceiling on every answer it could ever give.

[`lizard`](https://github.com/terryyin/lizard) covers twenty-two — Kotlin, Swift,
Scala, PHP, Ruby, Zig and the rest — with a per-function CCN. Measured before it
was taken:

| | |
|---|---|
| image cost | **+49 MB**, with `pip` purged again, against 1.5 GB already there |
| released | 1.24.0 on 2026-08-19, nine days before this |
| checked | Kotlin and Swift both scored in the built image, which no grammar here can parse |

`scc` was the other candidate and is not it: its complexity is a per-*file*
estimate done "almost for free ... a cheap lookup when counting", which is not a
number a reviewer can act on.

Installed with `pip install`, which is what its documentation says. A wheel
unpacked onto `PYTHONPATH` was tried first and lizard cannot find
`lizard_languages` that way — sixty megabytes is not worth wiring a dependency the
unofficial way, which is a rule this repository already writes down.

### A ratchet, and the threshold is his number

`newlyComplex` compares the changed files' functions before and after, by name, and
reports the ones this slice put **over** the line that were not over it before. A
project this system did not write is full of functions over any useful threshold;
refusing every slice until somebody fixes them is a system nobody can adopt.

The line is **6**, which is what he gates his own agents at — against 4 for a
human, because a model holds more of a function at once than a person does — and
he is considering 8. Six is the published figure and the conservative end.

The base revision is staged by git *inside the container*, in one command rather
than one per file, because lizard reads files and each container round trip is a
review's budget.

### Measured

| | |
|---|---|
| `bun run test` | 1905 pass, 6 skip, 0 fail, 1911 across 234 files |
| `fallow audit --gate all` | no issues in 65 changed files |
| new tests | 4, against real `lizard --csv` output copied from a run in the image |

The CSV fixture is not invented: it is what the image printed for a JavaScript, a
Kotlin and a Swift file, which is also the proof that a quoted signature holding a
comma does not shift the columns.

### The layer that decides how old the image's OpenSSL is

Trivy failed the container scan on `CVE-2026-14456` — `libssl3t64` 3.5.6 against a
Debian fix already published as 3.5.7. Nothing in this branch introduced it: a
layer is a snapshot, the first apt layer's `apt-get upgrade` had been cached since
before the advisory existed, and every image built from that cache carries the
same OpenSSL however many times it is scanned.

What made it visible now is that the lizard layer is the **last** apt layer, so it
is the one whose cache decides the answer. It upgrades too, for the reason the
first one gives in its own comment: "installing without upgrading is choosing the
snapshot's versions on purpose".

`pip` is installed and purged inside one `RUN`, because a layer is additive and a
purge in a later one leaves every byte where it was — the difference between the
+49 MB this was measured at and what it would otherwise cost. Measured on the
built images: 1.36 GB before lizard, 1.43 GB after.

Trivy exits 0 on the rebuilt image, checked locally with the pinned 0.74.0 and the
repository's own `.trivyignore.yaml` mounted, which is the configuration the gate
uses rather than a different one.

### Nightly, for the record

`nightly.yml` failed on 2026-08-26 with `mean exceeded the significant-regression
budget: telemetry report (624ms > 600ms)` — four percent over, on `main`, on a
shared runner, and the 2026-08-27 run was green without a change. Not this branch,
and not fixed by anything here. A budget that flips on 4% of a 600 ms measurement
taken on hardware nobody controls is a gate that will keep doing this; recorded
rather than tuned, because tuning it from one sample is how a threshold becomes
meaningless.

## An ordinary event was throwing away every session in the fleet

`handToBoss` rotates the writer's and the reviewer's sessions at a slice boundary
and deliberately leaves the PM, the Dispatcher and the Auditor alone, with the
measurement written beside it: rotating everyone cost a full prefix rebuild per
role per slice, 45.5M tokens of cache creation across 259 turns, 95% of them
starting cold.

**A single new lesson undid that.** `buildStableFor` read `lessonsFor` fresh on
every turn and folded the result into the cached prefix, so the moment a retro
distilled a rule, every agent's `stable_hash` changed, `needsRotation` fired, and
every live session in the fleet was replaced — including the three whose context
was still true. Not the prefix alone: a rotation is a new session, so the whole
conversation goes with it.

Nothing was wrong with the code. Lessons are simply the one thing in the stable
half that **changes while the session is running**: the role prompt changes on a
deploy, onboarding about never, the model and the tool set when the boss says so.
A lesson lands because the system learned something, which is supposed to be a
good day.

### They live in the delta now

Paid for per turn, rotating nothing, and rendered after the work — a rule is read
in the light of the task, and the task is what the turn exists to do. Five of
them, not the twenty `lessonsFor` keeps: in a prefix nobody re-reads twenty cost
nothing and said nothing; in the delta they are paid for every turn, so what goes
in is what a turn can act on.

That is also the lost-in-the-middle argument applied where it is actually true.
The role prompts were never the problem — 7k characters of fixed prefix is not
"10 pages" — but a rule buried in a system prompt the model has stopped attending
to *is* the failure that discussion is about, and the newest user message is where
attention is.

### The guard that should have caught it, and the one that will

`cache-position.test.ts` asserted that changing the lessons rotates the session —
which was true, and was the bug: the test encoded the cost as if it were the
intent. It now asserts the opposite for lessons and keeps the property for the
things that genuinely belong in the prefix, and `executor.test.ts` proves the
whole path: a lesson lands, the hash is unchanged, the session resumes, and the
text is in the prompt and not in `systemAppend`.

### Measured

| | |
|---|---|
| `bun run test` | 1907 pass, 6 skip, 0 fail, 1913 across 234 files |
| `fallow audit --gate all` | no issues in 69 changed files |
| what a lesson used to cost | every live session in the fleet, plus its prefix |
| what it costs now | five bullets in one turn's delta |

## The per-file question, and the half of my own proposal that was wrong

The idea was: when the whole-slice revert comes back `blind`, revert one file at
a time to find which file's tests are the weak ones. **That is backwards, and it
would have run the suite once per file to learn nothing.**

`blind` means the suite passed with *every* source change reverted. Reverting one
file is a subset of that, so it passes too — necessarily, for every file, every
time. There is no information on that path.

The information is on the other one. A whole-slice revert that *fails* proves
something is covered; it does not say what. A slice that changed four files with
one of them tested reads exactly like a slice with four tested files. Reverting
each file alone answers it: one that can go back to its base revision without the
suite noticing has no test behind it.

`gates_json.discriminate` gains `partial` for that, beside `pass` and `blind`.

### Off by default, and the reason is where the cost falls

One extra test run per source file, on the path where the slice is **fine** —
which is most of them. That is a different bargain from the whole-slice check,
which costs one run and only on a slice that touched both code and tests. So it
is `discriminatePerFile`, off, beside `discriminate` on the settings page.

Both halves are tested, including the skip: with `perFile` on and the whole-slice
revert green, the fixture asserts the gate ran **once** — not once per file.

## The QA procedure was written, run once, and thrown away

His pipeline's QA agent turns a written procedure into an executable script. Ours
had the executable half already — `orch lease browser` takes JSON steps, which is
data rather than a script and is why running it is safe — and no durable half.
QA wrote `qa-steps.json` into the worktree, leased the browser, and the file was
gone by the next slice. So a reviewer verified the behaviour in front of it and
**nobody ever re-verified the behaviour behind it**: slice seven could break what
slice one was accepted on, and the only thing that would notice is a person.

A browser run that exits 0 is now kept, under `.orch/qa/` in the repository —
not in a note. It belongs in the pull request the boss reads, it diffs, and it
travels with the branch. Named by the hash of its own content, so the same
scenario recorded twice is one file and an edited one is a new scenario.

Every later slice replays the lot: one lease, not one per file, because the steps
are arrays and concatenate, and each set seeds the state it needs through its own
`api` steps. `gates_json.regression` carries the verdict.

**The orchestrator writes the merged file, never an agent.** A step file is data
the runner executes with real permissions, and who wrote it is the whole reason
that is safe — the same rule `roles/qa.yaml` states about the steps themselves.

`qa.yaml` is told, because a reviewer who does not know its scenario is kept will
write one that only makes sense while its slice is the newest — which is a false
alarm somebody else has to read.

### Measured

| | |
|---|---|
| `bun run test` | 1914 pass, 6 skip, 0 fail, 1920 across 235 files |
| `fallow audit --gate all` | no issues in 71 changed files |
| new tests | 5: what is kept, what is not, one lease for the whole suite, a project with no browser resource, and a slice that breaks an accepted procedure |

### Not taken

- **A note instead of a file.** It would be invisible in the pull request, and a
  QA procedure the boss cannot read is not a procedure they accepted.
- **One lease per procedure.** The suite grows; the leases would grow with it,
  each one a real Chromium.
- **Letting QA write into `.orch/qa` itself.** Ownership and `reconcile` are about
  the writer's claims, and a reviewer writing files into the branch is a second
  writer nobody declared.

## Three numbers that were each recorded somewhere and never in the same row

Duration lived in a span. Tokens lived in the cost report. The size of tool output
lived nowhere at all — so the largest claim anyone here has made about what a turn
costs, **"tool results are 90% of a transcript and every round re-reads them"**,
was measured once by hand in `load.ts` and could not be confirmed or contradicted
afterwards. The lever it points at — make tool output smaller at the source — had
no before and no after.

A turn now records all three on the event it already emitted:

- **`ms`** — the provider call's wall clock, timed around `invokeTurn` rather than
  read off a span, because a span answers *which step* is slow and this answers
  *whether this turn* was.
- **`transcript.bytes` / `transcript.toolBytes`** — weighed in both adapters where
  the bytes arrive, before anything trims them: a line carrying `tool_use_result`
  for claude, an `item.completed` that is neither the model talking nor an error
  for codex. What a turn cost is what the provider sent, not what the log kept.

`costReport` medians them over the same fifty turns the cache ratio and the
rotation reasons already sample, and the panel prints one line: `41s · 212kB ·
78% tools`. Medians rather than means, because one turn that read a 4 MB file is
exactly the turn a mean would let define the picture — and is also the turn worth
finding, which the burn chart beside it is for.

### Why this is one line and not three

The question nobody could answer was never "how many tokens" — that was there. It
was **which of the three moved**. A turn that got slower, heavier and more
expensive is one story; a turn that got slower alone is a different one with a
different fix. Three numbers on separate screens cannot be compared; one row can.

### One predicate for "this row is a turn"

`recentTurns` filtered on `jsonb_exists(meta_json, 'cacheRatio')` while `byHour`,
two functions above it, filtered on `usage`. Two spellings of the same question,
and the older key is `usage` — `cacheRatio` was added later, so the narrower
filter silently skipped every turn recorded before it. They ask the same thing
now.

### Measured

| | |
|---|---|
| `bun run test` | 1917 pass, 6 skip, 0 fail, 1923 across 236 files |
| `fallow audit --gate all` | no issues in 82 changed files |
| new tests | 3 for the aggregate — the three arriving together, one enormous turn not becoming the picture, and a turn from before this existed contributing nothing |

## Eleven grammars, because the ceiling was the number of `.wasm` imports

The boundary scan read six languages; `lizard` scores twenty-two. The gap was not
a design limit — `@vscode/tree-sitter-wasm` ships sixteen grammars and only the
imported ones reach the binary. Java, C#, C++, PHP and Ruby are now imported too:
408K, 4.9M, 5.1M, 1.0M and 2.0M, **13.4 MB against a 160 MB release budget**.

The remaining four the package ships — css, ini, regex, powershell — are not
languages a project's architecture is written in.

### Each one names its imports differently, and that was measured

| | shape |
|---|---|
| Java | `import_declaration` holding a `scoped_identifier` |
| C# | `using_directive`; an aliased `using X = A.B.C` imports `A.B.C`, not `X` |
| C++ | `preproc_include`; `"core/gate.h"` is the repository's, `<vector>` is the toolchain's |
| PHP | `namespace_use_declaration`, plus four `require`/`include` **expressions** — not calls, the way Ruby's are |
| Ruby | a `call` named `require` or `require_relative`, which is also how it spells everything else it does |

**Java and Go both call their node `import_declaration` and mean opposite
things**: Java's *is* the import, Go's is a block that names nothing itself and
holds one `import_spec` per line. `targetOf` tells them apart by what is inside.

### Two resolver defects the new spellings exposed

- **A target that is already a path must not be split on its dots.** `core/gate.h`
  became `core/gate/h`. A module name is split on `.`, `::` or `\`; anything
  containing `/` is a path, and its extension is dropped instead.
- **`src/main/java` is Maven's ceremony, not structure.** With two-segment areas
  every Java package in a repository shared the area `src/main`, so nothing could
  ever be an edge. An area is measured from where the code starts: a source root
  of more than one segment is stripped first. A bare `src` is not — it is already
  the top of a tree, and stripping it would rename every area this repository has.

### What still resolves to nothing, on purpose

A PHP project whose PSR-4 map sends `App\Core` to `src/Core` gets no edge from
that import. Composer's autoload is a config nobody here reads, and no edge is the
right answer to a question this cannot see — the same direction every other
unresolvable import fails in.

### Measured

| | |
|---|---|
| `bun run test` | 1919 pass, 6 skip, 0 fail, 1925 across 236 files |
| new tests | the five languages through the extractor, and every spelling through the resolver |

Twice in this change a `python` edit asserted its way to a clean exit **after**
raising, so the file was never written and the next measurement disagreed with the
code. Both times the symptom was the same: a language that extracted nothing. The
habit that catches it is the one already used everywhere here — measure after
every edit, not after the batch.

## A call that has never worked here stops being made

ADR 040 measured the index navigator failing **36 times out of 36** in one
seven-hour window — 20.5 seconds a call, 738.5 seconds of wall clock, 64% of every
error span in the system — while the lexical half it falls through to answers in
**0.32ms**. `search()` makes up to three serial calls, so every `orch ctx query`
in that window paid about a minute for three answers of `""`.

The ADR decided not to cut the layer, and this does not cut it: the default stays
on and the walk is unchanged. What stops is **repeating** a failure. Three
consecutive failures and the call is skipped, which is a different decision from
the one the ADR deferred and the one the wall clock was asking for.

Keyed by project, runtime **and model**, because the recovery must not be blocked
by the thing that noticed the breakage: the two settings events in that window
show both runtimes being tried and reverted, so changing either in Settings starts
a fresh count. One answer clears it — the count is of *consecutive* failures.

Said once, on the way past the threshold. The boss was already told 43 times that
the index would not build; nobody was told that asking had stopped being worth its
clock.

### Measured

| | |
|---|---|
| `bun run test` | 1923 pass, 6 skip, 0 fail, 1929 across 237 files |
| new tests | 4: it stops after three, it says so once, a new model starts again, and an answer clears the count |
| what a query cost, when the navigator is broken | ~60s of model calls, now ~0 |

### Not taken

- **Cutting the layer.** ADR 040's reasoning holds: the failure is far more likely
  a credential or CLI problem than a verdict on tree navigation, and cutting on
  that is the mistake it names.
- **A retry with backoff.** Backoff answers "the service is briefly down". Thirty-
  six for thirty-six over seven hours is not briefly down, and a backoff would
  still pay 20 seconds to learn it again.
- **An in-process counter.** New mutable singleton state, which the invariants
  forbid — and it would forget across a restart, which is exactly when a
  misconfigured deployment restarts.

## A toolchain cache is not a package cache, so it is not shared the same way

`cacheDirs` mounts a host directory into every sandbox, and `/opt/mise` was the
obvious candidate: without it the toolchain is downloaded again every time a
container is rebuilt. The measurement said it was safe — four `mise install` runs
racing on one empty directory all exit 0, with correct version symlinks, because
mise locks its installs.

Concurrency was never what stood in the way. **A package cache holds archives;
`/opt/mise/installs` holds the executables every gate then runs.** Fleet-wide,
one poisoned toolchain is code execution in every other project's container, and
the group boundary is this product's main security claim.

Per project is the blast radius those groups already share — they share a
repository and a branch — so a host path may now hold `{project}`, expanded in
`specFor`, which is the one place that knows which project a sandbox is for. One
line of configuration gives every project its own cache instead of one entry per
project written by hand, which is the difference between a safe default and a safe
default nobody adopts.

Two smaller things came with it:

- **The directory is created before it is mounted.** A bind mount of a host path
  that is not there does not fail — it succeeds and delivers an empty directory,
  which is the silent failure `checkSkillsMount` exists for and exactly what a
  per-project path nobody made by hand would hit.
- **`driftingPaths` asks for the spec with no project**, so the placeholder
  becomes `shared` rather than being left literal. What that check does is ask
  whether the sandbox server allows a *prefix*, and any child answers it.

Still not on by default: the host path has to be in the server's
`allowed_host_paths`, and a default that silently mounts nothing is worse than no
default. The knob's own copy now says what the placeholder is for, because
Settings → Sandbox is where a boss meets this and the reasoning has to travel
with it.

### Measured

| | |
|---|---|
| `bun run test` | 1926 pass, 6 skip, 0 fail, 1932 across 237 files |
| new tests | 3: per project, with no project, and a path that has no placeholder |

## The resolver was guessing where the project had already answered

Two defects were fixed while adding five grammars — a path split on its dots, a
build root eating the area — and both were symptoms. The class was: **every rule
in `areaOfImport` is a guess about what an import string means, and three files in
the repository say it outright.**

Measured before anything was written, on the commonest real-world shapes:

```
go    github.com/acme/app/internal/gate  ->  null
ts    @/lib/gate                         ->  null
php   App\Core\Gate                      ->  null
```

That is **every real Go repository** — an internal import carries the module path
from `go.mod` and no directory ever will — most TypeScript ones, and the PHP
standard. The boundary layer was seeing almost nothing in three of eleven
languages while reporting no edges, which reads exactly like a clean repository.

`resolutionFrom` reads what they declare: `module` from `go.mod`, `baseUrl` and
`paths` from `tsconfig.json` (through the JSONC reader, because a real tsconfig
has comments), `autoload.psr-4` from `composer.json`. Aliases are applied longest
first, so `@/lib/` wins over `@/` where both exist.

It costs no round trip: the watchdog pass that builds the baseline already holds
every tracked file's contents, and the resolution is stored **beside the edges**
because a baseline built under one set of rules cannot be compared against a
change resolved under another.

### What it does not do

`resolutionFrom` is three exact mappings, not a module resolver. A Python
namespace package, a C++ `-I` path, a Ruby `$LOAD_PATH` and a Go `replace`
directive all still resolve to nothing — and nothing is the right answer, because
an unresolvable import is skipped rather than guessed at.

The precise answer exists and is not this: SCIP indexers and stack-graphs do real
name resolution, per language, against a working build. That is the right tool the
day a boundary finding becomes a **gate** rather than evidence. While it is
evidence, a missed edge costs a line nobody reads, and a wrong edge costs a
reviewer's trust.

### Measured

| | |
|---|---|
| `bun run test` | 1928 pass, 6 skip, 0 fail, 1934 across 237 files |
| `fallow audit --gate all` | no issues in 85 changed files |
| new tests | the three shapes resolving, a package that is still nobody's, and a project that declares nothing |

## The i18n audit was done by hand, which is how you find out it is not written down

Asked whether two new constants needed translating, the answer was easy — they are
protocol keys, the third exception — but arriving at it meant walking the whole
diff by hand: every `bus.emit` for a `say`, every value for a rendered fragment,
`src/` for new Chinese literals, `web/` for an unwrapped string. Nothing in
CLAUDE.md said to do that, and nothing said what "protocol key" covers.

Two halves were missing, and only the second is a rule anybody could have guessed:

- **A change that adds a sentence is not finished until ten catalogues carry it.**
  `i18n:extract`, fill the eight written by hand, `zh-Hant` generated from `zh`.
  It is enforced already and in a way worth knowing about: the CLI test asserts an
  **empty stderr**, and lingui writes its missing-translation warning there — so
  an untranslated string is a red suite, not a quiet gap. That cost a debugging
  round the first time it happened this branch, and six repeats after it.
- **What a protocol key actually is.** Narrower than it sounds: a key written into
  a table and read back, a stored verdict compared by value, a resource name.
  Nobody reads one as a sentence. A settings-page label, a question filed for the
  boss and a timeline row are none of those — and each of those was a place this
  branch nearly left in English.

The pull request template gains the half a command cannot check: `preflight`
verifies the catalogues, and it cannot verify that an English literal was
*exempt*. That sentence is the author's to write, so the template now asks for it.

## Two decisions this round made and did not write down

`docs/adr/` is where the build records **departing from the plan**, and this
round departed three times without an ADR for any of it. The reasoning existed —
every commit above carries it — but a per-commit narrative is read by whoever is
reading the commits. A decision is read by whoever hits the same fork next year.

- [**048**](../adr/048-a-project-states-its-own-gates-so-there-is-nothing-to-approve.md)
  — a project's environment and gates come from what it already committed, then
  mise, then the bootstrap agent. And why the plan's `proposed_gates` ladder was
  not built: its own tier 0 was "the command's head is an entry the repository
  declared", and once discovery was deterministic that is *every* command. Two of
  three rungs were unreachable.
- [**049**](../adr/049-the-review-half-gained-two-layers-and-neither-casts-a-vote.md)
  — why `discriminate` and `boundaries` produce evidence rather than verdicts,
  why the boundary layer is a ratchet against the repository's own history rather
  than the authored rules the plan specified, and why real mutation testing is
  one dependency per language in somebody else's repository.

The inert-layer finding is in 049 rather than only here, because it is the
argument: `discriminate` shipped present, configured, tested and silent, and two
green e2e tests proved nothing. That is what "authored rules would never fire"
means, stated in an artefact instead of as a prediction.

### Not written

An ADR for W4. The plan wanted every acceptance verdict to cite a real execution
and made that a refusal; what shipped **records** citations (`citedPaths`,
`validate.ts:451`) without refusing on them. That is a narrower change than a
decision — the criterion text still says what it said — so it stays in the commit
that made it.

## The layer the plan called "the agent", built as a check rather than a promise

`detectGates` reads a repository two ways and both can come back empty: the rule
table has no row for this stack, and the CI fallback found no workflow. The
answer then was `raise(kind:"env", chain:"boss")` — the product's own reason for
existing is other people's repositories, and the least-known ones went straight
to the person we are trying not to interrupt.

The fix is a split that was there all along and had never been named:

| | who can do it | does it run out? |
|---|---|---|
| **enumerate** what a repository declares | code, in any language | no |
| **classify** which of those is the test | a table, or an agent | the table does |

`declaredCommands` is the first column: package scripts, Makefile and justfile
targets, `Taskfile`/`mise` tasks, CI `run:` steps, `postCreateCommand` — all of
them parsed by readers `detect.ts` already had, none of them needing to know what
rebar3 is. The bootstrap agent, already in the container reading the README for
the install command, does the second. And then the answer is **checked**, not
approved:

- in `declaredCommands` → taken as it is, because the repository's owners merged
  it;
- not declared → run here through `proveGate`, which is the same `runOneGate` a
  real gate goes through, and kept only if it passes;
- neither → refused with the exit code, the output, and the list of what the
  repository does declare.

That last one is the tradition `planning.ts` set: a refusal that teaches beats a
refusal that is correct. `rebar3 eunit` in an Erlang repository with no CI is the
case the second rung exists for — undeclared, and a passing run is better
evidence than a declaration would have been.

### What was reused rather than written

- `runOneGate`, extracted from `runGatesInner` so a proof runs a gate the way a
  gate runs. A proof through a different path is a proof about a different
  command — the tokenisation, the lease timeout, the error digest and the
  off-context log are the parts that had to be shared, not just the spawn.
- `registerGates`, extracted from `detectProject`, so "a rule detected this" and
  "an agent proposed this" produce the same `resource` row. One writer, unchanged.
- `readRoot`, extracted from `detectProject`, so the check reads the repository
  the same way detection did and the two cannot disagree about what is in it.
- `taskIn` / `miseTask` became `yamlTasks` / `tomlTasks` — the rules ask whether
  the names include `test`, the enumerator asks for all of them.
- The timeline sentence is the one detection already emits, so ten catalogues
  needed nothing: one gate list, one way of saying it, whoever worked it out.

### The trust boundary did not move

`resource` still has one writer. Every template still has to survive
`isTemplate` — the rule `lease.ts` imposes, since it tokenises on whitespace and
never invokes a shell, so `make deps && make test` would hand `&&` to `make` as
an argument. That is refused before anything runs, with the reason, rather than
mangled into a gate that looks like it ran and did half of nothing.

### Shown failing, all five

Each guard was made red before it was kept, by breaking the thing it watches:

| broken | went red |
|---|---|
| the `declared` shortcut | a declared gate is registered without being run |
| the proof's `!proof.pass` arm | an undeclared failing command is refused |
| the `isTemplate` check | a shell-shaped gate is refused before it runs |
| gates registered before the install | the ordering test |
| `TARGET` allowing a leading `.` | the enumerator picks up `.PHONY` |

### Measured

| | |
|---|---|
| `bun run test` | 1936 pass, 6 skip, 0 fail across 237 files |
| new tests | 8: five on the route, three on the enumerator |
| new catalogue entries | 0 |

### Not taken

- **An approval tier.** [`048`](../adr/048-a-project-states-its-own-gates-so-there-is-nothing-to-approve.md)
  already argued its top two rungs were unreachable; this closes the gap it left
  by checking the proposal instead of routing it to somebody.
- **Proving every gate, declared or not.** A test suite is not something to run
  twice for a formality, and the declaration is the repository's own statement.
- **Letting the agent write `config_json.gates` directly.** The names go in
  through the same registration path detection uses, and only for gates that
  passed one of the two checks.

### The trigger the agent could not observe

Shipped in the same round and caught before it mattered: `bootstrap.yaml` said
"run `orch status` first — if it lists gates, this section is not your job."
`orch status <text...>` **posts** a status line. It takes a required argument, it
answers nothing, and no other command tells an agent whether its project has a
gate. The section would have run on every bootstrap turn or none, depending on
what the model guessed.

That is the third false sentence found in this file on this branch, and the file
is the only manual a sandboxed agent has. The fix is the same shape as the
`discriminate` one: the orchestrator already knows, so it says so. `delta.ts`
appends the question to the bootstrap turn's card when the project has no gates
— beside `applySliceCard`'s `blind` question, which is the same idea one role
over — and the role file now says "you are told, in this turn", which is true.

Shown failing twice: without the call, and with the "already configured" guard
disabled. Both turned the test red.
