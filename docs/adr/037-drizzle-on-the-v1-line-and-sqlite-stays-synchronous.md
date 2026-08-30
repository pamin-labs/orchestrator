# 037 Drizzle on the v1 line, and the driver stays synchronous

**Status**: superseded in part by [038](038-postgres-and-what-it-cost.md)
**Date**: 2026-08-19

The v1 line still holds, and so does the measurement below. The driver does
not: 038 records the boss choosing to pay the async conversion this one priced.

The schema is 46 hand-written migrations and hand-written row types with no
compile-time connection between them. That has already been paid for once:
`grp.worktree` was in the schema, read in four places, written nowhere, and four
code paths failed silently while every test stayed green.

## Why the beta line rather than `latest`

`latest` is **0.45.2** and has not moved since 2026-03-27. v1 changes the migration
layout — per-migration folders, and no `_journal.json`, which every "bundle the
migrations into the binary" recipe reads — so adopting v0 means adopting the
format that is being replaced and migrating twice. Pinned to an exact version
rather than a range: a beta that moves under a lockfile refresh is a schema tool
changing without a commit.

## The measurement that changes the cost

`drizzle-orm/bun-sqlite` is **synchronous**. Verified against the installed
package rather than recalled:

```ts
const rows = db.select().from(t).all();   // rows instanceof Promise === false
```

This matters more than the ORM choice.
[`docs/project/archive/2026-08.md`](../project/archive/2026-08.md) budgeted this
work as 423 call sites becoming `await`, spreading through every caller, plus
replacing `openMemory()`'s 190× snapshot across 310 call sites. **None of that is
required while the database is SQLite** — it is the price of Postgres, and it
should be charged to that decision when it is taken, not to this one.

## Consequence

The schema becomes one source of truth with row types derived from it. Query
conversion is per module, each behind the four gates, with Drizzle and raw
`db.query()` sharing one `bun:sqlite` handle throughout — so the tree is never
half-converted in a way that does not run.

**The equivalence check comes first and is the whole basis for trusting it**: two
in-memory databases, one from the migrations and one from the schema, compared on
normalised `PRAGMA` output rather than DDL text.

**Reopen when**: concurrent writers or a second process need the database, which
is the case Postgres answers and SQLite does not.
