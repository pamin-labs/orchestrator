import { z } from "zod";

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
};
export type StoredEvent = z.infer<typeof StoredEventSchema>;
export type LiveFrame = z.infer<typeof LiveFrameSchema>;
export type Frame = z.infer<typeof FrameSchema>;
