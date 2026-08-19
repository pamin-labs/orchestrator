import type { Ctx } from "../mech/ctx.ts";
import type { Caller } from "./agent-auth.ts";

/**
 * What a route handler is, and deliberately not what Hono thinks one is.
 *
 * A handler takes what it needs — the fleet, the request, the path parameters, the
 * validated body — and returns a `Response`. It never sees a framework context, so
 * every one can be called from a test with four ordinary arguments and no server.
 *
 * `http/routes/*` connects this shape to Hono, beside the Zod middleware.
 */
export type Handler<D = undefined, P = Record<string, string>> = (
  ctx: Ctx,
  req: Request,
  params: P,
  data: D,
) => Promise<Response>;

/**
 * A route only an agent may call, with the caller already resolved.
 *
 * The caller is an argument because the alternative was 21 handlers each opening
 * with the same two lines — and a trust boundary retyped 21 times is a trust
 * boundary with 21 chances to be left out.
 */
export type AgentHandler<D = undefined, P = Record<string, string>> = (
  ctx: Ctx,
  req: Request,
  a: Caller,
  params: P,
  data: D,
) => Promise<Response>;
