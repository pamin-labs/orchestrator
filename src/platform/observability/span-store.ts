/**
 * Spans, in the same SQLite file as everything else they describe.
 *
 * The SDK ships spans to a collector when one is configured, and to nothing when
 * one is not. Neither case leaves anything the panel can read back: a boss asking
 * where a requirement's wall clock went has no collector to ask. So a destination
 * is the one piece of the tracing stack that has to be ours — the library cannot
 * know our database.
 *
 * It is a `SpanExporter`, not a `SpanProcessor`, and that is the whole point.
 * `SpanProcessor.onEnd` runs inside the operation being measured, so writing
 * there makes tracing a tax on the thing it observes. `SpanExporter` is the
 * documented seam for a destination, and `BatchSpanProcessor` — which the SDK
 * already ships and which the OTLP side already uses — supplies the bounded
 * queue, the drop-when-full policy, the batching and the flush timer. None of
 * that is written here.
 *
 * Registered *beside* the OTLP processor, never instead of it. Both see every
 * span; an operator who runs a real collector keeps it.
 */

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { Statement } from "bun:sqlite";
import { JsonObject, jsonOr } from "../../contracts/json.ts";
import type { DB } from "../persistence/database.ts";
import { recordDroppedSpans } from "./metrics.ts";

/** One row of the `span` table, and the only shape that reaches the SQL. */
export interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  /** Epoch milliseconds. */
  startedAt: number;
  durationMs: number;
  status: "unset" | "ok" | "error";
  attributes: Record<string, unknown>;
}

export interface StoredSpan extends SpanRow {
  projectId: number | null;
  grpId: number | null;
  sliceId: number | null;
}

/**
 * Retention, stated rather than left to grow.
 *
 * Two bounds because they fail differently. The age bound is the product one: a
 * requirement's timing is interesting while the requirement is open, and no
 * panel view looks further back than the week it ran in. The row bound is the
 * safety one — a retry storm or a hot loop can write a week's spans in an hour,
 * and an age bound alone would let it fill the disk before a single row aged
 * out. 200k rows is roughly 60MB of one laptop's SQLite file.
 *
 * Same shape as the idempotency store's own retention (age + count), because it
 * is the same problem: append-only history that nothing else deletes.
 */
export const SPAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const SPAN_MAX_ROWS = 200_000;

function spanKindName(kind: SpanKind | undefined): string {
  switch (kind) {
    case SpanKind.SERVER:
      return "server";
    case SpanKind.CLIENT:
      return "client";
    case SpanKind.PRODUCER:
      return "producer";
    case SpanKind.CONSUMER:
      return "consumer";
    case SpanKind.INTERNAL:
    case undefined:
      return "internal";
  }
}

function spanStatusName(code: SpanStatusCode | number | undefined): SpanRow["status"] {
  if (code === SpanStatusCode.OK) return "ok";
  if (code === SpanStatusCode.ERROR) return "error";
  return "unset";
}

/**
 * The scope columns, read off the span's own attributes.
 *
 * Nullable in the schema because most spans belong to no project: a `/healthz`
 * request and the retention trim itself are system work. An attribute that is
 * not a positive integer is treated as absent rather than coerced — a scope id
 * guessed from a string would aggregate somebody else's time into a group.
 */
function scopeId(attributes: Record<string, unknown>, key: string): number | null {
  const raw = attributes[key];
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function hrToMillis(time: [number, number]): number {
  return time[0] * 1_000 + time[1] / 1e6;
}

function toSpanRow(span: ReadableSpan): SpanRow {
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: spanKindName(span.kind),
    startedAt: Math.round(hrToMillis(span.startTime)),
    durationMs: hrToMillis(span.duration),
    status: spanStatusName(span.status.code),
    attributes: { ...span.attributes },
  };
}

/**
 * `OR IGNORE` on the natural key, so ingest is idempotent by construction.
 *
 * The same batch arriving twice — an OTLP client retrying a request whose
 * response it never saw — writes the same rows. That is why the receive route
 * does not carry an `Idempotency-Key`: there is no second side effect for one to
 * protect against.
 */
const INSERT = `
  INSERT OR IGNORE INTO span
    (trace_id, span_id, parent_span_id, name, kind, started_at, duration_ms, status,
     attributes_json, project_id, grp_id, slice_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

type InsertParams = [
  string,
  string,
  string | null,
  string,
  string,
  number,
  number,
  string,
  string,
  number | null,
  number | null,
  number | null,
];

function params(row: SpanRow): InsertParams {
  return [
    row.traceId,
    row.spanId,
    row.parentSpanId || null,
    row.name,
    row.kind,
    row.startedAt,
    row.durationMs,
    row.status,
    JSON.stringify(row.attributes),
    scopeId(row.attributes, "project.id"),
    scopeId(row.attributes, "grp.id"),
    scopeId(row.attributes, "slice.id"),
  ];
}

/** One transaction per batch: a batch lands whole or not at all. */
function insertAll(db: DB, insert: Statement<unknown, InsertParams>, rows: readonly SpanRow[]): void {
  db.transaction(() => {
    for (const row of rows) insert.run(...params(row));
  })();
}

/**
 * The receive endpoint's way in, where one call is one HTTP request rather than
 * one span, so preparing per call costs nothing worth caching.
 */
export function writeSpans(db: DB, rows: readonly SpanRow[]): void {
  if (rows.length === 0) return;
  insertAll(db, db.prepare<unknown, InsertParams>(INSERT), rows);
}

interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  started_at: number;
  duration_ms: number;
  status: string;
  attributes_json: string;
  project_id: number | null;
  grp_id: number | null;
  slice_id: number | null;
}

function decode(row: SpanRecord): StoredSpan {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    status: row.status === "ok" || row.status === "error" ? row.status : "unset",
    // Stored JSON is data on the way back in, so it is parsed against a schema
    // rather than asserted into shape — the same rule the write path follows.
    attributes: jsonOr(row.attributes_json, JsonObject, {}),
    projectId: row.project_id,
    grpId: row.grp_id,
    sliceId: row.slice_id,
  };
}

/**
 * A whole trace, oldest span first — the read the primary key exists for.
 *
 * `(trace_id, span_id)` leads with the trace, so this is a range scan over one
 * contiguous run of rows rather than a table scan with a filter.
 */
export function readTrace(db: DB, traceId: string): StoredSpan[] {
  return db
    .query<SpanRecord, [string]>("SELECT * FROM span WHERE trace_id = ? ORDER BY started_at, span_id")
    .all(traceId)
    .map(decode);
}

/**
 * Drop what is older than the age bound, then whatever still exceeds the row
 * bound. `maxRows` is a parameter only so a test can prove the second delete
 * without writing two hundred thousand rows to prove it.
 *
 * Called from the server's heartbeat, never from the write path: retention is
 * housekeeping on a schedule, and a span arriving is not a reason to run it.
 */
export function trimSpans(db: DB, now = Date.now(), maxRows = SPAN_MAX_ROWS): void {
  db.run("DELETE FROM span WHERE started_at < ?", [now - SPAN_MAX_AGE_MS]);
  db.run(
    `DELETE FROM span WHERE rowid IN (
       SELECT rowid FROM span ORDER BY started_at DESC LIMIT -1 OFFSET ?
     )`,
    [maxRows],
  );
}

/**
 * The destination. `BatchSpanProcessor` owns everything around it.
 *
 * `export` is handed a whole batch off the SDK's flush timer, so it runs outside
 * the operation being traced. The insert is prepared once for the life of the
 * exporter, and the batch commits in one transaction.
 */
export class SqliteSpanExporter implements SpanExporter {
  readonly #db: DB;
  readonly #insert: Statement<unknown, InsertParams>;
  #closed = false;

  constructor(db: DB) {
    this.#db = db;
    this.#insert = db.prepare<unknown, InsertParams>(INSERT);
  }

  /**
   * Losing spans is never a reason to fail the flush that carried them.
   *
   * `forceFlush` and `shutdown` are the process's shutdown path, and
   * `BatchSpanProcessor` turns a `FAILED` result into a rejected promise — so
   * reporting the failure here is how a closed or broken database turned a clean
   * shutdown into a rejection. It buys nothing either: the processor does not
   * retry, so the only consumer of `FAILED` is that rejection.
   *
   * The loss is still reported, through the channel an operator actually watches:
   * `orchestrator_telemetry_dropped_total`, the same counter the OTLP side uses
   * for batches a collector refused.
   */
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    // `shutdownTracing` swaps in a fresh provider before closing this one, so a
    // late flush can arrive after the database handle is gone.
    if (this.#closed) {
      recordDroppedSpans(spans.length);
    } else {
      try {
        insertAll(this.#db, this.#insert, spans.map(toSpanRow));
      } catch {
        recordDroppedSpans(spans.length);
      }
    }
    done({ code: ExportResultCode.SUCCESS });
  }

  // `forceFlush` is optional on `SpanExporter` and is deliberately not
  // implemented: every batch commits inside `export`, so there is never anything
  // buffered here to flush. The queue that does need draining belongs to
  // `BatchSpanProcessor`, and its own `forceFlush` drains it.

  shutdown(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
