import type { Ctx } from "../../ctx.ts";
import type { Frame } from "../../bus.ts";
import type { SSEStreamingApi } from "hono/streaming";
import { z } from "zod";

/**
 * One SSE stream, everything the panel draws off it.
 *
 * Replay from a cursor rather than "here is what happens next": a browser that
 * reconnects has to catch up on what it missed, and a stream that only carries
 * the future makes every reconnect a hole in the timeline.
 */

/** Idle SSE connections get dropped by proxies and by browsers' own timeouts. */
const SSE_HEARTBEAT_MS = 25_000;
const REPLAY_PAGE = 500;
const LastEventId = z.coerce.number().int().nonnegative();

export const StreamQuery = z.object({ since: z.coerce.number().int().nonnegative().default(0) });

export async function getStream(
  ctx: Ctx,
  req: Request,
  { since }: z.infer<typeof StreamQuery>,
  stream: SSEStreamingApi,
): Promise<void> {
  let unsub = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsub();
    if (beat) clearInterval(beat);
    req.signal.removeEventListener("abort", stop);
    finish();
  };
  stream.onAbort(stop);
  req.signal.addEventListener("abort", stop, { once: true });

  // grp -> project is immutable, so live tokens do not query once per token.
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
  const send = (data: Frame) =>
    stream.writeSSE({
      data: JSON.stringify({
        ...data,
        projectId: (data.type === "live" ? data.projectId : null) ?? projectOf(data.grpId),
      }),
      id: data.type === "event" ? String(data.seq) : undefined,
    });
  let writes = Promise.resolve();
  const enqueue = (frame: Frame) => (writes = writes.then(() => send(frame)));

  // Subscribe before replay. Events persisted while a long catch-up is running
  // are buffered, then deduped against the final replay cursor.
  const pending: Frame[] = [];
  let replaying = true;
  unsub = ctx.bus.subscribe((frame) => {
    if (replaying) pending.push(frame);
    else void enqueue(frame);
  });
  if (req.signal.aborted) {
    stop();
    return;
  }

  await stream.write("retry: 3000\n: connected\n\n");
  const header = LastEventId.safeParse(req.headers.get("last-event-id"));
  const cursor = Math.max(since, header.success ? header.data : 0);
  let lastSeq = cursor;
  if (cursor === 0) {
    for (const event of ctx.bus.latest(REPLAY_PAGE)) {
      if (stopped) break;
      await enqueue({ type: "event", ...event });
      lastSeq = event.seq;
    }
  } else {
    for (;;) {
      const page = ctx.bus.since(lastSeq, REPLAY_PAGE);
      for (const event of page) {
        if (stopped) break;
        await enqueue({ type: "event", ...event });
        lastSeq = event.seq;
      }
      if (stopped || page.length < REPLAY_PAGE) break;
    }
  }

  replaying = false;
  for (const frame of pending) {
    if (stopped) break;
    if (frame.type === "event" && frame.seq <= lastSeq) continue;
    await enqueue(frame);
    if (frame.type === "event") lastSeq = frame.seq;
  }

  if (!stopped) {
    beat = setInterval(() => {
      writes = writes.then(() => stream.write(": ping\n\n")).then(() => {});
    }, SSE_HEARTBEAT_MS);
  }
  await done;
  await writes;
}
