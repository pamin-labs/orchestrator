/**
 * The OTLP span exporter, installed once by composition when one is configured.
 *
 * Kept out of `traces.ts` so that importing trace context does not pull an HTTP
 * exporter into every module graph that only wants a trace id — including
 * `bun test`, which must perform no network I/O.
 */

import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { DB } from "../persistence/database.ts";
import { recordDroppedSpans } from "./metrics.ts";
import { StoredSpanExporter } from "./span-store.ts";
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
 * reachable as a number through the public `sdk-trace-base` surface, so this covers
 * the loss path an operator can act on: batches that were sent and rejected.
 *
 * On `code`, which `ExportResult` declares required, rather than the optional
 * `error` — an exporter that fails without attaching one would drop silently.
 */
function counting(inner: SpanExporter): SpanExporter {
  return {
    export: (spans, done) =>
      inner.export(spans, (result) => {
        if (result.code === ExportResultCode.FAILED) recordDroppedSpans(spans.length);
        done(result);
      }),
    shutdown: () => inner.shutdown(),
    forceFlush: async () => {
      await inner.forceFlush?.();
    },
  };
}

/**
 * Install the provider this process traces through.
 *
 * Both destinations are batched through the same `BatchSpanProcessor` and the same
 * bounds, because the reason is the same in both cases: export is a side channel,
 * and the work being traced must not wait on it or slow down with it. SQLite being
 * faster than an HTTP collector changes how often the queue fills, not whether
 * `onEnd` should be writing to a file at all.
 */
/**
 * The SQLite one is unconditional: the panel is the one consumer that is always
 * present, and a boss asking where a requirement's time went has no collector to
 * ask. The OTLP one is added beside it only when an endpoint is configured, so with
 * no endpoint nothing is sent and no socket is opened.
 */
export function configureTracing(db: DB): void {
  const spanProcessors: SpanProcessor[] = [new BatchSpanProcessor(new StoredSpanExporter(db), QUEUE)];
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    spanProcessors.push(new BatchSpanProcessor(counting(new OTLPTraceExporter()), QUEUE));
  }
  installTracerProvider(
    new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "orchestrator" }),
      spanProcessors,
    }),
  );
}
