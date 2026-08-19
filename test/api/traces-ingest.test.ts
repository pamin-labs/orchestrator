import { expect, test } from "bun:test";
import { context, SpanKind, SpanStatusCode, trace as traceApi } from "@opentelemetry/api";
import { JsonTraceSerializer, ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { makeApp } from "../../src/composition/api.ts";
import { ErrorResponseSchema } from "../../src/contracts/protocol.ts";
import { readTrace } from "../../src/platform/observability/span-store.ts";
import { testContext } from "../support/test-context.ts";

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * A real OTLP/JSON payload, built by the same package an exporter uses.
 *
 * Nothing here is hand-written protobuf-JSON: `JsonTraceSerializer` is the
 * encoder `@opentelemetry/exporter-trace-otlp-http` ships with, so if its output
 * shape ever moves, this test moves with it rather than agreeing with a stale
 * copy of the specification.
 */
async function otlpPayload(): Promise<{ body: string; spans: ReadableSpan[] }> {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer("remote");

  const parent = tracer.startSpan("POST /api/v1/ideas", { kind: SpanKind.SERVER });
  parent.setAttributes({ "grp.id": 12, "http.route": "/api/v1/ideas" });
  const child = tracer.startSpan(
    "job agent_turn",
    { kind: SpanKind.INTERNAL },
    traceApi.setSpan(context.active(), parent),
  );
  child.setAttributes({ "grp.id": 12, "slice.id": 3, "job.kind": "agent_turn" });
  child.setStatus({ code: SpanStatusCode.ERROR });
  child.end();
  parent.end();
  await provider.forceFlush();

  const spans = exporter.getFinishedSpans();
  const bytes = JsonTraceSerializer.serializeRequest(spans);
  if (!bytes) throw new Error("the serializer produced nothing to send");
  // The exporter puts these exact bytes on the wire as UTF-8; decoding them here
  // only satisfies `BodyInit`.
  return { body: new TextDecoder().decode(bytes), spans };
}

test("the receiver stores a real OTLP payload and reads back as one trace", async () => {
  const ctx = testContext();
  const { body, spans } = await otlpPayload();

  const response = await makeApp(ctx)(
    new Request("http://x/api/v1/traces", { method: "POST", headers: JSON_HEADERS, body }),
  );

  expect(response.status).toBe(200);
  const traceId = spans[0]!.spanContext().traceId;
  const stored = readTrace(ctx.db, traceId);
  expect(stored.map((s) => s.name).sort()).toEqual(["POST /api/v1/ideas", "job agent_turn"]);

  const server = stored.find((s) => s.kind === "server")!;
  const job = stored.find((s) => s.kind === "internal")!;
  expect(job.parentSpanId).toBe(server.spanId);
  expect(job.status).toBe("error");
  expect(server.status).toBe("unset");
  // Attribute values survive as scalars, and the two scope columns come off them.
  expect(job.attributes["job.kind"]).toBe("agent_turn");
  expect(job.grpId).toBe(12);
  expect(job.sliceId).toBe(3);
  expect(server.sliceId).toBeNull();
  // Duration is derived from the two timestamps rather than trusted from a field.
  expect(server.durationMs).toBeGreaterThan(0);
});

test("the same export arriving twice writes the same rows", async () => {
  const ctx = testContext();
  const { body, spans } = await otlpPayload();
  const app = makeApp(ctx);
  const send = () => app(new Request("http://x/api/v1/traces", { method: "POST", headers: JSON_HEADERS, body }));

  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(200);

  expect(readTrace(ctx.db, spans[0]!.spanContext().traceId)).toHaveLength(2);
});

test("a malformed payload is refused with a stable error code and stores nothing", async () => {
  const ctx = testContext();
  const body = JSON.stringify({
    resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "nope", spanId: "also-nope", name: "x" }] }] }],
  });

  const response = await makeApp(ctx)(
    new Request("http://x/api/v1/traces", { method: "POST", headers: JSON_HEADERS, body }),
  );

  expect(response.status).toBe(400);
  expect(ErrorResponseSchema.parse(await response.json()).code).toBe("validation_failed");
  expect(ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM span").get()!.c).toBe(0);
});

test("a real protobuf export is refused on content type, before any parsing", async () => {
  const ctx = testContext();
  const { spans } = await otlpPayload();
  // Built by the library, not embedded. This endpoint speaks OTLP/JSON only —
  // the transformer has no request decoder — so a protobuf sender has to be told
  // that rather than have its bytes half-understood. The payload is real, so the
  // refusal is about the declared encoding and not about an unparseable body.
  const body = ProtobufTraceSerializer.serializeRequest(spans);
  if (!body) throw new Error("the serializer produced nothing to send");

  const response = await makeApp(ctx)(
    new Request("http://x/api/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: new Blob([body.slice()]),
    }),
  );

  expect(response.status).toBe(415);
  expect(ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM span").get()!.c).toBe(0);
});

test("a JSON content type carrying a charset is accepted", async () => {
  const ctx = testContext();
  const { body, spans } = await otlpPayload();

  // The media-type contract is a regex over the type alone, so the parameterised
  // form a client may send has to be covered deliberately rather than assumed.
  const response = await makeApp(ctx)(
    new Request("http://x/api/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
    }),
  );

  expect(response.status).toBe(200);
  expect(readTrace(ctx.db, spans[0]!.spanContext().traceId)).toHaveLength(2);
});

test("an empty export is accepted and writes nothing", async () => {
  const ctx = testContext();

  const response = await makeApp(ctx)(
    new Request("http://x/api/v1/traces", { method: "POST", headers: JSON_HEADERS, body: "{}" }),
  );

  expect(response.status).toBe(200);
  expect(ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM span").get()!.c).toBe(0);
});
