import type { Env, Hono } from "hono";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Caller, Ctx } from "../ctx.ts";
import type { AgentHandler, Handler } from "./handler.ts";
import { text } from "./respond.ts";

/**
 * Register a route: path, schema, handler — and let the compiler check that the
 * handler expects what the schema produces.
 *
 * Passing both to one call is the whole point. The first version took them
 * separately and had a `Handler<any>` in the middle, so the schema could say one
 * thing and the handler destructure another with nothing to stop it. Here the
 * schema output is the handler's `data` or `params` parameter: change a schema,
 * forget its handler, get a compile error.
 *
 * Decorators are the other way to write this down and they are the wrong tool —
 * stage 3 has no parameter decorators, which is exactly what a decorator-driven
 * router needs, and the ones that work need a metadata runtime and a container.
 * That is a framework. This is a function argument.
 */

/** Anything implementing Standard Schema: zod, valibot, arktype. */
type Schema<T> = StandardSchemaV1<unknown, T>;
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; status: 400 | 422 };

/** Validate one boundary value without confusing a valid string with an error. */
async function parse<T>(schema: Schema<T>, value: unknown): Promise<Parsed<T>> {
  const r = await schema["~standard"].validate(value);
  if (!r.issues) return { ok: true, value: r.value };
  const error =
    r.issues
      .map((i) => {
        const path = (i.path ?? [])
          .map((p) => (typeof p === "object" && p !== null && "key" in p ? String(p.key) : String(p)))
          .join(".");
        return path ? `${path}: ${i.message}` : i.message;
      })
      .join("\n") || "invalid request";
  return { ok: false, error, status: 422 };
}

/**
 * A missing body is `{}`, so a schema made of defaults still runs on an empty
 * POST. A nonempty malformed body is different: treating `{` as `{}` let every
 * all-optional schema approve it, including the one behind `groups/:id/drop`.
 *
 * There used to be a 415 gate in front of this. It went because `Request.json()`
 * does not read the header — measured: a JSON body labelled `text/plain` parses
 * — so the gate refused requests that would otherwise have worked. Its security
 * half is `csrf()` in `api.ts`, which is where it belongs: that check is about who
 * sent the request, not about what it said it was.
 */
async function readBody(req: Request): Promise<Parsed<unknown>> {
  if (req.body === null) return { ok: true, value: {} };
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return { ok: false, error: "invalid JSON", status: 400 };
  }
}

type Method = "get" | "post" | "put" | "delete";
type WithBody<B> = { body: Schema<B> };
type WithoutBody = { body?: undefined };
type RawParams = { params?: undefined };
type WithParams<P> = { params: Schema<P> };

type RawBodyOpts<B> = WithBody<B> & RawParams & { handler: Handler<B> };
type EmptyRawOpts = WithoutBody & RawParams & { handler: Handler };
type ParsedBodyOpts<B, P> = WithBody<B> & WithParams<P> & { handler: Handler<B, P> };
type EmptyParsedOpts<P> = WithoutBody & WithParams<P> & { handler: Handler<undefined, P> };

async function parsedBody<B>(schema: Schema<B>, req: Request): Promise<Parsed<B>> {
  const body = await readBody(req);
  return body.ok ? parse(schema, body.value) : body;
}

export function route<E extends Env, B, P>(
  app: Hono<E>,
  ctx: Ctx,
  method: Method,
  path: string,
  o: ParsedBodyOpts<B, P>,
): void;
export function route<E extends Env, P>(
  app: Hono<E>,
  ctx: Ctx,
  method: Method,
  path: string,
  o: EmptyParsedOpts<P>,
): void;
export function route<E extends Env, B>(app: Hono<E>, ctx: Ctx, method: Method, path: string, o: RawBodyOpts<B>): void;
export function route<E extends Env>(app: Hono<E>, ctx: Ctx, method: Method, path: string, o: EmptyRawOpts): void;
/** A route the panel calls. */
export function route<E extends Env, B, P>(
  app: Hono<E>,
  ctx: Ctx,
  method: Method,
  path: string,
  o: ParsedBodyOpts<B, P> | EmptyParsedOpts<P> | RawBodyOpts<B> | EmptyRawOpts,
): void {
  app.on(method, path, async (c) => {
    if (o.params) {
      const params = await parse(o.params, c.req.param());
      if (!params.ok) return text(params.error, params.status);
      if (!o.body) return o.handler(ctx, c.req.raw, params.value, undefined);
      const data = await parsedBody(o.body, c.req.raw);
      return data.ok ? o.handler(ctx, c.req.raw, params.value, data.value) : text(data.error, data.status);
    }

    if (!o.body) return o.handler(ctx, c.req.raw, c.req.param(), undefined);
    const data = await parsedBody(o.body, c.req.raw);
    return data.ok ? o.handler(ctx, c.req.raw, c.req.param(), data.value) : text(data.error, data.status);
  });
}

type AgentEnv = { Variables: { agent: Caller } };
type AgentRawBodyOpts<B> = WithBody<B> & RawParams & { handler: AgentHandler<B> };
type EmptyRawAgentOpts = WithoutBody & RawParams & { handler: AgentHandler };
type AgentParsedBodyOpts<B, P> = WithBody<B> & WithParams<P> & { handler: AgentHandler<B, P> };
type EmptyParsedAgentOpts<P> = WithoutBody & WithParams<P> & { handler: AgentHandler<undefined, P> };

export function agentRoute<E extends AgentEnv, B, P>(
  app: Hono<E>,
  ctx: Ctx,
  method: Method,
  path: string,
  o: AgentParsedBodyOpts<B, P>,
): void;
export function agentRoute<E extends AgentEnv, P>(
  app: Hono<E>,
  ctx: Ctx,
  method: Method,
  path: string,
  o: EmptyParsedAgentOpts<P>,
): void;
export function agentRoute<E extends AgentEnv, B>(
  app: Hono<E>,
  ctx: Ctx,
  method: Method,
  path: string,
  o: AgentRawBodyOpts<B>,
): void;
export function agentRoute<E extends AgentEnv>(
  app: Hono<E>,
  ctx: Ctx,
  method: Method,
  path: string,
  o: EmptyRawAgentOpts,
): void;
/** A route an agent calls. Same, plus the caller the `/orch` mount resolved. */
export function agentRoute<E extends AgentEnv, B, P>(
  app: Hono<E>,
  ctx: Ctx,
  method: Method,
  path: string,
  o: AgentParsedBodyOpts<B, P> | EmptyParsedAgentOpts<P> | AgentRawBodyOpts<B> | EmptyRawAgentOpts,
): void {
  app.on(method, path, async (c) => {
    if (o.params) {
      const params = await parse(o.params, c.req.param());
      if (!params.ok) return text(params.error, params.status);
      if (!o.body) return o.handler(ctx, c.req.raw, c.get("agent"), params.value, undefined);
      const data = await parsedBody(o.body, c.req.raw);
      return data.ok
        ? o.handler(ctx, c.req.raw, c.get("agent"), params.value, data.value)
        : text(data.error, data.status);
    }

    if (!o.body) return o.handler(ctx, c.req.raw, c.get("agent"), c.req.param(), undefined);
    const data = await parsedBody(o.body, c.req.raw);
    return data.ok
      ? o.handler(ctx, c.req.raw, c.get("agent"), c.req.param(), data.value)
      : text(data.error, data.status);
  });
}
