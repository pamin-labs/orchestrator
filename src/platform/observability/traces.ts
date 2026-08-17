/**
 * W3C trace context, and the OTLP span that carries it off the machine.
 *
 * Separated from metrics because they answer different questions and fail
 * differently: a metric is a number this process holds, a span is a record
 * shipped to something that may not be listening. The exporter is deliberately
 * lossy — see `MAX_ACTIVE_EXPORTS`.
 */

const MAX_ACTIVE_EXPORTS = 8;
let activeExports = 0;
let droppedExports = 0;

export interface Trace {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  started: bigint;
  startedUnixNano: bigint;
}

const newId = (length: number) => crypto.randomUUID().replaceAll("-", "").slice(0, length);
const startedNow = () => ({ started: process.hrtime.bigint(), startedUnixNano: BigInt(Date.now()) * 1_000_000n });

export function startTrace(traceparent?: string): Trace {
  const incoming = traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  return {
    traceId: incoming?.[1]?.toLowerCase() ?? newId(32),
    spanId: newId(16),
    ...(incoming?.[2] ? { parentSpanId: incoming[2].toLowerCase() } : {}),
    ...startedNow(),
  };
}

export function startChildTrace(traceId?: string | null, parentSpanId?: string | null): Trace {
  return {
    traceId: traceId ?? newId(32),
    spanId: newId(16),
    ...(parentSpanId ? { parentSpanId } : {}),
    ...startedNow(),
  };
}

export function traceparent(trace: Trace): string {
  return `00-${trace.traceId}-${trace.spanId}-01`;
}

/** How many spans were dropped rather than queued. Reported as a metric. */
export const droppedSpans = (): number => droppedExports;

export type SpanAttribute = { key: string; value: { stringValue: string } | { intValue: number } };

/**
 * Ship one span, or drop it.
 *
 * There is no queue and no retry on purpose. The exporter is a side channel: if
 * the collector is slow or gone, the work being traced must not slow down or
 * fail with it, so beyond `MAX_ACTIVE_EXPORTS` in flight the span is counted and
 * discarded. The count is itself a metric, so the loss is visible rather than
 * silent.
 */
export function exportSpan(
  name: string,
  kind: number,
  failed: boolean,
  seconds: number,
  trace: Trace,
  attributes: SpanAttribute[],
): void {
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, "");
  if (!base) return;
  if (activeExports >= MAX_ACTIVE_EXPORTS) {
    droppedExports += 1;
    return;
  }
  const ended = trace.startedUnixNano + BigInt(Math.round(seconds * 1e9));
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "orchestrator" } }] },
        scopeSpans: [
          {
            scope: { name: "orchestrator.http" },
            spans: [
              {
                traceId: trace.traceId,
                spanId: trace.spanId,
                ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
                name,
                kind,
                startTimeUnixNano: trace.startedUnixNano.toString(),
                endTimeUnixNano: ended.toString(),
                attributes,
                status: { code: failed ? 2 : 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  activeExports += 1;
  void fetch(`${base}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  })
    .catch(() => {})
    .finally(() => {
      activeExports -= 1;
    });
}
