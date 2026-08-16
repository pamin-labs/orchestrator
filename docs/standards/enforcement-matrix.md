# Enforcement matrix

Each mechanical risk has one primary owner. A second tool may consume the same
file but must not reproduce the same verdict.

| Concern | Primary owner | Required evidence | Deliberately absent |
|---|---|---|---|
| Formatting | Biome | `bun run format:check` | Formatter rules in Oxlint |
| Type/build boundaries | TypeScript project build | `bun run typecheck`, clean build at milestones | Oxlint experimental compiler diagnostics |
| Source correctness, promises, React, accessibility | Oxlint + `oxlint-tsgolint` | `bun run lint` | ESLint, typescript-eslint |
| Dependency zones, cycles, dead code, private leaks, duplication, complexity | Fallow | `bun run audit`, changed-code report | dependency-cruiser, graph rules in Oxlint |
| Runtime behavior | Bun test | targeted tests, then `bun test` | Jest, Vitest |
| Generative state/input invariants | fast-check on Bun test | seed and path on failure | runner adapters, Faker/Fishery |
| Source data-flow/SAST | CodeQL | `security-codeql` | Semgrep, Snyk Code |
| Reachable security candidates | Fallow security | Fallow summary/SARIF | ordinary lint as SAST |
| Current lockfile vulnerabilities | `bun audit` | `security-dependencies` | Snyk dependency scan |
| PR dependency and licence delta | GitHub Dependency Review | PR job summary | duplicate Snyk PR gate |
| Dependency/action updates | Dependabot | reviewable pull request | handwritten update scripts |
| Filesystem/container vulnerabilities and SBOM | Trivy | scan plus SPDX/CycloneDX artifacts | Snyk Container, separate Syft pipeline |
| Workflow syntax | actionlint | `workflow-static` | handwritten YAML parser |
| Workflow security | zizmor | `workflow-static` | repository-specific imitation rules |
| Design judgment | Fallow Review + independent reviewers | anchored finding disposition | nondeterministic CI gate |

Repository settings own branch protection, required checks, secret scanning,
push protection, and merge policy. Workflows cannot prove those settings are
enabled; verify them after workflow changes.
