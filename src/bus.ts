import type { DB } from "./db.ts";

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
  agentId: number | null;
  /** Who is talking. Without it the desk wall and the timeline say "agent". */
  role?: string;
  kind: "text" | "thinking" | "tool" | "status";
  body: string;
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

  /** Persist and fan out. Returns the assigned seq. */
  emit(e: EventInput): StoredEvent {
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
        JSON.stringify(e.meta ?? {}),
        at,
      )!;
    const stored: StoredEvent = { ...e, seq: row.seq, at };
    this.fan({ type: "event", ...stored });
    return stored;
  }

  /** Fan out without persisting. */
  live(f: Omit<LiveFrame, "type">): void {
    this.fan({ type: "live", ...f });
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
