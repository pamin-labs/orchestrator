# Data standard

SQLite is the durable source for orchestration state. Events and notes are
append-only facts; projections may be rebuilt or repaired from durable inputs.

## Transactions

- Define the transactional boundary from the invariant, not from the number of
  SQL statements. Coupled multi-table writes commit or roll back together.
- Claims, idempotency ownership, state transition, and emitted evidence use a
  compare-and-set or transaction that selects one winner.
- Avoid N+1 queries on snapshot, watchdog, scheduler, and reconciliation paths.
  Measure query count when changing a hot path and batch reads/writes only with
  a documented size limit and partial-failure policy.

## Migrations

Each migration and its version stamp are atomic. Tests cover a fresh database,
the previous supported schema, an older fixture when its upgrade differs,
repeated execution, and failure rollback. A migration must tolerate restart at
the transaction boundary and must not depend on wall-clock ordering.

Destructive or irreversible transformations require an ADR, a backup/rollback
procedure, and a verification query. Compatibility rules are in
[`compatibility-migrations.md`](compatibility-migrations.md).

## Cache and retention

A cache declares key, maximum entries/bytes, TTL where applicable, stale
behavior, and invalidation source. In-memory ETags include credential identity;
rotating a token cannot reuse another token's cache entry. Job/event/note and
idempotency retention have explicit bounds or a documented reason to remain
append-only.

Validate schemas for JSON, provider/process output, and serialized objects
before constructing runtime values or storing them; never execute or revive
methods from untrusted serialized data. Secrets, raw prompts, and user text do
not belong in metrics labels or unbounded indexes.
