import type { DB } from "./db.ts";
import { scrub } from "./mech/util/scrub.ts";
import { jsonOr } from "./mech/util/text.ts";
import { z } from "zod";

/**
 * Append-only event log plus fan-out.
 *
 * Every view (timeline, desk wall, board, cost panel) is a projection of this
 * table, and the SSE feed is just a tail of it — so "what happened" has exactly
 * one home and the UI never needs its own state.
 */

const EventInputSchema = z.object({
  channelId: z.number().nullable().optional(),
  grpId: z.number().nullable().optional(),
  author: z.string(),
  kind: z.string(),
  intent: z.string().nullable().optional(),
  severity: z.string().nullable().optional(),
  body: z.string().optional(),
  target: z.string().nullable().optional(),
  meta: z.json().optional(),
});

const StoredEventSchema = EventInputSchema.extend({ seq: z.number(), at: z.number() });

/** Live-only frames (partial text, tool starts). Not persisted: they are noise
 *  in an audit log but essential for the "management feel" of watching a turn. */
const LiveFrameSchema = z.object({
  type: z.literal("live"),
  grpId: z.number().nullable(),
  /** A standing agent has no group, so this is the only thing that scopes its
      output to a project rather than to every project's feed. */
  projectId: z.number().nullable().optional(),
  agentId: z.number().nullable(),
  /** Who is talking. Without it the desk wall and the timeline say "agent". */
  role: z.string().optional(),
  kind: z.enum(["text", "thinking", "tool", "status"]),
  body: z.string(),
  /** When the sender says it happened. Omitted, the client stamps its own clock —
      which is why a panel holding both a stored tail and the live feed could not
      tell they were the same line. */
  at: z.number().optional(),
});

export const FrameSchema = z.discriminatedUnion("type", [
  StoredEventSchema.extend({ type: z.literal("event") }),
  LiveFrameSchema,
]);

export type EventInput = Omit<z.infer<typeof EventInputSchema>, "meta"> & {
  /** Producers use typed objects; persistence normalises them through JSON. */
  meta?: object | string | number | boolean | null;
};
export type StoredEvent = z.infer<typeof StoredEventSchema>;
export type LiveFrame = z.infer<typeof LiveFrameSchema>;
export type Frame = z.infer<typeof FrameSchema>;

type Sink = (f: Frame) => void;
type EventRow = Omit<StoredEvent, "meta"> & { meta_json: string };

export class Bus {
  private sinks = new Set<Sink>();

  constructor(private db: DB) {}

  subscribe(sink: Sink): () => void {
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
    const event = EventInputSchema.parse({ ...e, body, meta: jsonOr(metaJson, z.json(), {}) });
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
        ]
      >(
        `INSERT INTO event (channel_id, grp_id, author, kind, intent, severity, body, target, meta_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
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
      )!;
    const stored: StoredEvent = { ...event, seq: row.seq, at };
    this.fan({ type: "event", ...stored });
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
                body, target, meta_json, at
         FROM event WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(seq, limit)
      .map(({ meta_json, ...event }) => ({ ...event, meta: jsonOr(meta_json, z.json(), {}) }));
  }

  latest(limit = 500): StoredEvent[] {
    return this.db
      .query<EventRow, [number]>(
        `SELECT seq, channel_id AS channelId, grp_id AS grpId, author, kind, intent, severity,
                body, target, meta_json, at
         FROM event ORDER BY seq DESC LIMIT ?`,
      )
      .all(limit)
      .reverse()
      .map(({ meta_json, ...event }) => ({ ...event, meta: jsonOr(meta_json, z.json(), {}) }));
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
