# 010 Project references and dependency boundaries

**Status**: accepted
**Date**: 2026-08-17

One TypeScript program and directory convention allowed server, browser, route,
mechanism, and runtime boundaries to drift without a build-level signal. Adding
ESLint plus dependency-cruiser would duplicate tools already in the repository.

TypeScript project references own compilation/declaration boundaries for server,
web, and tests. Oxlint with `oxlint-tsgolint` owns source correctness and typed
lint rules. Fallow exclusively owns zones, cycles, boundary coverage, dead code,
private type leaks, duplication, complexity, and change risk.

The generated client surface is exactly `src/http/routes/panel.ts` and
`src/http/routes/orch.ts`, classified as `public-rpc`. Web and CLI may import
those files only as types. Runtime schemas shared by the Orch CLI and handlers
live inward in `src/contracts`; the CLI cannot import `src/api` or `src/mech`.
Tests and maintainer scripts are peripheral entry points: they receive coverage
zones but no dependency rule. Application orchestration, provider adapters,
prompt construction, and platform primitives are distinct production zones,
and the constrained allow graph is a DAG. In
particular, `src/runtime/executor.ts` is application policy rather than a
provider adapter; pure text and shell-quoting helpers are platform primitives.

**Consequence**: no ESLint or dependency-cruiser is introduced. A production
file must match a Fallow zone, and cross-zone imports use declared public files.
Compiler diagnostics are not repeated through Oxlint's experimental type-check.
Fallow auto-discovers package and framework entry points; `entry` contains only
additional scripts it cannot discover. The default new-only audit owns change
attribution, so no health baseline is checked in.
