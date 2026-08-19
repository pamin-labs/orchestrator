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

## Traces

Spans are produced through the OpenTelemetry SDK and go to two places. The
panel's own SQLite store always receives them, because the one consumer that is
always present is the boss asking where a requirement's time went, and that
question has no collector to ask. An OTLP exporter is added beside it only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set; with the variable unset no exporter is
constructed, nothing is queued, and no socket is opened.

To read a waterfall locally:

```bash
bun run trace:up      # Jaeger all-in-one, loopback only
bun run dev:trace     # the server, exporting to it
# http://127.0.0.1:16686
bun run trace:down
```

The endpoint is the bare origin. An OTLP/HTTP client appends `/v1/traces`
itself, which is also why the server's own receive endpoint is mounted at
`/api/v1/traces`: pointing an exporter at `http://host/api` lands exactly there,
and that prefix is the only one carrying the CSRF, body-limit and shutdown
middleware. Any other collector that speaks OTLP/HTTP — Tempo, SigNoz, an
OpenTelemetry Collector in front of either — is a change of that one variable.

The server's receive endpoint accepts OTLP/JSON only and answers 415 to
protobuf. `@opentelemetry/otlp-transformer` publishes a request *serialiser* and
a response deserialiser, not a request decoder, so the body is validated with
Zod like every other external input rather than decoded by a library that does
not offer it. Our own exporter is `@opentelemetry/exporter-trace-otlp-http`,
which sends JSON; a third-party sender needs
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.

Export failure is never the traced work's problem: the processor queues in
memory, flushes on its own timer, and drops rather than grows once full. Dropped
spans are counted in `orchestrator_telemetry_dropped_total`, so the loss is
visible rather than silent.

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
