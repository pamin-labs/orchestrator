# 038 PostgreSQL, and what the async it forces actually buys

**Status**: accepted
**Date**: 2026-08-19
**Supersedes**: the "the driver stays synchronous" half of [037](037-drizzle-on-the-v1-line-and-sqlite-stays-synchronous.md)

037 measured that `drizzle-orm/bun-sqlite` is synchronous and concluded that
staying on SQLite costs nothing while moving to Postgres costs an async
conversion of every call site. That measurement was right and the conclusion
stands as a description of the price. The boss decided to pay it.

## Why

The reason is not the ORM and not the schema. It is that a synchronous driver on
the main thread means every query is a stall in the only thread that also serves
the panel, the SSE heartbeat and every agent's mailbox request. The timing page
was measured at 739ms before the query work and 262ms after — 262ms during which
nothing else in the process could run. That is the ceiling being removed, and
nothing about it improves by making the queries faster.

Second, one process. SQLite gives one writer; a second orchestrator, a migration
job, or a `psql` session is not a thing that can exist. Postgres makes the
database something other than a file only this binary may touch.

## What it is

- **Production**: `drizzle-orm/bun-sql` over `Bun.sql`. Bun 1.3 ships the client,
  so this adds no runtime dependency; `postgres.js` and `node-postgres` both
  would. Connection string in `ORCH_DATABASE_URL`, which is bring-your-own —
  managed, remote, or the one container in `docker/postgres-compose.yml`.
- **Tests**: `@electric-sql/pglite`, real Postgres compiled to WASM, in-process.
- Both satisfy `PgAsyncDatabase<PgQueryResultHKT>`, so nothing downstream knows
  which it has.

`ORCH_DATABASE_URL` is an environment variable and not a config key for the
reason `config/default.yaml` already gives about `ORCH_HOST` and `ORCH_DATA_DIR`:
it has to be known before there is a database to read settings out of. It also
carries a password, and that file is committed.

## The measurements

Against PostgreSQL 18 in the compose service, and PGlite 0.5.5, on Bun 1.3.14:

| | |
|---|---|
| `open()` including migrations | 124ms, and 17ms on a second open |
| 40 concurrent inserts | 16ms, 40 rows, no lost writes |
| `SELECT 1` racing `pg_sleep(0.5)` on one handle | the fast one returns first |
| PGlite instance | 670ms |
| PGlite `TRUNCATE` of all 21 tables | 9ms |

The third line is the one that matters: Drizzle's own documentation still warns
that "in version 1.2.0, Bun has issues with executing concurrent statements".
[oven-sh/bun#16774](https://github.com/oven-sh/bun/issues/16774) is closed, fixed
by [#16854](https://github.com/oven-sh/bun/pull/16854), and the warning is stale.
It shipped with thin regression cover — the maintainer's review says so — which
is a reason to keep our own concurrency test, not a reason to avoid the driver.

The fourth and fifth lines decide the test design. A PGlite per `openMemory()`
call would add over a minute to a 7-second suite, so one instance serves the
process and each call truncates it. That trades object isolation for a guarantee
that has to be tested rather than assumed, and
`test/platform/schema.test.ts` tests it.

## What the type change bought, and what it cost

- Every `*_at` column is `bigint`. `integer` is int4, which tops out at 2.1e9;
  an epoch in milliseconds is 1.8e12. Mapped naively this fails on first insert.
- Token counters are `bigint` too. They accumulate for the life of a row.
- `project.base_branch_pinned` is a real `boolean`, not 0/1.
- The thirteen JSON columns are `jsonb`, so they arrive parsed. Their `$type` is
  `Json` and **not** the shape a reader wants: rows written by an older build are
  still in there, so validation stays at the read site. `valueOr` is `jsonOr` for
  a value the database already parsed.
- The state columns are `text({ enum: … })` from `contracts/states.ts`, which
  narrows the TypeScript type *and* becomes a runtime Zod enum through
  `drizzle-orm/zod` — `$type<GrpState>()` does neither, measured. A `check()`
  built from the same constant carries it into the database, replacing the pair
  of triggers SQLite needed because it cannot add a CHECK.

## Two traps that cost real time

**PGlite sets `process.exitCode = 99` when it starts.** It is real Postgres and
its WASM boot runs a real `exit(99)`. Every test file that opens a database
inherits it, so the whole suite exits non-zero reporting zero failures — CI red
with no reason in it. `openMemory` clears it at creation, where nothing has
legitimately set an exit code yet, and a deliberately failing test still exits 1.

**`db.execute()` carries one statement and returns a different shape per driver.**
PGlite returns `{rows, fields, …}`, `bun-sql` a bare array. Tests run on the
first and production on the second, so anything reading that shape passes its
test and fails in production. The typed builders are identical on both.

## What was deliberately not done

The panel's contracts in `src/contracts/panel.ts` are **not** derived from the
tables with `createSelectSchema`. Measured: `web/src/shared/api.ts` imports that
file, so deriving puts Drizzle in the browser bundle — 1,697,860 → 1,754,943
bytes, +57KB for types the browser never reads, and it breaks the first
architecture invariant. The drift protection lives in
`test/governance/wire-matches-schema.test.ts` instead, which nothing ships.

## Rollback

The last SQLite commit is the parent of this migration and the schema had no
production data worth moving — one project row, two notes, 221 events, and 92,721
telemetry spans that have a retention window anyway. Going back is a revert, not
a data migration. That is only true while it stays true.
