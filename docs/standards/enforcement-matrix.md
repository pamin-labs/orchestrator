# Enforcement matrix

Each mechanical risk has one primary owner. A second tool may consume the same
file but must not reproduce the same verdict. Replacements follow the
[`dependency standard`](dependencies.md) and require migration evidence rather
than a period with two authorities.

The table is organised by the question that decides everything else: **is this
capability ours to build?** A concern is ours only when it encodes product
policy no external tool can know. Everything else names an external owner.

`Reopen when` exists so a future contributor can tell a settled decision from a
stale one. An exclusion with no measured reason is not a decision and is removed
rather than inherited.

## Ours to build

These encode product policy. There is no external owner to rent.

| Concern | Owner | Required evidence |
|---|---|---|
| Stored lifecycle states and their drivers/repairs | `src/contracts/states.ts` plus the invariant table | driver, terminal declaration, or idempotent repair test per state |
| Slice, group, and lease semantics | `src/mech/**` | behavior tests on the observable transition |
| Sandbox and credential boundaries | `src/mech/sandbox/**`, egress vault | live sandbox suite when a server is available |
| Release immutability and provenance | `.github/workflows/release.yml` | verified digest, manifest, checksum, SBOM, attestation |
| Which structural findings are accepted | Fallow Review + independent reviewers | anchored finding disposition; never a nondeterministic CI gate |

## Rented from an external owner

| Concern | Primary owner | Required evidence | Not this, and why | Reopen when |
|---|---|---|---|---|
| Formatting | Biome | `bun run format:check` | Formatter rules in Oxlint — would duplicate the verdict | Biome stops covering a language we use |
| Type/build boundaries | TypeScript project build | `bun run typecheck`, clean build at milestones | Oxlint experimental compiler diagnostics — same verdict, weaker | — |
| Source correctness, promises, React, accessibility | Oxlint + `oxlint-tsgolint` | `bun run lint` | ESLint, typescript-eslint — second linter for one risk | Oxlint drops a rule class we depend on |
| Dependency zones, cycles, dead code, private leaks, duplication, complexity | Fallow | `bun run audit`, changed-code report | dependency-cruiser, graph rules in Oxlint — second dependency graph | — |
| Runtime behavior | Bun test | targeted tests, then `bun test` | Jest, Vitest — replacing the runner needs an ADR; Bun's is native and faster | Bun test loses a capability the suite needs |
| Generative input invariants | fast-check on Bun test | seed and path on failure | — | — |
| Deterministic test data | Fishery factories in `test/support/` | schema change touches one file | hand-written `INSERT INTO` per test — 380 of them taught the column names to 49 files | — |
| HTTP interception in tests | MSW | `onUnhandledRequest: "error"` keeps the suite off the network | hand-stubbed fetch — skips the retry, conditional-request and throttling paths that most need testing | — |
| Temporary directory lifetime in tests | tempy | cleanup survives a throwing test | bare `mkdtempSync` — leaked on every failure path | — |
| Coverage data | `babel-plugin-istanbul` via a Bun loader plugin | `coverage/coverage-final.json` in Istanbul format | Bun's native `--coverage` — its lcov carries no `FN`/`FNDA`/`BRDA`, so per-function and branch coverage are unavailable; `NODE_V8_COVERAGE` is ignored, which also rules out c8 and v8-to-istanbul | Bun emits Istanbul output or honours `NODE_V8_COVERAGE` |
| Coverage reporting and merge gate | Codecov | `codecov/patch` on the pull request | a global coverage percentage — measures the wrong thing; the gate is coverage of changed lines | — |
| Tracing and metrics | OpenTelemetry SDK | spans reach the collector; `orchestrator_*` metric names unchanged | `prom-client` — a second telemetry owner beside tracing | — |
| Benchmarking | tinybench | sampled statistics, not a single timing | `mitata` (no release since 2025-02), `benchmark` (2023-06), `cronometro` — less active | tinybench stalls for a year |
| Markdown parsing | remark / mdast | AST-derived structure, not line splitting | a hand-written card grammar — only this repository could read it | — |
| Source data-flow/SAST | CodeQL | `security-codeql` | Semgrep, Snyk Code — second SAST | — |
| Reachable security candidates | Fallow security | `security-fallow` newly-reachable gate plus nightly full summary | ordinary lint posing as SAST | — |
| Current lockfile vulnerabilities | `bun audit` | `security-dependencies` | Snyk dependency scan — needs an external token for the same answer | — |
| PR dependency and licence delta | GitHub Dependency Review | PR job summary | duplicate Snyk PR gate | — |
| Dependency/action updates | Dependabot | reviewable pull request | handwritten update scripts | — |
| Filesystem/container vulnerabilities and SBOM | Trivy | scan plus SPDX/CycloneDX artifacts | Snyk Container, separate Syft pipeline — two scanners for one answer | — |
| Workflow syntax | actionlint | `workflow-static` | handwritten YAML parser | — |
| Other CI/tool config schemas | ajv + published schemas | `codecov.yml`, `dependabot.yml`, `trivy.yaml` validated | nothing today — a malformed `codecov.yml` is silently ignored and the gate disappears | actionlint covers these files |
| Workflow security | zizmor | `workflow-static` | repository-specific imitation rules | — |

Repository settings own branch protection, required checks, secret scanning,
push protection, and merge policy. Workflows cannot prove those settings are
enabled; verify them after workflow changes.
