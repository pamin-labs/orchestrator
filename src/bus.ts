import type { DB } from "./db.ts";
import { EventInputSchema, type EventInput, type Frame, type LiveFrame, type StoredEvent } from "./contracts/events.ts";
import { jsonOr, JsonValue } from "./contracts/json.ts";
import { scrub } from "./mech/util/scrub.ts";
import { requestContext } from "./http/request-context.ts";

/**
 * Append-only event log plus fan-out.
 *
 * Every view (timeline, desk wall, board, cost panel) is a projection of this
 * table, and the SSE feed is just a tail of it — so "what happened" has exactly
 * one home and the UI never needs its own state.
 */

type EventRow = Omit<StoredEvent, "meta"> & { meta_json: string };

export class Bus {
  private sinks = new Set<(frame: Frame) => void>();
  /**
   * Events inserted by a synchronous SQLite transaction cannot be fanned until
   * its outermost transaction commits. The seq is AUTOINCREMENT but a rolled
   * back value may be reused, so the value is also an identity guard: a later
   * event that reuses the seq replaces this pending entry and is the only one
   * allowed to fan.
   */
  private pending = new Map<number, StoredEvent>();

  constructor(private db: DB) {}

  subscribe(sink: (frame: Frame) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /**
   * Persist and fan out. Returns the assigned seq.
   *
   * The body is scrubbed before it is written, not on the way to a reader: an
   * event is append-only, so a credential that reaches this table is there for
   * good. `claude setup-token` prints the token it mints and the login streams
   * the CLI's output, which is how one got here.
   */
  emit(e: EventInput): StoredEvent {
    const body = scrub(e.body ?? "");
    // `meta` too, not just the body. It is written to the same append-only row and
    // read back by the panel and the cost report, and several emitters put whole
    // CLI payloads in it — a credential landing there was as permanent as one in
    // the body, and only the body was ever masked. Scrubbed as serialised text
    // because the masker works on values, and `MASK` carries no quote so the JSON
    // survives it.
    const metaJson = scrub(JSON.stringify(e.meta ?? {}));
    const context = requestContext.getStore();
    const event = EventInputSchema.parse({
      ...e,
      body,
      meta: jsonOr(metaJson, JsonValue, {}),
      ...(context ? { correlationId: context.requestId, traceId: context.traceId, spanId: context.spanId } : {}),
    });
    const at = Date.now();
    const row = this.db
      .query<
        { seq: number },
        [
          number | null,
          number | null,
          string,
          string,
          string | null,
          string | null,
          string,
          string | null,
          string,
          number,
          string | null,
          string | null,
          string | null,
        ]
      >(
        `INSERT INTO event
           (channel_id, grp_id, author, kind, intent, severity, body, target, meta_json, at,
            correlation_id, trace_id, span_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      )
      .get(
        event.channelId ?? null,
        event.grpId ?? null,
        event.author,
        event.kind,
        event.intent ?? null,
        event.severity ?? null,
        event.body ?? "",
        event.target ?? null,
        metaJson,
        at,
        event.correlationId ?? null,
        event.traceId ?? null,
        event.spanId ?? null,
      )!;
    const stored: StoredEvent = { ...event, seq: row.seq, at };
    this.publish(stored);
    return stored;
  }

  /**
   * Fan out without persisting.
   *
   * Scrubbed too. It never reaches the database, but it does reach every open
   * browser, a screenshot, and whatever the boss pastes that screenshot into.
   */
  live(f: Omit<LiveFrame, "type">): void {
    this.fan({ type: "live", ...f, body: scrub(f.body) });
  }

  since(seq: number, limit = 500): StoredEvent[] {
    return this.db
      .query<EventRow, [number, number]>(
        `SELECT seq, channel_id AS channelId, grp_id AS grpId, author, kind, intent, severity,
                body, target, meta_json, at, correlation_id AS correlationId,
                trace_id AS traceId, span_id AS spanId
         FROM event WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(seq, limit)
      .map(({ meta_json, ...event }) => ({ ...event, meta: jsonOr(meta_json, JsonValue, {}) }));
  }

  latest(limit = 500): StoredEvent[] {
    return this.db
      .query<EventRow, [number]>(
        `SELECT seq, channel_id AS channelId, grp_id AS grpId, author, kind, intent, severity,
                body, target, meta_json, at, correlation_id AS correlationId,
                trace_id AS traceId, span_id AS spanId
         FROM event ORDER BY seq DESC LIMIT ?`,
      )
      .all(limit)
      .reverse()
      .map(({ meta_json, ...event }) => ({ ...event, meta: jsonOr(meta_json, JsonValue, {}) }));
  }

  private fan(f: Frame): void {
    for (const s of this.sinks) {
      try {
        s(f);
      } catch {
        // A dead SSE connection must never break the emitter.
      }
    }
  }

  private publish(event: StoredEvent): void {
    if (!this.db.inTransaction) {
      // A rolled-back transaction may have reserved this AUTOINCREMENT value.
      // The committed event owns it now; invalidate the stale microtask.
      this.pending.delete(event.seq);
      this.fan({ type: "event", ...event });
      return;
    }

    this.pending.set(event.seq, event);
    queueMicrotask(() => {
      if (this.pending.get(event.seq) !== event) return;
      this.pending.delete(event.seq);
      try {
        const committed = this.db
          .query<{ seq: number }, [number]>("SELECT seq FROM event WHERE seq = ?")
          .get(event.seq);
        if (committed) this.fan({ type: "event", ...event });
      } catch {
        // Shutdown may close the handle after the commit but before this
        // microtask. The row is durable and reconnecting readers will tail it.
      }
    });
  }
}
