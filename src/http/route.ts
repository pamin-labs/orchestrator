import type { Hono } from "hono";
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
 * thing and the handler destructure another with nothing to stop it. Here
 * `z.infer` of the schema *is* the handler's `data` parameter: change a schema,
 * forget its handler, get a compile error.
 *
 * Decorators are the other way to write this down and they are the wrong tool —
 * stage 3 has no parameter decorators, which is exactly what a decorator-driven
 * router needs, and the ones that work need a metadata runtime and a container.
 * That is a framework. This is a function argument.
 */

/** Anything implementing Standard Schema: zod, valibot, arktype. */
type Schema<T> = StandardSchemaV1<unknown, T>;

/**
 * The app being mounted on, with its env left open.
 *
 * `/orch` declares an `agent` variable and `/api` declares nothing, and Hono's
 * method signatures are generic enough over that env that the two do not unify
 * structurally. This is the one `any` in the file and it is the framework seam,
 * not the thing that mattered: the `any` this design exists to remove was on the
 * *handler's data*, where it let a schema and a handler disagree in silence.
 * Here the compiler still checks every argument that carries meaning.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mount = Hono<any>;

/**
 * `@hono/standard-validator` used to do this and was dropped.
 *
 * Not for weight — it is tiny. Its value is that `c.req.valid("json")` comes
 * back typed, and `route()` hands the value straight to a handler that already
 * declares its own shape, so that typing was thrown away and read back through
 * two casts and a try/catch. What remained was "call the schema" and "pick a
 * status code", and the status code was ours to begin with.
 */
async function parse<T>(schema: Schema<T>, value: unknown): Promise<T | string> {
  const r = await schema["~standard"].validate(value);
  if (!r.issues) return r.value;
  return (
    r.issues
      .map((i) => {
        const path = (i.path ?? [])
          .map((p) => (typeof p === "object" && p !== null && "key" in p ? String(p.key) : String(p)))
          .join(".");
        return path ? `${path}: ${i.message}` : i.message;
      })
      .join("\n") || "invalid request"
  );
}

/** A missing body is `{}`, so a schema made of defaults still runs on an empty POST. */
const body = async (req: Request): Promise<unknown> => {
  if (req.body === null) return {};
  return req.json().catch(() => ({}));
};

type C = { req: { raw: Request; param: () => Record<string, string> }; get: (k: "agent") => Caller };
type Method = "get" | "post" | "put" | "delete";
interface Opts<B, P> {
  body?: Schema<B>;
  params?: Schema<P>;
}

/** Validate what the route declared, or answer with why it could not. */
async function checked<B, P>(c: C, o: Opts<B, P>): Promise<{ data: B } | Response> {
  if (o.params) {
    const p = await parse(o.params, c.req.param());
    if (typeof p === "string") return text(p, 422);
  }
  if (!o.body) return { data: undefined as B };
  const b = await parse(o.body, await body(c.req.raw));
  return typeof b === "string" ? text(b, 422) : { data: b };
}

/** A route the panel calls. */
export function route<B = undefined, P = undefined>(
  app: Mount,
  ctx: Ctx,
  method: Method,
  path: string,
  o: Opts<B, P> & { handler: Handler<B> },
): void {
  (app as never as Record<Method, (p: string, h: (c: C) => Promise<Response>) => void>)[method](path, async (c) => {
    const v = await checked(c, o);
    return v instanceof Response ? v : o.handler(ctx, c.req.raw, c.req.param(), v.data);
  });
}

/** A route an agent calls. Same, plus the caller the `/orch` mount resolved. */
export function agentRoute<B = undefined>(
  app: Mount,
  ctx: Ctx,
  method: Method,
  path: string,
  o: Opts<B, undefined> & { handler: AgentHandler<B> },
): void {
  (app as never as Record<Method, (p: string, h: (c: C) => Promise<Response>) => void>)[method](path, async (c) => {
    const v = await checked(c, o);
    return v instanceof Response ? v : o.handler(ctx, c.req.raw, c.get("agent"), c.req.param(), v.data);
  });
}

/**
 * A body has to say it is JSON.
 *
 * Hono's own validator read the content type and treated anything else as *no
 * input at all* — a POST that forgot the header arrived with every field
 * defaulted and the real body discarded. That is gone with the validator, but
 * the rule stays, because it is also what closes the hole `crossSiteWrite`
 * describes: a cross-site POST cannot set `application/json` without earning a
 * preflight, so `text/plain` is the shape that attack has to take, and this
 * refuses it before there is a handler to fool.
 *
 * `multipart/form-data` is exempt — uploads read `req.formData()` themselves.
 */
export async function labelledBody(
  c: { req: { header: (n: string) => string | undefined; raw: Request } },
  next: () => Promise<void>,
) {
  const type = c.req.header("content-type") ?? "";
  if (c.req.raw.body !== null && !/^application\/json\b|^multipart\/form-data\b/.test(type)) {
    return text(`this endpoint takes application/json, not ${type || "an unlabelled body"}`, 415);
  }
  await next();
}
