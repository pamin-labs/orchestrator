import { and, asc, desc, gt, lt, notInArray } from "drizzle-orm";
import { openTransaction, transaction, writeHandle } from "./database.ts";
import type { DB } from "./database.ts";
import { event } from "./schema.ts";
import {
  EventInputSchema,
  type EventInput,
  type Frame,
  type LiveFrame,
  type StoredEvent,
} from "../../contracts/events.ts";
import { jsonOr, valueOr, JsonValue } from "../../contracts/json.ts";
import { requestContext } from "../observability/request-context.ts";
import { scrub } from "../observability/redaction.ts";

/**
 * Append-only event log plus fan-out.
 *
 * Every view (timeline, desk wall, board, cost panel) is a projection of this
 * table, and the SSE feed is just a tail of it — so "what happened" has exactly
 * one home and the UI never needs its own state.
 */

type ValidatedEventInput = Omit<StoredEvent, "seq" | "at">;

/** An unset optional field is stored as NULL, never as placeholder text. */
const orNull = <T>(v: T | null | undefined): T | null => v ?? null;

/**
 * The stored columns under the names the contract uses.
 *
 * One selection for both readers, so a column added to one is added to the other.
 */
const COLUMNS = {
  seq: event.seq,
  channelId: event.channel_id,
  grpId: event.grp_id,
  author: event.author,
  kind: event.kind,
  intent: event.intent,
  severity: event.severity,
  body: event.body,
  target: event.target,
  meta_json: event.meta_json,
  at: event.at,
  correlationId: event.correlation_id,
  traceId: event.trace_id,
  spanId: event.span_id,
};

/**
 * `meta_json` is `jsonb`, so the driver hands back a value and not text.
 *
 * Still validated: the row may have been written by an older build, and every
 * reader downstream is typed against the contract rather than against whatever
 * that build stored.
 */
const toStored = <T extends { meta_json: unknown }>({ meta_json, ...e }: T) => ({
  ...e,
  meta: valueOr(meta_json, JsonValue, {}),
});

/**
 * What the event table keeps forever, and what it does not.
 *
 * The conversation is the durable record: `say`, `boss_say`, `note` and
 * `escalation` are what the boss wrote, what an agent answered, and the unread
 * cursor's own vocabulary — deleting one moves an agent's cursor past a message
 * nobody read. Everything else is machine chatter about work already finished.
 */
const KEPT_FOREVER = ["say", "boss_say", "note", "escalation"] as const;

/**
 * The chatter is read inside a day and never again.
 *
 * `tool_summary` feeds 成本's hourly chart, which asks for the last 24 hours;
 * `state_change` is the largest kind by emitters and nothing reads it back at
 * all. There was no `DELETE FROM event` anywhere but project deletion, so both
 * accumulated for the life of the installation — and a stale SSE cursor replays
 * every row of it.
 */
export async function trimEvents(db: DB, olderThanMs: number, now = Date.now()): Promise<number> {
  // `.returning()` rather than the driver's own row count: `DB` is either driver,
  // and the two do not report one under the same name.
  const gone = await db
    .delete(event)
    .where(and(lt(event.at, now - olderThanMs), notInArray(event.kind, [...KEPT_FOREVER])))
    .returning({ seq: event.seq });
  return gone.length;
}

export class Bus {
  private sinks = new Set<(frame: Frame) => void>();

  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
  }

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
  async emit(e: EventInput): Promise<StoredEvent> {
    const event = this.prepare(e);
    const at = Date.now();
    const open = openTransaction.getStore();
    const seq = await this.insert(event, at, writeHandle(this.db));
    const stored: StoredEvent = { ...event, seq, at };
    // Deferred, not fanned, while a transaction is open: a subscriber told about
    // an event whose transaction then rolls back has been told about work that
    // did not happen.
    if (open) open.onCommit.push(() => this.fan({ type: "event", ...stored }));
    else this.fan({ type: "event", ...stored });
    return stored;
  }

  /**
   * A transaction whose events belong to it.
   *
   * `db.transaction` alone is not enough twice over. The row: an emit through the
   * outer handle writes on another connection, so it outlives a rollback — and on
   * the single-connection driver the tests use it deadlocks instead. The fan: a
   * subscriber told inside a transaction cannot be untold. Both are structural
   * here rather than remembered at each call site, so `emit` needs no argument.
   */
  async transaction<T>(run: (tx: DB) => Promise<T>): Promise<T> {
    return transaction(this.db, run);
  }

  private prepare(e: EventInput): ValidatedEventInput {
    const body = scrub(e.body ?? "");
    // `meta` too, not just the body. It is written to the same append-only row and
    // read back by the panel and the cost report, and several emitters put whole
    // CLI payloads in it — a credential landing there was as permanent as one in
    // the body, and only the body was ever masked. Scrubbed as serialised text
    // because the masker works on values, and `MASK` carries no quote so the JSON
    // survives it.
    const metaJson = scrub(JSON.stringify(e.meta ?? {}));
    const context = requestContext.getStore();
    return EventInputSchema.parse({
      ...e,
      body,
      meta: jsonOr(metaJson, JsonValue, {}),
      ...(context ? { correlationId: context.requestId, traceId: context.traceId, spanId: context.spanId } : {}),
    });
  }

  private async insert(e: ValidatedEventInput, at: number, on: DB): Promise<number> {
    const [row] = await on
      .insert(event)
      .values({
        channel_id: orNull(e.channelId),
        grp_id: orNull(e.grpId),
        author: e.author,
        kind: e.kind,
        intent: orNull(e.intent),
        severity: orNull(e.severity),
        body: e.body ?? "",
        target: orNull(e.target),
        meta_json: e.meta ?? {},
        at,
        correlation_id: orNull(e.correlationId),
        trace_id: orNull(e.traceId),
        span_id: orNull(e.spanId),
      })
      .returning({ seq: event.seq });
    return row!.seq;
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

  async since(seq: number, limit = 500): Promise<StoredEvent[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(event)
      .where(gt(event.seq, seq))
      .orderBy(asc(event.seq))
      .limit(limit);
    return rows.map(toStored);
  }

  async latest(limit = 500): Promise<StoredEvent[]> {
    const rows = await this.db.select(COLUMNS).from(event).orderBy(desc(event.seq)).limit(limit);
    return rows.reverse().map(toStored);
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
}
