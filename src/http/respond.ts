import type { TypedResponse } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Json } from "../contracts/json.ts";
import type { ErrorResponse } from "../contracts/protocol.ts";
import type { Said } from "../contracts/said.ts";
import { renderSaid } from "../platform/text/lang.ts";
import { currentRequestId } from "../platform/observability/request-context.ts";

export type JsonResponse<T, S extends ContentfulStatusCode = 200> = Response & TypedResponse<T, S, "json">;
export type ErrorResponses<S extends ContentfulStatusCode> = { [Status in S]: { json: ErrorResponse } };

/** JSON responses created outside a Hono context retain Hono's response type. */
export const json = <T extends object | string | number | boolean | null, S extends ContentfulStatusCode = 200>(
  data: T,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic default preserves the caller's literal Hono status
  status: S = 200 as S,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Response.json cannot express Hono's compile-time TypedResponse marker
): JsonResponse<T, S> => Response.json(data, { status }) as JsonResponse<T, S>;

const ERROR_CODES: Partial<Record<ContentfulStatusCode, string>> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "operation_refused",
  429: "rate_limited",
  500: "internal_error",
  502: "upstream_error",
  503: "unavailable",
  504: "upstream_timeout",
};

export function failure<S extends ContentfulStatusCode>(
  error: string,
  status: S,
  code = ERROR_CODES[status] ?? "request_failed",
  details?: Readonly<Record<string, Json>>,
  said?: Said,
): JsonResponse<ErrorResponse, S> {
  return json(
    {
      error,
      code,
      request_id: currentRequestId(),
      ...(said ? { said } : {}),
      ...(details ? { details } : {}),
    },
    status,
  );
}

export const message = <S extends ContentfulStatusCode = 200>(
  message: string,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic default preserves the caller's literal Hono status
  status: S = 200 as S,
) => (status >= 400 ? failure(message, status) : json({ message }, status));

/**
 * The request was valid JSON but its operation was refused.
 *
 * `bad(msg\`no code given\`)`: the panel renders the descriptor in the language
 * the boss reads, and the English that also goes out — a 422 body is read from a
 * terminal and by whatever logs it — is rendered here from the same catalogue
 * rather than written again at the call site.
 */
export const bad = (said: Said) => failure(renderSaid("en", said), 422, undefined, undefined, said);

/**
 * A refusal that stays English, named so nothing has to keep a list of which
 * ones those are.
 *
 * `this server has no GitHub client` reports a broken install rather than a
 * value anybody can correct, and ADR 035 leaves those in the English column.
 * The choice is the call site's and it is spelled at the call site; the guard in
 * `test/api/refusals-carry-an-id.test.ts` only has to find `bad("…")`, which
 * this overload no longer accepts.
 */
export const badEnglish = (reason: string) => failure(reason, 422);
