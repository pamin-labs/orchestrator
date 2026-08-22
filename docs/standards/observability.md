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

## What has to carry a span

Anything that waits: a container round trip, a network call, a subprocess, a
filesystem walk. The rule is not "instrument the interesting parts" — a stage
with no span is not slow in `System timing`, it is absent from it, and absent reads as
free.

- Open it with `activeTracer().startActiveSpan`, and end it in `finally`.
- **Name it after what it does.** `watchdog.7d2` and `watchdog.7e` were spans
  that split a 50-second tick into twenty-four parts and still could not say
  which part, because the name was the number the code happened to use. An
  identifier the codebase needs for other reasons is an `id`; the span carries
  the name.
- **Set `SpanStatusCode.ERROR` before rethrowing or recording the failure.** A
  span that ends green after its body threw makes a broken stage look identical
  to a working one, in the surface built to tell them apart. `span-store.ts`
  aggregates on `status = 'error'`, so the status is the failure signal, not
  decoration.
- **Put it at the single place every case passes through**, not at each caller.
  Twenty-four call sites means the twenty-fifth arrives uninstrumented; one
  shared entry point means it cannot.

Attributes carry scope through `scopeAttributes`, never prompt text, repository
paths or raw errors — the label rules above apply to spans as well as metrics.

Health/readiness semantics and operator checks are in
[`../operations/observability.md`](../operations/observability.md).
