import type { DB } from "./db.ts";
import { scrub } from "./mech/scrub.ts";

/**
 * Append-only event log plus fan-out.
 *
 * Every view (timeline, desk wall, board, cost panel) is a projection of this
 * table, and the SSE feed is just a tail of it — so "what happened" has exactly
 * one home and the UI never needs its own state.
 */

export interface EventInput {
  channelId?: number | null;
  grpId?: number | null;
  author: string;
  kind: string;
  intent?: string | null;
  severity?: string | null;
  body?: string;
  target?: string | null;
  meta?: unknown;
}

export interface StoredEvent extends EventInput {
  seq: number;
  at: number;
}

/** Live-only frames (partial text, tool starts). Not persisted: they are noise
 *  in an audit log but essential for the "management feel" of watching a turn. */
export interface LiveFrame {
  type: "live";
  grpId: number | null;
  /** A standing agent has no group, so this is the only thing that scopes its
      output to a project rather than to every project's feed. */
  projectId?: number | null;
  agentId: number | null;
  /** Who is talking. Without it the desk wall and the timeline say "agent". */
  role?: string;
  kind: "text" | "thinking" | "tool" | "status";
  body: string;
  /** When the sender says it happened. Omitted, the client stamps its own clock —
      which is why a panel holding both a stored tail and the live feed could not
      tell they were the same line. */
  at?: number;
}

export type Frame = ({ type: "event" } & StoredEvent) | LiveFrame;

type Sink = (f: Frame) => void;

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
    e = { ...e, body: scrub(e.body ?? "") };
    // `meta` too, not just the body. It is written to the same append-only row and
    // read back by the panel and the cost report, and several emitters put whole
    // CLI payloads in it — a credential landing there was as permanent as one in
    // the body, and only the body was ever masked. Scrubbed as serialised text
    // because the masker works on values, and `MASK` carries no quote so the JSON
    // survives it.
    const metaJson = scrub(JSON.stringify(e.meta ?? {}));
    const at = Date.now();
    const row = this.db
      .query<
        { seq: number },
        [number | null, number | null, string, string, string | null, string | null, string, string | null, string, number]
      >(
        `INSERT INTO event (channel_id, grp_id, author, kind, intent, severity, body, target, meta_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      )
      .get(
        e.channelId ?? null,
        e.grpId ?? null,
        e.author,
        e.kind,
        e.intent ?? null,
        e.severity ?? null,
        e.body ?? "",
        e.target ?? null,
        metaJson,
        at,
      )!;
    const stored: StoredEvent = { ...e, seq: row.seq, at };
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
      .query<any, [number, number]>(
        `SELECT seq, channel_id AS channelId, grp_id AS grpId, author, kind, intent, severity,
                body, target, meta_json, at
         FROM event WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(seq, limit)
      .map((r) => ({ ...r, meta: safeJson(r.meta_json) }));
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

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
