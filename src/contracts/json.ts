import { z } from "zod";

/** JSON values accepted at every external trust boundary. */
export const JsonValue = z.json();
export const JsonObject = z.record(z.string(), JsonValue);
export type Json = z.infer<typeof JsonValue>;

/** Parse JSON text with an explicit caller-owned fallback. */
export function jsonOr<T>(text: string | null | undefined, schema: z.ZodType<T>, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}
