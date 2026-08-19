/**
 * OTLP/HTTP trace ingest, on the panel's own protocol root.
 *
 * `POST /api/v1/traces` is not a spelling choice. An OTLP client appends
 * `/v1/traces` to its configured endpoint, so `…/api` lands exactly here — and a
 * bare `/v1/traces` would fall through to the static branch and 404, because
 * `isApplicationPath` recognises only `/healthz`, `/readyz`, `/api/v1/*` and
 * `/orch/v1/*`.
 */
/**
 * Trust boundary: whatever `/api/v1/*` already is — loopback by default, CSRF on
 * writes, the shared 1MiB body limit, and the shutdown gate. No agent token,
 * because an agent cannot reach this process at all; sandboxed turns go through
 * the file mailbox. A second, different rule on one route inside the panel root
 * would be the inconsistency, not the protection.
 *
 * An OTLP batch is at most 512 spans, so 1MiB is about 2KiB a span; a client that
 * trips it gets a 413 and should send smaller batches.
 */

import { z } from "zod";
import type { Handler } from "../../http/handler.ts";
import { json } from "../../http/respond.ts";
import { type SpanRow, writeSpans } from "../../platform/observability/span-store.ts";

const TraceId = z.string().regex(/^[0-9a-f]{32}$/i);
const SpanId = z.string().regex(/^[0-9a-f]{16}$/i);
/** Protobuf-JSON writes an absent `parentSpanId` as either omitted or empty. */
const OptionalSpanId = z.union([SpanId, z.literal("")]).optional();
/** `fixed64` crosses as a decimal string; a small enough one may cross as a number. */
const UnixNano = z.union([z.string().regex(/^\d+$/), z.number().nonnegative()]);

/**
 * One OTLP `AnyValue`, kept as the scalar it is.
 *
 * Only the four scalar cases are unwrapped. Arrays and nested key-value lists
 * are stored as the JSON they arrived as rather than flattened, because an
 * attribute we cannot name a column for is evidence, not a query key.
 */
const AnyValue = z.looseObject({
  stringValue: z.string().optional(),
  boolValue: z.boolean().optional(),
  intValue: z.union([z.string().regex(/^-?\d+$/), z.number()]).optional(),
  doubleValue: z.number().optional(),
});

const KeyValue = z.object({ key: z.string(), value: AnyValue.optional() });

const OtlpSpan = z.object({
  traceId: TraceId,
  spanId: SpanId,
  parentSpanId: OptionalSpanId,
  name: z.string(),
  // Offset by one against the API enum: the proto reserves 0 for "unspecified".
  kind: z.number().int().min(0).max(5).optional(),
  startTimeUnixNano: UnixNano,
  endTimeUnixNano: UnixNano,
  attributes: z.array(KeyValue).optional(),
  // `message` is part of OTLP's `Status` and was not accepted here, so a
  // collector that sent the reason had it stripped at the door. Bounded, because
  // this is a trust boundary and the field is free text from another process.
  status: z
    .object({ code: z.number().int().min(0).max(2).optional(), message: z.string().max(2_000).optional() })
    .optional(),
});

/**
 * The envelope, matching `ExportTraceServiceRequest`.
 *
 * `@opentelemetry/otlp-transformer` publishes no decoder — its `ISerializer`
 * only serializes a request and deserializes a *response* — so the boundary is
 * validated the way every other boundary in this project is, with Zod. The test
 * builds its payload with that package's `JsonTraceSerializer`, so the shape
 * this accepts is the shape the library actually emits rather than one read off
 * a specification.
 */
export const OtlpTraceBody = z.object({
  resourceSpans: z
    .array(
      z.looseObject({
        scopeSpans: z.array(z.looseObject({ spans: z.array(OtlpSpan).optional() })).optional(),
      }),
    )
    .optional(),
});

type OtlpTrace = z.infer<typeof OtlpTraceBody>;
type OtlpSpanValue = z.infer<typeof OtlpSpan>;
type AnyValueValue = z.infer<typeof AnyValue>;

function scalar(value: AnyValueValue | undefined): unknown {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.intValue !== undefined) return typeof value.intValue === "string" ? Number(value.intValue) : value.intValue;
  return value;
}

function attributes(pairs: OtlpSpanValue["attributes"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs ?? []) out[pair.key] = scalar(pair.value);
  return out;
}

const KIND_NAMES = ["internal", "internal", "server", "client", "producer", "consumer"] as const;

/** Nanoseconds since the epoch, as a number of milliseconds. */
const millis = (nanos: string | number): number => Number(BigInt(nanos) / 1_000n) / 1_000;

function toRow(span: OtlpSpanValue): SpanRow {
  const started = millis(span.startTimeUnixNano);
  return {
    traceId: span.traceId.toLowerCase(),
    spanId: span.spanId.toLowerCase(),
    parentSpanId: span.parentSpanId ? span.parentSpanId.toLowerCase() : null,
    name: span.name,
    kind: KIND_NAMES[span.kind ?? 0] ?? "internal",
    startedAt: Math.round(started),
    durationMs: Math.max(0, millis(span.endTimeUnixNano) - started),
    status: span.status?.code === 1 ? "ok" : span.status?.code === 2 ? "error" : "unset",
    // OTLP carries the reason beside the code and it was being dropped on the
    // floor here as well as in the table. Kept only for a failure, like the
    // exporter does.
    statusMessage: span.status?.code === 2 ? (span.status.message ?? null) : null,
    attributes: attributes(span.attributes),
  };
}

function otlpSpanRows(body: OtlpTrace): SpanRow[] {
  return (body.resourceSpans ?? []).flatMap((resource) =>
    (resource.scopeSpans ?? []).flatMap((scope) => (scope.spans ?? []).map(toRow)),
  );
}

/**
 * Accept an export.
 *
 * The response body is an empty `ExportTraceServiceResponse`, which is what the
 * protocol defines for a full success — a `partialSuccess` field would have to
 * name spans that were rejected, and validation rejects the whole batch or none
 * of it. Ingest is idempotent on `(trace_id, span_id)`, so a client retrying a
 * request whose response it never saw writes the same rows.
 */
export const postTraces = (async (ctx, _req, _params, body) => {
  await writeSpans(ctx.db, otlpSpanRows(body));
  return json({});
}) satisfies Handler<OtlpTrace>;
