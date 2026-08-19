# API design standard

The two public protocol roots are `/api/v1/*` for the owner panel and
`/orch/v1/*` for agents. The project is pre-stable: unversioned aliases are not
registered.

## Contracts

- Route definitions pair a Zod schema with a typed handler. `route()` is the
  only adapter that knows Hono; business handlers keep the direct
  `(ctx, req, params, data)` shape.
- Browser and CLI clients infer transport types from `ApiType` and `OrchType`.
  Runtime schemas shared with the CLI live in `src/contracts`; neither client
  imports an API handler implementation.
- Validate content type, path/query/body data, authorization, and response shape
  at the protocol edge.
- Commands change state; queries do not. A GET has no hidden write. Avoid
  temporal coupling where callers must invoke unrelated endpoints in order.
- Use explicit option objects instead of growing boolean parameter lists.
- Lists define stable ordering, cursor semantics, and an upper page size before
  unbounded growth is possible.

## Side effects

State-changing routes accept `Idempotency-Key`. Browser and CLI callers generate
a UUID; mailbox replay preserves it. The unique identity is caller + route +
key. Same key and payload returns the stored result; same key with a different
payload is a conflict. In-progress and failed records remain recoverable and
must never be re-executed automatically: inspect them through
`GET /api/v1/idempotency/status?caller=...&route=...&key=...`, reconcile the
real-world outcome, then record that known JSON result through
`POST /api/v1/idempotency/recover`. The unresolved response supplies the durable
caller fingerprint and complete status URL; the fingerprint identifies a row but
does not authenticate an agent. Calling the panel status route without a query
lists at most 100 unresolved records, oldest first, so an outcome remains
discoverable even when no client received the failure response. An authenticated
agent may inspect its own row at
`GET /orch/v1/idempotency/status?route=...&key=...`, but cannot resolve it.
Operator recovery belongs to the loopback + CSRF-protected panel boundary, uses
a caller + route + key + observed-update CAS, accepts only failed or stale
in-progress rows, and never invokes the original handler. The recovery request is
not itself idempotency-recorded, avoiding recursive unknown outcomes. A retry of
the original caller + route + key replays the reconciled result. Completed history
is cleaned with an explicit age and count bound; unresolved records stay durable
until reconciled because deleting one would make an unknown side effect executable
again.

Retries are permitted only for transient failures and idempotent effects.
Requests propagate `req.signal`; external operations add a bounded timeout.

## Compatibility

Breaking a published version requires a new versioned route and migration note.
Before 1.0, this project may replace an unversioned contract directly, but the
panel, CLI, mailbox, tests, and documentation change together. See
[`compatibility-migrations.md`](compatibility-migrations.md).
