import type { Ctx } from "../../ctx.ts";
import type { Frame, StoredEvent } from "../../contracts/events.ts";
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

type Enqueue = (frame: Frame) => Promise<void>;

function cursorFor(req: Request, since: number): number {
  const header = LastEventId.safeParse(req.headers.get("last-event-id"));
  return Math.max(since, header.success ? header.data : 0);
}

function projectResolver(ctx: Ctx): (grpId: number | null | undefined) => number | null {
  // grp -> project is immutable, so live tokens do not query once per token.
  const projects = new Map<number, number | null>();
  return (grpId) => {
    if (grpId == null) return null;
    if (!projects.has(grpId)) {
      projects.set(
        grpId,
        ctx.db.query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
          ?.project_id ?? null,
      );
    }
    return projects.get(grpId) ?? null;
  };
}

function frameSender(ctx: Ctx, stream: SSEStreamingApi): (frame: Frame) => Promise<void> {
  const projectOf = projectResolver(ctx);
  return (frame) =>
    stream.writeSSE({
      data: JSON.stringify({
        ...frame,
        projectId: (frame.type === "live" ? frame.projectId : null) ?? projectOf(frame.grpId),
      }),
      ...(frame.type === "event" ? { id: String(frame.seq) } : {}),
    });
}

async function sendEvents(
  events: StoredEvent[],
  lastSeq: number,
  stopped: () => boolean,
  enqueue: Enqueue,
): Promise<number> {
  for (const event of events) {
    if (stopped()) break;
    await enqueue({ type: "event", ...event });
    lastSeq = event.seq;
  }
  return lastSeq;
}

async function replay(ctx: Ctx, cursor: number, stopped: () => boolean, enqueue: Enqueue): Promise<number> {
  if (cursor === 0) return sendEvents(ctx.bus.latest(REPLAY_PAGE), cursor, stopped, enqueue);

  let lastSeq = cursor;
  while (!stopped()) {
    const page = ctx.bus.since(lastSeq, REPLAY_PAGE);
    lastSeq = await sendEvents(page, lastSeq, stopped, enqueue);
    if (page.length < REPLAY_PAGE) break;
  }
  return lastSeq;
}

async function flushPending(
  pending: Frame[],
  lastSeq: number,
  stopped: () => boolean,
  enqueue: Enqueue,
): Promise<void> {
  for (const frame of pending) {
    if (stopped()) return;
    if (frame.type === "event" && frame.seq <= lastSeq) continue;
    await enqueue(frame);
    if (frame.type === "event") lastSeq = frame.seq;
  }
}

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

  const send = frameSender(ctx, stream);
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
  const lastSeq = await replay(ctx, cursorFor(req, since), () => stopped, enqueue);

  await flushPending(pending, lastSeq, () => stopped, enqueue);
  replaying = false;

  if (!stopped) {
    beat = setInterval(() => {
      writes = writes.then(() => stream.write(": ping\n\n")).then(() => {});
    }, SSE_HEARTBEAT_MS);
  }
  await done;
  await writes;
}
