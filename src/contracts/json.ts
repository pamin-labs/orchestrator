import { z } from "zod";

/** JSON values accepted at every external trust boundary. */
export const JsonValue = z.json();
export const JsonObject = z.record(z.string(), JsonValue);
export type Json = z.infer<typeof JsonValue>;

/**
 * Validate a value the database already parsed, with a caller-owned fallback.
 *
 * A `jsonb` column hands back a value, not text, and it is still `unknown`: the
 * row may have been written by an older build, which is why the column is typed
 * `Json` and not the shape a reader wants. This is where that shape is decided,
 * and the fallback is the caller's because only the caller knows what an absent
 * one means.
 */
export function valueOr<T>(value: unknown, schema: z.ZodType<T>, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** The same, for JSON that is still text — a file, a header, a tool's stdout. */
export function jsonOr<T>(text: string | null | undefined, schema: z.ZodType<T>, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return valueOr(JSON.parse(text), schema, fallback);
  } catch {
    return fallback;
  }
}
