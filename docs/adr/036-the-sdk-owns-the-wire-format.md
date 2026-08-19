# 036 The SDK owns W3C trace context, and the sampling decision is carried

**Status**: accepted
**Date**: 2026-08-19
**Follows**: [012](012-observability-and-health.md),
[014](014-telemetry-is-rented.md)

Three defects with one root: this module parsed and produced W3C trace context by
hand, and where the header did not supply a value it wrote a literal.

## What was wrong

**Outbound.** `traceparent()` built `` `00-${traceId}-${spanId}-01` ``. `-01` is
SAMPLED. Everything is sampled today because nothing configures a sampler, so it was
latent — and the moment one is configured, this header tells every downstream service
to keep a trace this process dropped.

**Inbound.** A regular expression captured the trace id and the span id and **threw
the flags away**, and `remoteParent` then built the context with `TraceFlags.SAMPLED`
written out. So `00-…-00` — a caller saying explicitly that it had dropped this trace
— became sampled here. This is where the wrong value came from; the outbound half was
only reporting it.

**Across the queue.** The `job` row carried a trace id and a parent span id and
nothing else, so `startChildTrace` had to invent the flags, and invented SAMPLED. A
job enqueued by a request the sampler had dropped came back sampled, and every span
underneath it with it.

## What is rented

`W3CTraceContextPropagator` from `@opentelemetry/core` — a declared dependency,
already imported two files over. It owns the format: the version, the flags and the
tracestate. A regular expression has to be told those separately and was told one.

An earlier comment in `otel.ts` claimed `@opentelemetry/core` "is not a declared
dependency here". It was and is. A wrong reason recorded is worse than none, because
the next person routes around it.

## What is carried rather than assumed

Migration 045 adds `job.trace_flags`. The decision travels the way the ids already
did: the ambient `requestContext` carries it, `enqueue` records it, `startChildTrace`
is handed it.

`RequestContext.traceFlags` is **required**, and that is what found all five
construction sites. An optional field with a default would have left every one of
them looking correct.

NULL for a job with no ambient request, and for every row written before this. Both
read as sampled — the right answer for a trace with no parent to inherit from, and
honest for the old rows, since no sampler has ever been configured. That is also why
none of this was visible.

## Not done

`NodeTracerProvider.register()` still is not called. It would install the propagator
and the context manager globally, and this process deliberately keeps its provider in
a module variable — composition installs an exporting one at boot, tests install their
own with an `InMemorySpanExporter`, and a global registry is a second owner for that.
The context manager *is* set globally, because `startActiveSpan` reads the ambient
context and the API's default returns `ROOT_CONTEXT` every time; without it every span
comes out a root of its own. Using the propagator directly gets the parsing without
the registry.

## Reopen

A sampler. Every one of these was latent because there is none, and configuring one is
the change that makes them all matter at once.
