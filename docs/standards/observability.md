# Observability standard

Observability answers which request/job/turn changed state, why it stopped, and
what an operator can do next. It must not create a second source of state.

## Correlation and logs

Accept or generate `X-Request-ID`, validate its size/shape, and carry it through
`AsyncLocalStorage` across HTTP -> job -> turn -> event. Structured consola
fields include request, job, project/group, agent, operation, duration, outcome,
and retryability when known. Redact through the existing scrub/mask path.

Log at the boundary that owns remediation. A caught error is either returned,
recorded as durable failure, retried by policy, or rethrown; logging and
continuing is not handling.

## Metrics and traces

`GET /metrics` is loopback-only and exposes bounded-cardinality Prometheus/OpenTelemetry
metrics. Labels must not contain secrets, prompts, user text, repository paths,
request IDs, group IDs, or raw error messages. Prefer counters/histograms for
jobs, turns, queue depth, failure code, duration, retries, event-loop delay,
subprocess exits, and database/query pressure.

Trace external I/O and material state transitions. OTLP export is optional and
failure to export never blocks orchestration. Sampling and exporter buffers are
bounded.

Health/readiness semantics and operator checks are in
[`../operations/observability.md`](../operations/observability.md).
