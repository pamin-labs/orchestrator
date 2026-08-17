# 014 Telemetry is rented, storage is ours

**Status**: accepted
**Date**: 2026-08-17

Trace context, OTLP framing, batching and Prometheus text are specifications
with maintained implementations; we had written all four. The OpenTelemetry SDK
owns them now. Two pieces stay ours because no library can know them: a
`SpanProcessor` writing to our SQLite, and the scope columns that tie a span to
a project, group and slice.

`PrometheusSerializer`, never `PrometheusExporter` — the latter opens its own
port and would bypass the loopback gate ADR 012 puts on `/metrics`. Neither
provider is the `@opentelemetry/api` global: composition installs them, tests
install their own, so invariant 11 is satisfied by a net reduction in singletons.
The receive endpoint is `/api/v1/traces` because only that prefix carries CSRF,
the body limit and the shutdown gate; it accepts OTLP/JSON, since
`@opentelemetry/otlp-transformer` serialises requests but does not decode them.

**Consequence**: spans survive with no collector configured, bounded by seven
days and a row cap trimmed on the writer. ADR 012's `/metrics` contract is
unchanged; its "optional OTLP export" is now the SDK's.
