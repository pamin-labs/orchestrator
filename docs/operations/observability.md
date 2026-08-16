# Observability operations

The server exposes loopback-only operational endpoints:

- `GET /healthz`: process and event-loop liveness only. It must not depend on an
  external provider.
- `GET /readyz`: 200 only when intake is safe; reuse migration, scheduler,
  preflight, and sandbox readiness. Return 503 during drain or a blocking hold.
- `GET /metrics`: Prometheus/OpenTelemetry metrics with bounded labels.

Use the returned/request `X-Request-ID` to correlate HTTP logs with job, turn,
and event evidence. For a stuck group, inspect durable state/invariant driver
first, then queue depth/leases, current holds, turn/subprocess timing, and the
last correlated error. A green health endpoint does not mean a group has a
driver.

## Graceful shutdown

1. Set readiness to 503.
2. Stop intake, scheduler, and mailbox poller.
3. Reject new work while allowing short transactions to finish.
4. Cancel active turns and subprocesses at the drain deadline.
5. Kill processes that ignore cancellation after the hard deadline.
6. Checkpoint or requeue claimed work idempotently.
7. Flush bounded telemetry and close HTTP/server/database resources.
8. Exit zero for an operator shutdown and non-zero for an unrecovered failure.

Exporter failure must not make readiness fail. Missing database/scheduler
ability to accept work must. Never paste prompts, user text, secrets, raw paths,
or request identifiers into metric labels while investigating.
