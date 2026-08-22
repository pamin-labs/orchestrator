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
| Validation not erased at a trust boundary (`z.unknown()`) | Oxlint `no-restricted-properties` | `bun run lint` | A governance test that greps for the call — a linter's job, re-run by hand | Oxlint drops `no-restricted-properties`, which has no `no-restricted-syntax` beside it |
| Dependency zones, cycles, dead code, private leaks, duplication, complexity | Fallow | `bun run audit`, changed-code report | dependency-cruiser, graph rules in Oxlint — second dependency graph | — |
| Runtime behavior | Bun test | targeted tests, then `bun test` | Jest, Vitest — replacing the runner needs an ADR; Bun's is native and faster | Bun test loses a capability the suite needs |
| Generative input invariants | fast-check on Bun test | seed and path on failure | — | — |
| Deterministic test data | Fishery factories in `test/support/` | schema change touches one file | hand-written `INSERT INTO` per test — 380 of them taught the column names to 49 files | — |
| HTTP interception in tests | MSW, armed per file by `mockHttp()` in `test/support/http.ts` | `onUnhandledRequest: "error"` keeps the suite off the network; asserted in `test/mech/github.test.ts` | hand-stubbed fetch — skips the retry, conditional-request and throttling paths that most need testing. Not a preload either: interception is process-wide, and `test/integration` talks to a real localhost server | a fake stands in for something that is not HTTP — the sandbox driver and the model providers go through `Ctx` |
| Temporary directory lifetime in tests | tempy, via `tempDir()` in `test/support/temp.ts` | one parent directory per process, removed from `afterAll` in `test/support/setup.ts` whether the suite passed, failed or threw | bare `mkdtempSync` — 54 call sites across 27 files, 2 of which cleaned up, and none of those on the failure path | a directory that lives and dies inside one function — `temporaryDirectoryTask` removes it sooner |
| Coverage data | `oxc-coverage-instrument` via a Bun loader plugin | `coverage/coverage-final.json` in Istanbul format | Bun's native `--coverage` — its lcov carries no `FN`/`FNDA`/`BRDA`, so per-function and branch coverage are unavailable; `NODE_V8_COVERAGE` is ignored, which also rules out c8 and v8-to-istanbul | Bun emits Istanbul output or honours `NODE_V8_COVERAGE` |
| UI message extraction and ICU formatting | Lingui (`@lingui/*`), expanded by `scripts/lingui-macros.ts` | `bun run i18n:progress --check` and `bun run i18n:validate` in CI's `quality` job — the table in both READMEs matches the catalogs, and every message parses as ICU and still refers to the names its English source did; `test/governance/panel-speaks-english.test.ts`, `server-speaks-one-language.test.ts`, `values-carry-no-rendered-text.test.ts` and `an-event-names-its-sentence.test.ts` green | Hand-written message keys — PR #9 needed 834 of them and kept the Chinese beside each as a default, which is two things to hold in step. There is no server-side exception: `scripts/build-server.ts` reaches `Bun.build({ compile, plugins })`, which takes a plugin and cross-compiles, so `src/platform/text/lang.ts` reads the same nine catalogues the panel does | The server grows a bundling step, or a third locale makes one table cheaper than two |
| Coverage reporting and merge gate | Codecov | `codecov/patch` on the pull request | a global coverage percentage — measures the wrong thing; the gate is coverage of changed lines | — |
| Tracing and metrics | OpenTelemetry SDK | spans reach the collector; `orchestrator_*` metric names unchanged | `prom-client` — a second telemetry owner beside tracing | — |
| Benchmarking | tinybench | sampled statistics, not a single timing | `mitata` (no release since 2025-02), `benchmark` (2023-06), `cronometro` — less active | tinybench stalls for a year |
| How often a watchdog rule runs | croner, declared beside each rule as `every` and enforced in `step` | `test/mech/watchdog.test.ts` runs the tick four times across an hour and counts one sweep | a module-level `lastSweep` compared inside the rule body — process memory, so it re-ran on every restart and two concurrent ticks each saw the other's zero. `json-rules-engine` (2025-02), `trool` (2024-11), `nools` (2022) — and a rules engine evaluates facts, where sixteen of twenty-four rules repair state | a cadence has to change with its own outcome. `subusage.ts` backs off from ten minutes to forty-five when throttled and `net.ts` probes on the online flag; croner states a fixed pattern and cannot say either, so both keep their own clock |
| Markdown parsing | remark / mdast | AST-derived structure, not line splitting | a hand-written card grammar — only this repository could read it | — |
| Container start latency | **`commands.createSession`, and nothing else** | `test/mech/sandbox-server.test.ts` — the wrapper separates the streams the way `run()` does | Snapshots at 300ms on a 3,098ms create; `extensions.poolRef`, which forbids `networkPolicy`, `volumes` and `credentialProxy.enabled` — the whole of ADR 005's boundary. See [ADR 032](../adr/032-sessions-not-snapshots.md) | `Sandbox.create` itself is the measured cost, on a machine that pulls per creation or a runtime where scheduling dominates |
| Semantic/cross-language retrieval | **nobody — refused, measured** | none; the gap is stated | Not size: one runtime and one wasm is 13.5 MB. `multilingual-e5` ranks an irrelevant same-language passage above the relevant other-language one, at both `small` and `base`. See [ADR 031](../adr/031-embeddings-do-not-fit-in-this-binary.md) | a model that ranks the other-language passage first on that document's five-sentence corpus |
| Lexical retrieval for `orch ctx query` | Orama, with `Intl.Segmenter` in its `components.tokenizer` seam | `test/mech/ctx.test.ts` — a rare term beats a common one, a long document does not win by length, and a note written after the index was built is still found | SQLite FTS5 — cleaner while the database is SQLite, and it is SQLite's; a hand-written BM25 that rescanned 400 documents at 33.4ms a query. See [ADR 020](../adr/020-retrieval-is-rented-and-multilingual.md) | the corpus outgrows an in-memory index, or retrieval is wanted across projects |
| Stop words | `stopword`, merged by script in `src/mech/knowledge/terms.ts` | `test/mech/ctx.test.ts` — Chinese particles are dropped and `use`/`get`/`set` are not | a hand-written 67-word English list. It could not drop `的`, which measured 3.77 against this corpus — above `sandbox` at 3.13, the highest-weighted term in the index. `@orama/stopwords` covers 30 languages but not Korean or Thai; merging all 63 of `stopword`'s lists kills `net` and `hit`, both identifiers here, so the merge stops at English plus every non-Latin script, where collision is impossible | Korean or Thai stop words matter enough to want a language signal |
| Word segmentation | `Intl.Segmenter` (ICU, in the runtime) | eight scripts produce terms, asserted per script | `@node-rs/jieba` — ties on Chinese, splits Korean and Russian per character; `segmentit`, `tiny-segmenter`, `kuromoji`, `intl-segmenter-polyfill` all stale; `wink-nlp` and `natural` are English-first | a language ICU breaks badly enough to matter, measured on real notes |
| Bounded fan-out over containers | `p-map` at `EXEC_FANOUT` | `sandbox.ts` and the watchdog sweep both cap at four | `Promise.all` over `liveScopes` — the per-container CPU cap multiplies against the host rather than protecting it; `bottleneck`, last release 2023-02-22 | a fan-out appears that is not `.map`-shaped, which is where `p-limit` fits better |
| Bounded caches | `quick-lru` for the GitHub ETag cache | a re-read entry survives the cursors that overflow it | `clear()` on overflow — evicts the hot entries with the cold, which is backwards for a cache whose purpose is the entries re-read every tick | a second cache in this repository grows past a size worth evicting |
| Source data-flow/SAST | CodeQL | `security-codeql` | Semgrep, Snyk Code — second SAST | — |
| Reachable security candidates | Fallow security | `security-fallow` newly-reachable gate plus nightly full summary | ordinary lint posing as SAST | — |
| Current lockfile vulnerabilities | `bun audit` | `security-dependencies` | Snyk dependency scan — needs an external token for the same answer | — |
| PR dependency and licence delta | GitHub Dependency Review | PR job summary | duplicate Snyk PR gate | — |
| Dependency/action updates | Dependabot | reviewable pull request | handwritten update scripts | — |
| Filesystem/container vulnerabilities and SBOM | Trivy | scan plus SPDX/CycloneDX artifacts | Snyk Container, separate Syft pipeline — two scanners for one answer | — |
| Workflow syntax | actionlint | `workflow-static` | handwritten YAML parser | — |
| Other CI/tool config schemas | ajv + SchemaStore JSON vendored under `test/fixtures/schemas/` | `codecov.yml` and `.github/dependabot.yml` validated in `test/governance/config-schemas.test.ts` | nothing before this — a malformed `codecov.yml` is silently ignored and the gate disappears. Not the `@schemastore/*` npm packages: they ship TypeScript types only, and a type assertion over parsed YAML validates nothing | actionlint covers these files, or SchemaStore publishes the schemas themselves to npm |
| Workflow security | zizmor | `workflow-static` | repository-specific imitation rules | — |

Repository settings own branch protection, required checks, secret scanning,
push protection, and merge policy. Workflows cannot prove those settings are
enabled; verify them after workflow changes.
