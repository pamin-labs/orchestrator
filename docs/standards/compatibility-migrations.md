# Compatibility and migration standard

## Protocol compatibility

The pre-1.0 governance change directly ships `/api/v1/*` and `/orch/v1/*`.
Unversioned `/api/*` and `/orch/*` aliases, redirects, and deprecation headers do
not exist. Panel, CLI, mailbox replay, tests, and documentation move in one
coherent change.

After a public version is depended on, classify changes before implementation:

- additive optional fields and endpoints stay within the version;
- renamed/removed fields, changed semantics, or stricter accepted input require
  a new protocol version or an announced migration window;
- generated client types are compatibility evidence, not a substitute for
  runtime validation;
- retries, idempotency, pagination, ordering, and error codes are contract
  semantics and cannot change accidentally.

## Persistent data

A schema change documents supported starting versions, forward step, validation
query, rollback/restore method, and the point after which rollback is unsafe.
Migrations and version stamps are atomic and tested fresh, from N-1, from any
material older fixture, repeated, and on injected failure.

Prefer expand/migrate/contract only when two application versions must overlap.
For a single-process pre-release upgrade, one atomic migration is smaller and
safer. Data loss, irreversible conversion, or a changed security boundary always
requires an ADR.

Config adds safe defaults and validates unknown values. Renaming a config key
either migrates explicitly or fails with the old and new names; silent fallback
is forbidden.
