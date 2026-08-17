/**
 * W3C trace context, and the OpenTelemetry span that carries it off the machine.
 *
 * The SDK owns id generation, batching, retry and export; this module owns only
 * the shape the rest of the process passes around. A `Trace` is what goes into
 * `requestContext` for structured logging and into the `job` table's
 * `trace_id`/`parent_span_id`, so a job's span rejoins the trace of the request
 * that enqueued it.
 *
 * The provider is deliberately not the global one from `@opentelemetry/api`.
 * Composition installs an exporting provider at boot; tests install their own
 * with an `InMemorySpanExporter`. Nothing here reaches for a process registry.
 */

import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace as traceApi,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { NodeTracerProvider, type BasicTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface Trace {
  traceId: string;
  spanId: string;
  started: bigint;
  span: Span;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;
const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_ID = /^[0-9a-f]{16}$/i;

/**
 * The provider spans come from.
 *
 * A provider with no span processors still generates real ids and still parents
 * correctly; it just never ships anything. That is the right default: trace and
 * span ids reach logs and job rows whether or not a collector is configured, and
 * `bun test` performs no network I/O because no exporter was ever installed.
 */
let provider: BasicTracerProvider = new NodeTracerProvider();
let tracer = provider.getTracer("orchestrator");

export function installTracerProvider(next: BasicTracerProvider): void {
  provider = next;
  tracer = next.getTracer("orchestrator");
}

/**
 * Flushes and stops whatever provider is installed, and leaves a working one
 * behind.
 *
 * The replacement is installed first, so there is never a window where the
 * installed provider is dead. A shutdown that left one there would be a one-way
 * door for the whole process: this is called by the server's shutdown path and
 * by any test that drives it, and one Bun process runs every test file.
 */
export function shutdownTracing(): Promise<void> {
  const closing = provider;
  installTracerProvider(new NodeTracerProvider());
  return closing.shutdown();
}

/**
 * A context naming a span this process never saw — an upstream caller's, or the
 * one recorded on a job row by the request that enqueued it. Ill-formed ids
 * start a fresh trace instead of poisoning one.
 */
function remoteParent(traceId?: string | null, spanId?: string | null): Context {
  if (!traceId || !spanId || !TRACE_ID.test(traceId) || !SPAN_ID.test(spanId)) return ROOT_CONTEXT;
  return traceApi.setSpanContext(ROOT_CONTEXT, {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

function begin(kind: SpanKind, parent: Context): Trace {
  // Named on `endSpan`, once the matched route or job kind is known. Kind is not
  // mutable after start, so it is decided by which of the two entry points ran.
  const span = tracer.startSpan("pending", { kind }, parent);
  const { traceId, spanId } = span.spanContext();
  return { traceId, spanId, started: process.hrtime.bigint(), span };
}

export function startTrace(traceparentHeader?: string): Trace {
  const incoming = traceparentHeader?.match(TRACEPARENT);
  return begin(SpanKind.SERVER, remoteParent(incoming?.[1], incoming?.[2]));
}

export function startChildTrace(traceId?: string | null, parentSpanId?: string | null): Trace {
  return begin(SpanKind.INTERNAL, remoteParent(traceId, parentSpanId));
}

export function traceparent(trace: Trace): string {
  return `00-${trace.traceId}-${trace.spanId}-01`;
}

/**
 * Name the span, record what happened, and hand it to the SDK.
 *
 * Export never blocks the work being traced: the processor queues in memory and
 * flushes on its own timer, and drops rather than grows once its queue is full.
 */
export function endSpan(trace: Trace, name: string, failed: boolean, attributes: Attributes): void {
  trace.span.updateName(name);
  trace.span.setAttributes(attributes);
  trace.span.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  trace.span.end();
}
