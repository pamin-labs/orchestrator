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

/** Hono owns extraction; this tuple adds the media-type contract it documents. */
export const jsonBody = <S extends z.ZodType>(schema: S) => [requireJson, zValidator("json", schema, reject)] as const;
export const formBody = <S extends z.ZodType>(schema: S) => zValidator("form", schema, reject);
export const pathParams = <S extends z.ZodType>(schema: S) => zValidator("param", schema, reject);
export const queryParams = <S extends z.ZodType>(schema: S) => zValidator("query", schema, reject);
