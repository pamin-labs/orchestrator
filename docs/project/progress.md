# Project progress

Read this file first when resuming work. Update it after a verifiable unit, not
after each edited file. Historical implementation narrative belongs to Git
history, release notes, and ADRs.

## Current milestone

M7 — executable engineering governance and versioned protocol.

## Baseline

- Branch: `refactor/api-split-and-settings`
- SHA: `179f0c4655daa6e71fad696500da82e581b7f931`
- Baseline `bun run check`: pass
- Baseline tests: 772 pass, 6 skip, 0 fail across 88 files
- Baseline test time: 13.84 seconds
- Baseline Fallow: 7 unused type exports, 8 private type leaks, 1 unused class
  member, 3 production imports from dev dependencies, no duplication finding

## Verified complete

- Hono route schemas feed typed handlers and generated browser/CLI clients.
- External JSON is validated before entering business code.
- Group sandboxes, file mailbox transport, and credential vault boundaries are
  implemented and covered by live tests when OpenSandbox is available.
- GitHub is the project source; host Git is not part of runtime operation.
- `src/states.ts` and executable invariants cover stored lifecycle states.
- Existing full quality chain is green at the baseline SHA.
- Governance work is isolated in `codex/engineering-governance` under a separate
  worktree.
- Project plan and progress responsibilities moved under `docs/project/` and
  were reduced to active product state; TypeScript and 772 tests remain green.
- `AGENTS.md` is now the real engineering entrypoint, `CLAUDE.md` is its
  compatibility link, and a source guard prevents legacy documentation paths;
  TypeScript and 773 tests are green.

## Blockers and deviations

- Live OpenSandbox tests remain environment-gated and are skipped without a
  running sandbox server.
- Repository settings such as branch protection, secret scanning, push
  protection, and required checks must be verified on GitHub after workflow
  files land; repository files cannot enable all of them.
- No compatibility aliases will be kept for the pre-release unversioned API.

## Next executable items

1. Finish the public documentation tree and canonical `AGENTS.md` entrypoint.
2. Make TypeScript, Oxlint, and Fallow ownership non-overlapping and executable.
3. Ship the v1-only routes and runtime operability contracts.
4. Refactor the slow test fixtures and add selected fast-check properties.
5. Land read-only CI/security and immutable release workflows, then run final
   reviews and merge gates.
