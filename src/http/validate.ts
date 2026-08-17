import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { failure } from "./respond.ts";

type ValidationResult = { success: true } | { success: false; error: Parameters<typeof z.prettifyError>[0] };

/** Keep the official validator's failure hook useful to both the panel and CLI. */
const reject = (result: ValidationResult, _c: Context) =>
  result.success ? undefined : failure(z.prettifyError(result.error), 400, "validation_failed");

const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9!#$&^_.%*'~-]+\+)?json$/i;

const requireJson = createMiddleware(async (c, next) => {
  const mediaType = c.req.header("content-type")?.split(";", 1)[0]?.trim();
  if (!mediaType || !JSON_MEDIA_TYPE.test(mediaType)) {
    return failure("Content-Type must be application/json", 415);
  }
  return next();
});

/**
 * Say which validator this is, so `app.routes` can be asked.
 *
 * Hono lists every middleware as its own entry in `app.routes` and keeps the
 * function's name. `zValidator` returns an anonymous closure, so without this the
 * only way to find out whether a route declares a body shape was to read the
 * route files as text and match on `jsonBody(` — a guard that a reformat could
 * disable. Named, the same question is answered from the router itself.
 */
const named = <H>(name: string, middleware: H): H =>
  Object.defineProperty(middleware, "name", { value: name, configurable: true });

/** Hono owns extraction; this tuple adds the media-type contract it documents. */
export const jsonBody = <S extends z.ZodType>(schema: S) =>
  [requireJson, named("jsonBody", zValidator("json", schema, reject))] as const;
export const formBody = <S extends z.ZodType>(schema: S) => named("formBody", zValidator("form", schema, reject));
export const pathParams = <S extends z.ZodType>(schema: S) => named("pathParams", zValidator("param", schema, reject));
export const queryParams = <S extends z.ZodType>(schema: S) =>
  named("queryParams", zValidator("query", schema, reject));
