import type { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Ctx, Caller } from "../ctx.ts";
import type { AgentHandler, Handler } from "./handler.ts";
import { text } from "./respond.ts";

/**
 * Register a route: path, schema, handler — and let TypeScript check that the
 * handler expects what the schema produces.
 *
 * The first version of this had a `Handler<any>` in it, and the `any` was doing
 * real damage: the schema said one thing, the handler destructured another, and
 * nothing anywhere would have said so. Passing both to one call is what lets the
 * inference run — `z.infer` of the schema *is* the handler's `data` parameter,
 * so changing a schema and forgetting its handler is a compile error.
 *
 * Decorators would be the other way to write this down, and they are the wrong
 * tool here: they need a metadata runtime and a container to be worth anything,
 * which is a framework rather than a route table. A function argument checked by
 * the compiler is the same statement with none of that.
 */

/** Anything with a Standard Schema — zod, valibot, arktype. */
type Schema<T> = StandardSchemaV1<unknown, T>;

/**
 * The validator, with this API's error shape.
 *
 * `sValidator` answers with a JSON envelope of issues at 400. Half these callers
 * are agents and the reply is the only thing they have to correct themselves
 * from, so it becomes the plain 422 the rest of the API speaks.
 */
const check = <T>(target: "json" | "param", schema: Schema<T>) =>
  sValidator(target as never, schema as never, (result, c) => {
    if (result.success) return;
    const issues = (result as { error: readonly StandardSchemaV1.Issue[] }).error;
    const lines = issues.map((i) => {
      const path = (i.path ?? [])
        .map((p) => (typeof p === "object" && p !== null && "key" in p ? String(p.key) : String(p)))
        .join(".");
      return path ? `${path}: ${i.message}` : i.message;
    });
    return c.text(lines.join("\n") || "invalid request", 422);
  });

type Ctxish = { req: { raw: Request; param: () => Record<string, string>; valid: (t: never) => unknown } };

const validated = (c: Ctxish): unknown => {
  try {
    return (c.req.valid as unknown as (t: string) => unknown)("json");
  } catch {
    return undefined;
  }
};

type Method = "get" | "post" | "put" | "delete";

/** A route the panel calls. */
export function route<B = undefined, P = undefined>(
  app: Hono,
  ctx: Ctx,
  method: Method,
  path: string,
  opts: { body?: Schema<B>; params?: Schema<P>; handler: Handler<B> },
): void {
  const middles = [
    ...(opts.params ? [check("param", opts.params)] : []),
    ...(opts.body ? [check("json", opts.body)] : []),
  ];
  (app as any)[method](path, ...middles, (c: Ctxish) =>
    opts.handler(ctx, c.req.raw, c.req.param(), validated(c) as B),
  );
}

/** A route an agent calls. Same, plus the caller the mount already resolved. */
export function agentRoute<B = undefined>(
  app: Hono,
  ctx: Ctx,
  method: Method,
  path: string,
  opts: { body?: Schema<B>; handler: AgentHandler<B> },
): void {
  const middles = opts.body ? [check("json", opts.body)] : [];
  (app as any)[method](path, ...middles, (c: Ctxish & { get: (k: "agent") => Caller }) =>
    opts.handler(ctx, c.req.raw, c.get("agent"), c.req.param(), validated(c) as B),
  );
}

/**
 * A body has to say it is JSON.
 *
 * Hono's validator reads the content type and treats anything else as *no input
 * at all* — so a POST that forgot the header did not fail, it arrived with every
 * field defaulted and the real body discarded. Silent, and the caller sees a
 * plausible answer to a question it did not ask.
 *
 * It also closes the hole `crossSiteWrite` describes: a cross-site POST cannot
 * set `application/json` without earning a preflight, so `text/plain` is the
 * shape that attack has to take, and this refuses it before there is a handler
 * to fool. `multipart/form-data` is exempt — uploads read `req.formData()`.
 */
export async function labelledBody(c: { req: { header: (n: string) => string | undefined; raw: Request } }, next: () => Promise<void>) {
  const type = c.req.header("content-type") ?? "";
  if (c.req.raw.body !== null && !/^application\/json\b|^multipart\/form-data\b/.test(type)) {
    return text(`this endpoint takes application/json, not ${type || "an unlabelled body"}`, 415);
  }
  await next();
}
