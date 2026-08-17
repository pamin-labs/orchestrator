import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";
import type { Ctx } from "./ctx.ts";
import { orchRoutes } from "./http/routes/orch.ts";
import { panelRoutes } from "./http/routes/panel.ts";
import { consola } from "consola";
import { failure } from "./http/respond.ts";
import { errText } from "./mech/util/text.ts";
import { scrub } from "./mech/util/scrub.ts";
import { requestContext, requestId } from "./http/request-context.ts";
import { idempotency, JSON_BODY_LIMIT } from "./http/idempotency.ts";
import {
  observeHttp,
  prometheus,
  runtimeStatus,
  startTrace,
  traceparent,
  type RuntimeStatus,
} from "./observability.ts";

export type { Ctx } from "./ctx.ts";
export { bossFact, imagePaths, withAttachments } from "./api/panel/attach.ts";
export { askKind, brief } from "./api/orch/escalation.ts";
export { landGroup } from "./api/panel/group.ts";
export { evictOldestLessons, LESSON_CAP } from "./mech/knowledge/lessons.ts";
export type { ApiType } from "./http/routes/panel.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Treat every loopback spelling as the same host while keeping the port boundary. */
const sameOriginWrite = csrf({
  secFetchSite: ["same-origin", "none"],
  origin: (origin, c) => {
    try {
      const candidate = new URL(origin);
      return LOOPBACK.has(candidate.hostname) && candidate.port === new URL(c.req.url).port;
    } catch {
      return false;
    }
  },
});

/** Total request limit; the per-file limit runs only after multipart parsing. */
export const UPLOAD_LIMIT = 256 * 1024 * 1024;

/**
 * Reject browser writes whose own headers say another site initiated them.
 * Headerless CLI and mailbox requests remain valid non-browser callers.
 */
function elsewhere(site: string | undefined, origin: string | undefined, url: string): boolean {
  if (site) return site !== "same-origin" && site !== "none";
  if (!origin) return false;
  try {
    const candidate = new URL(origin);
    return !LOOPBACK.has(candidate.hostname) || candidate.port !== new URL(url).port;
  } catch {
    return true;
  }
}

export function makeApp(ctx: Ctx, runtime: RuntimeStatus = runtimeStatus()): (req: Request) => Promise<Response> {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const id = requestId(c.req.header("x-request-id"));
    const path = new URL(c.req.url).pathname;
    const trace = startTrace(c.req.header("traceparent"));
    return requestContext.run(
      {
        requestId: id,
        traceId: trace.traceId,
        spanId: trace.spanId,
        method: c.req.method,
        path,
        signal: c.req.raw.signal,
      },
      async () => {
        await next();
        c.header("X-Request-ID", id);
        c.header("traceparent", traceparent(trace));
        const route = matchedRoutes(c).findLast(({ path: matched }) => !matched.includes("*"))?.path ?? "unmatched";
        observeHttp(c.req.method, route, c.res.status, trace);
      },
    );
  });

  app.get("/healthz", (c) => c.json({ status: "ok", uptime_ms: Date.now() - runtime.startedAt }));
  app.get("/readyz", (c) => {
    const ready = runtime.accepting && runtime.ready && runtime.checks.every((check) => check.ok);
    return c.json({ status: ready ? "ready" : "not_ready", checks: runtime.checks }, ready ? 200 : 503);
  });
  app.get("/metrics", (c) => c.text(prometheus(ctx.db), 200, { "content-type": "text/plain; version=0.0.4" }));

  app.use("*", async (c, next) => {
    if (
      !runtime.accepting &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      (c.req.path.startsWith("/api/v1/") || c.req.path.startsWith("/orch/v1/"))
    ) {
      return failure("server is shutting down", 503, "shutting_down");
    }
    return next();
  });
  app.use("/api/v1/*", async (c, next) => {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && elsewhere(site, origin, c.req.url)) {
      return failure("cross-site writes are refused", 403);
    }
    if (site || origin) return sameOriginWrite(c, next);
    await next();
  });

  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/attach") return next();
    return bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: () => failure("request body is too large", 413) })(c, next);
  });
  app.use(
    "/api/v1/attach",
    bodyLimit({ maxSize: UPLOAD_LIMIT, onError: () => failure(`一次最多传 ${UPLOAD_LIMIT >> 20}MB`, 413) }),
  );
  app.use("/api/v1/*", idempotency(ctx.db));

  app.onError((error, c) => {
    // A disconnected caller owns this cancellation. Turning its exact abort
    // reason into a synthetic 500 both hides cancellation from tests/callers and
    // lets framework error handling keep work alive after nobody can receive it.
    if (c.req.raw.signal.aborted && error === c.req.raw.signal.reason) throw error;
    if (error instanceof HTTPException) return failure(error.message, error.status);
    const id = requestContext.getStore()?.requestId ?? "unknown";
    consola.error(`request ${id} failed: ${scrub(errText(error))}`);
    return failure("internal server error", 500);
  });

  app.route("/orch/v1", orchRoutes(ctx));
  app.route("/api/v1", panelRoutes(ctx));
  app.notFound(() => failure("not found", 404));
  return async (request) => app.fetch(request);
}
