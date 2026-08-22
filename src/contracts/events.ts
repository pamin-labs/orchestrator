import { z } from "zod";
import type { Said } from "./said.ts";

/**
 * `meta.step`: which step of which process a row is, for a pane that draws one.
 *
 * The pane that draws a sandbox rebuild used to find its start and end by
 * matching the event body against Chinese sentence prefixes — which stopped
 * working the moment those bodies became `msg` templates rendered in the
 * reader's own language. These are protocol keys both sides import rather than
 * a sentence either side re-spells.
 */
/**
 * `meta` and not `intent`: `schema.ts` says intent is five words, deliberately,
 * and "anything finer a reader wants is a field". A sixth would dilute a speech
 * act into a progress marker, and `timeline/view.tsx` draws every one as a
 * badge. `meta` is where structured event data already lives — `meta.rule`,
 * `meta.split`, `meta.say` — and it is `jsonb`, so this costs no column.
 */
export const BOOTSTRAP_START = "bootstrap";
export const BOOTSTRAP_OK = "bootstrap_ok";
export const BOOTSTRAP_FAILED = "bootstrap_failed";

export const EventInputSchema = z.object({
  channelId: z.number().nullable().optional(),
  grpId: z.number().nullable().optional(),
  author: z.string(),
  kind: z.string(),
  intent: z.string().nullable().optional(),
  severity: z.string().nullable().optional(),
  body: z.string().optional(),
  target: z.string().nullable().optional(),
  correlationId: z.string().nullable().optional(),
  traceId: z.string().nullable().optional(),
  spanId: z.string().nullable().optional(),
  meta: z.json().optional(),
});

const StoredEventSchema = EventInputSchema.extend({ seq: z.number(), at: z.number() });

/** Live-only frames are useful to clients but do not belong in the audit log. */
const LiveFrameSchema = z.object({
  type: z.literal("live"),
  grpId: z.number().nullable(),
  projectId: z.number().nullable().optional(),
  agentId: z.number().nullable(),
  role: z.string().optional(),
  kind: z.enum(["text", "thinking", "tool", "status"]),
  body: z.string(),
  at: z.number().optional(),
});

export const FrameSchema = z.discriminatedUnion("type", [
  StoredEventSchema.extend({ type: z.literal("event") }),
  LiveFrameSchema,
]);

export type EventInput = Omit<z.infer<typeof EventInputSchema>, "meta"> & {
  meta?: object | string | number | boolean | null;
  /**
   * The sentence, unrendered, for the reader who is a browser.
   *
   * ADR 035 §3: nothing but the panel reads an event body, so the key rides in
   * `meta.say` and the panel renders it in the language its reader chose. `Bus`
   * still writes `body` from it — `NOT NULL`, and older rows have nothing else.
   * Stripped before the insert; `meta.say` is where it lands.
   */
  say?: Said;
};
export type StoredEvent = z.infer<typeof StoredEventSchema>;
export type LiveFrame = z.infer<typeof LiveFrameSchema>;
export type Frame = z.infer<typeof FrameSchema>;
