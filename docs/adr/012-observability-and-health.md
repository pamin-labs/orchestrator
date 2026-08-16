# 012 Readiness reflects intake safety

**Status**: accepted
**Date**: 2026-08-17

One “healthy” signal cannot distinguish a running event loop from a scheduler
that can safely accept work. The latter depends on migration, preflight,
scheduler, and sandbox state, while telemetry export does not.

`/healthz` proves process/event-loop liveness; `/readyz` proves intake safety;
`/metrics` exposes bounded-cardinality Prometheus/OpenTelemetry data on
loopback. `X-Request-ID` and `AsyncLocalStorage` correlate HTTP -> job -> turn ->
event. Structured consola output uses existing scrub/mask behavior; optional
OTLP export never gates readiness.

**Consequence**: shutdown first makes readiness fail, stops intake/pollers,
drains or cancels work, checkpoints/requeues, then closes resources. Health does
not claim that workflow states have drivers; executable invariants do.
