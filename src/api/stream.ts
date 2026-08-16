import { type Handler } from "./shared.ts";

/**
 * One SSE stream, everything the panel draws off it.
 *
 * Replay from a cursor rather than "here is what happens next": a browser that
 * reconnects has to catch up on what it missed, and a stream that only carries
 * the future makes every reconnect a hole in the timeline.
 */

/** Idle SSE connections get dropped by proxies and by browsers' own timeouts. */
const SSE_HEARTBEAT_MS = 25_000;

export const getStream: Handler = async (ctx, req) => {
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
  let unsub = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      const raw = (s: string) => {
        try {
          c.enqueue(enc.encode(s));
          return true;
        } catch {
          unsub();
          if (beat) clearInterval(beat);
          return false;
        }
      };
      // Which project a frame belongs to, so the feed can be scoped. grp -> project
      // is immutable, so it is cached rather than queried per frame — live frames
      // arrive per token.
      const ofGrp = new Map<number, number | null>();
      const projectOf = (grpId: number | null | undefined): number | null => {
        if (grpId == null) return null;
        if (!ofGrp.has(grpId)) {
          ofGrp.set(
            grpId,
            ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
              ?.project_id ?? null,
          );
        }
        return ofGrp.get(grpId) ?? null;
      };
      const send = (data: any) =>
        raw(`data: ${JSON.stringify({ ...data, projectId: data.projectId ?? projectOf(data.grpId) })}\n\n`);

      // A stream that sends nothing has sent no bytes, and a browser does not
      // report a byteless response as open — the UI sat on "connecting…" forever
      // on a fresh database with no events to replay. The comment also defeats
      // proxy buffering, and `retry` sets the reconnect delay.
      raw(`retry: 3000\n: connected\n\n`);

      for (const e of ctx.bus.since(since)) send({ type: "event", ...e });
      unsub = ctx.bus.subscribe(send);
      beat = setInterval(() => raw(`: ping\n\n`), SSE_HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => {
        unsub();
        if (beat) clearInterval(beat);
        try {
          c.close();
        } catch {}
      });
    },
    cancel() {
      unsub();
      if (beat) clearInterval(beat);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
};
