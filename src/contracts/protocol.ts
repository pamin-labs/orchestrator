import { z } from "zod";
import { JsonValue, type Json } from "./json.ts";

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
  details: z.record(z.string(), JsonValue).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Keep malformed response bytes distinct from the valid JSON value `null`. */
export async function readJsonResponse(response: Response): Promise<{ ok: true; data: Json } | { ok: false }> {
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
