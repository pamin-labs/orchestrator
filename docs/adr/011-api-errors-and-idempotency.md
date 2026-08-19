# 011 Versioned API, stable errors, and idempotent effects

**Status**: accepted
**Date**: 2026-08-17

The project has not published a stable protocol, so preserving unversioned
routes would create two surfaces before any external compatibility need exists.

Panel and agent protocols ship directly at `/api/v1/*` and `/orch/v1/*`; old
routes are removed with no alias. Generated Hono clients remain the type source.
Errors use stable `code`, safe message, `request_id`, and optional details.
State-changing routes use caller + route + `Idempotency-Key`, returning the
stored result for the same payload and a conflict for a different payload.
An exception leaves an unknown outcome durable. It is not retried: the loopback
panel exposes status and explicit recovery endpoints so an operator can inspect
the real effect and record its known JSON response without invoking the original
handler. Active requests need a stale window before recovery. Completed history
is bounded; unknown outcomes are retained until reconciled.

The unresolved response exposes the durable caller fingerprint and a complete
panel status URL. Panel status/recovery selects caller + route + key explicitly,
so the boss can reconcile an agent-owned record without impersonating that agent.
An empty panel status query lists a bounded oldest-first set of unresolved rows,
so recovery remains discoverable after a lost response.
The fingerprint is an identifier, not authentication: recovery remains on the
loopback and CSRF-protected panel only. Agents have a read-only same-caller status
route whose caller is derived from their token. Recovery updates only failed or
stale in-progress rows with an observed-version CAS and is excluded from the
idempotency middleware itself, so it cannot create a recursive recovery record.

**Consequence**: web, CLI, mailbox replay, tests, and docs change atomically.
External I/O carries cancellation, timeout, retryability, and correlation. A
later incompatible public contract gets a new version and migration window.
