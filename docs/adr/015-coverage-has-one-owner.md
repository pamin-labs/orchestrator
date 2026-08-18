# 015 Coverage is instrumented at load time

**Status**: accepted
**Date**: 2026-08-17

Bun's own `--coverage` cannot answer the questions we ask of coverage: it has no
Istanbul reporter, it ignores `NODE_V8_COVERAGE` (which also rules out c8 and
v8-to-istanbul), and its lcov carries no `FN`/`FNDA`/`BRDA`, so per-function and
branch data do not exist. Fallow's CRAP scores were therefore estimates.

`oxc-coverage-instrument` instruments source in a Bun loader plugin and
`istanbul-reports` renders it. One owner for the data, one for the report. The
plugin must be the first `bunfig.toml` preload entry: a module graph is fetched
before it is evaluated, so registering later left fifty-six files uninstrumented
and the number looked better for it.

It replaced `babel-plugin-istanbul` for what it makes possible, not for the
direct saving. `--parallel` implies `--isolate`, so every test file
re-instruments what it imports: babel cost 387s of CPU and 71s of wall clock
that way, oxc 5s and 8s. Coverage could not be parallel before and can be now —
12.3s to 9.2s — and the two agree on the answer (78.66% statements against
78.63%, the gap being test isolation rather than measurement). The parallel run
needs one shard per test file, since `--isolate` gives each a fresh
`globalThis.__coverage__`; `istanbul-lib-coverage` merges them. `@babel/core`
leaves with it.

**Consequence**: the complexity gate went from 11 estimated findings to 73 real
ones. Instrumentation costs time, so only `bun run test:coverage` and a separate
CI job pay it. Codecov owns the merge gate, on changed lines only —
`docs/standards/testing.md` still holds that a global percentage is not a goal.
