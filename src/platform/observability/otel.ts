/**
 * The OTLP span exporter, installed once by composition when one is configured.
 *
 * Kept out of `traces.ts` so that importing trace context does not pull an HTTP
 * exporter into every module graph that only wants a trace id — including
 * `bun test`, which must perform no network I/O.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { recordDroppedSpans } from "./metrics.ts";
import { installTracerProvider } from "./traces.ts";

/**
 * Queue bounds, stated rather than defaulted.
 *
 * Export is a side channel: if the collector is slow or gone, the work being
 * traced must not slow down or fail with it. The processor flushes on its own
 * timer and drops once the queue is full, and the export timeout matches the one
 * the hand-rolled exporter used before it.
 */
const QUEUE = {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 5_000,
  exportTimeoutMillis: 3_000,
};

/**
 * Count what the collector refuses.
 *
 * The processor's own queue-full drops are logged through `diag` but are not
 * reachable as a number through the public `sdk-trace-base` surface, so this
 * covers the loss path an operator can act on: batches that were sent and
 * rejected. Every OTLP failure path reports an error and no success path does,
 * which keeps this off `ExportResultCode` — that enum is only exported by
 * `@opentelemetry/core`, which is not a declared dependency here.
 */
function counting(inner: SpanExporter): SpanExporter {
  return {
    export: (spans, done) =>
      inner.export(spans, (result) => {
        if (result.error) recordDroppedSpans(spans.length);
        done(result);
      }),
    shutdown: () => inner.shutdown(),
    forceFlush: async () => {
      await inner.forceFlush?.();
    },
  };
}

/**
 * Install the exporting provider, or leave the non-exporting default in place.
 *
 * No endpoint means no exporter is ever constructed, so nothing is queued and
 * nothing is sent. Spans still carry real ids either way, because the default
 * provider generates them; they simply go nowhere.
 */
export function configureTracing(): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  installTracerProvider(
    new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "orchestrator" }),
      spanProcessors: [new BatchSpanProcessor(counting(new OTLPTraceExporter()), QUEUE)],
    }),
  );
}
