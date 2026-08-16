import type { TypedResponse } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

export const JsonValue = z.json();
export const JsonObject = z.record(z.string(), JsonValue);
export type Json = z.infer<typeof JsonValue>;
export const TextResponseSchema = z.object({ text: z.string() });
export const ProtocolResponse = z.object({
  status: z.int().min(100).max(599),
  body: JsonValue,
});
export type ProtocolResponse = z.infer<typeof ProtocolResponse>;
export type JsonResponse<T, S extends ContentfulStatusCode = 200> = Response & TypedResponse<T, S, "json">;
export type ErrorResponses<S extends ContentfulStatusCode> = { [Status in S]: { json: { error: string } } };

/** Keep malformed response bytes distinct from the valid JSON value `null`. */
export async function readJsonResponse(response: Response): Promise<{ ok: true; data: Json } | { ok: false }> {
  try {
    const parsed = JsonValue.safeParse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** JSON responses created outside a Hono context retain Hono's response type. */
export const json = <T extends object | string | number | boolean | null, S extends ContentfulStatusCode = 200>(
  data: T,
  status: S = 200 as S,
): JsonResponse<T, S> =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  }) as JsonResponse<T, S>;

export const message = <S extends ContentfulStatusCode = 200>(message: string, status: S = 200 as S) =>
  status >= 400 ? json({ error: message }, status) : json({ message }, status);

export const failure = <S extends ContentfulStatusCode>(error: string, status: S) => json({ error }, status);

/** The request was valid JSON but its operation was refused. */
export const bad = (error: string) => failure(error, 422);
