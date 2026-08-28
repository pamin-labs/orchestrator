import { z } from "zod";
import { JsonValue, type Json } from "./json.ts";
import { SaidSchema } from "./said.ts";

export const TextResponseSchema = z.object({ text: z.string() });

export const ProtocolResponse = z.object({
  status: z.int().min(100).max(599),
  body: JsonValue,
});
export type ProtocolResponse = z.infer<typeof ProtocolResponse>;

export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  request_id: z.string(),
  /**
   * The same refusal, unrendered, for the reader who is a browser.
   *
   * Its own field rather than a key under `details`: a descriptor's `values` are
   * whatever the macro interpolated, which `Json` cannot describe, and burying
   * it in a free-form record cost a `safeParse` on both sides to get it back.
   */
  said: SaidSchema.optional(),
  details: z.record(z.string(), JsonValue).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Keep malformed response bytes distinct from the valid JSON value `null`. */
/**
 * What a reader of a JSON reply actually needs.
 *
 * The annotation here was `Response`, which was the nearest name rather than the
 * true one — nothing that reads a reply streams it, clones it or follows a
 * redirect. hono's client hands back a `ClientResponse`, Response-shaped but not
 * a `Response`, and six call sites relied on the two being structurally
 * identical.
 */
/**
 * Bun 1.4.0 ended that by giving `Response` a `textStream()`: 81 errors across
 * nineteen files, every one about a method none of them calls. Naming the three
 * members that are read keeps both kinds assignable and states the contract
 * instead of borrowing one.
 */
export interface JsonReply {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export async function readJsonResponse(response: JsonReply): Promise<{ ok: true; data: Json } | { ok: false }> {
  try {
    const parsed = JsonValue.safeParse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Prefer a protocol error/message; otherwise render the JSON value itself. */
export function displayJson(value: Json, space?: number): string {
  if (value && !Array.isArray(value) && typeof value === "object") {
    if (typeof value.error === "string") return value.error;
    if (typeof value.message === "string") return value.message;
  }
  return JSON.stringify(value, null, space);
}
