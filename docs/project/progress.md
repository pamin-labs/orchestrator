# Project progress

Read this file first when resuming work. Update it after a verifiable unit, not
after each edited file. Historical implementation narrative belongs to Git
history, release notes, and ADRs.

## Current milestone

M7 — executable engineering governance and versioned protocol.

## Baseline

- Branch: `refactor/api-split-and-settings`
- SHA: the commit containing this entry
- TypeScript, Oxlint, Biome, and Fallow audit: pass, the audit clean across all
  424 changed files
- Tests: 1124 pass, 6 environment skips, 0 fail
- Coverage: 76.31% of statements, 67.25% of branches, 69.31% of functions,
  78.97% of lines
- Fallow complexity: **zero** functions over threshold across 5,226 analysed,
  against real coverage rather than the export-reference estimate
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

## Blockers and deviations

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
  `docs/operations/snapshots/ruleset-main-20892179.json` is the live state as of
  this entry. It requires **14** status checks — `quality-format`,
  `quality-types`, `quality-oxlint`, `quality-fallow`, `test-main`,
  `test-coverage`, `build-web`, `dco`, `pr-plan`, `security-codeql`,
  `security-fallow`, `security-dependencies`, `security-container`,
  `workflow-static` — with `require_code_owner_review` on, plus deletion and
  non-fast-forward protection.

  All fourteen were verified against `.github/workflows/*.yml` as real job
  names, which is the check that matters: the bug this replaced required a
  status named `check` that no workflow defined, so every pull request waited
  forever on a report that could never come while the fourteen jobs that do run
  were required by nothing.

  To roll back: `gh api --method PUT repos/pamin-labs/orchestrator/rulesets/20892179
  --input docs/operations/snapshots/ruleset-main-20892179.json`. Worth knowing
  before it is needed, because a bad ruleset blocks everybody's merges at once.

## Next executable items

1. Turn on secret scanning and push protection. Both are repository settings, so
   no file can enable them. Push protection is the one that matters most on a
   public repository: secret scanning tells you a credential leaked, push
   protection stops the push that would have leaked it.

   Where: Settings → Code security, or
   `gh api -X PATCH repos/pamin-labs/orchestrator -F security_and_analysis[secret_scanning][status]=enabled`
   and the same for `secret_scanning_push_protection`. Expect two new things
   afterwards: a scanning alert surface under Security, and a push that contains
   a recognised credential pattern being refused at the remote with the rule
   named — which is the behaviour worth confirming once deliberately, on a
   throwaway branch with a fake key, rather than discovering under pressure.
2. When the database moves to Drizzle, move `test/support/factories.ts` to
   Fishery's documented `onCreate` + async `create()` with the database passed as
   a transient parameter, and drop the project-owned `insert`. It is written
   synchronously today because `bun:sqlite` is synchronous, which is a stated
   deviation rather than an oversight. Deferred deliberately: the conversion is
   423 call sites across 59 files, it is the same edit whether it happens now or
   at the switch, and it buys nothing until the driver is async. `no-floating-promises`
   is already an error, so a forgotten `await` fails lint rather than shipping.
3. Run the six environment-gated OpenSandbox integration tests. They are the six
   `live(...)` cases in `test/live/sandbox-live.test.ts` at lines 95, 143, 181,
   229, 273 and 351:
   - a sandbox is a boundary: it gets a checkout, runs its gates, and cannot
     touch this machine
   - an agent reaches the orchestrator through the mailbox, with no route to
     this machine
   - the utility container takes a commit out of a group and into its mirror
   - a credential bound to one path is not injected on another
   - every skill reaches both CLIs, and the ones the boss ticked stay read-only
   - one line out of a container is still one line by the time it is read

   The skip lifts on its own: `serverUp()` at `:55` probes `cfg.sandbox.server`
   over HTTP with `cfg.sandbox.apiKey`, and `:88` picks `test` or `test.skip`
   from the answer. So the requirement is an opensandbox-server the settings
   page can already reach, plus `ORCH_SANDBOX_API_KEY` matching it — there is no
   flag to set and nothing to edit. `bun test test/live/` prints the reason on
   the skip path, naming the address it tried.

   Done when `bun test` reports 0 skips rather than 6. Keep the run's output:
   these are the only tests that exercise the boundary against a real container,
   so the log is the evidence that the boundary held, not a formality.
4. Run the release workflow in dry-run mode on GitHub-hosted Linux. The entry is
   the `dry_run` input at `.github/workflows/release.yml:10`, so it is a manual
   dispatch with that box ticked. What only a hosted run can exercise: the
   multi-platform image build on x64 **and** arm64, Trivy against the built
   image, SBOM generation, and provenance attestation — none of which a local
   run reaches.

   The thing to re-verify rather than assume is that a dry run writes nothing
   external. `release.yml` gates the tag push, the GitHub release, the registry
   tag and the `latest` alias on `!inputs.dry_run` (lines 279, 294, 305, 357,
   473, 496, 539). Read the completed run's log for those six steps and confirm
   each was skipped; a dry run that published anything is the one failure mode
   that cannot be undone.
5. Monitor the first merged CI and nightly stress runs; replay any property
   failure from its reported seed and path. Add `codecov/patch` to the ruleset's
   required checks once a pull request has actually reported it — requiring a
   check that has never been posted is the bug this list used to describe.
