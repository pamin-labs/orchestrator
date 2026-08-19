import { Hono, type Context, type MiddlewareHandler, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes } from "hono/route";
import type { Ctx } from "../mech/ctx.ts";
import { orchRoutes } from "../http/routes/orch.ts";
import { panelRoutes } from "../http/routes/panel.ts";
import { consola } from "consola";
import { failure } from "../http/respond.ts";
import { requestContext, requestId } from "../platform/observability/request-context.ts";
import { scrub } from "../platform/observability/redaction.ts";
import { errText } from "../platform/process/text.ts";
import { idempotency, JSON_BODY_LIMIT } from "../http/idempotency/store.ts";
import {
  observeHttp,
  prometheus,
  runtimeStatus,
  type RuntimeStatus,
  type SpanScope,
} from "../platform/observability/metrics.ts";
import { startTrace, traceparent } from "../platform/observability/traces.ts";

export type { ApiType } from "../http/routes/panel.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Treat every loopback spelling as the same host while keeping the port boundary. */
const sameOriginWrite: MiddlewareHandler<Record<never, never>> = csrf({
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

const jsonBodyLimit: MiddlewareHandler<Record<never, never>> = bodyLimit({
  maxSize: JSON_BODY_LIMIT,
  onError: () => failure("request body is too large", 413),
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

/**
 * The scope a request names in its own path, and nothing beyond it.
 *
 * Read off the matched route rather than the raw path, so `/api/v1/groups/7/pause`
 * is scoped by the `7` Hono already parsed and an unmatched path is scoped by
 * nothing. No database lookup: a slice route knows its slice and not its group,
 * and resolving one here would put a query on every request to fill a column
 * that is allowed to be NULL.
 */
function routeScope(route: string, params: Record<string, string>): SpanScope {
  const id = Number(params["id"]);
  if (!Number.isInteger(id) || id <= 0) return {};
  if (route.startsWith("/api/v1/groups/")) return { grpId: id };
  if (route.startsWith("/api/v1/slices/")) return { sliceId: id };
  if (route.startsWith("/api/v1/project")) return { projectId: id };
  return {};
}

export function makeApp(ctx: Ctx, runtime: RuntimeStatus = runtimeStatus()): (req: Request) => Promise<Response> {
  const app = new Hono();

  app.use("*", async (c: Context<Record<never, never>, "*">, next: Next) => {
    const id = requestId(c.req.header("x-request-id"));
    const path = new URL(c.req.url).pathname;
    const trace = startTrace(c.req.header("traceparent"));
    return requestContext.run(
      {
        requestId: id,
        traceId: trace.traceId,
        spanId: trace.spanId,
        traceFlags: trace.span.spanContext().traceFlags,
        method: c.req.method,
        path,
        signal: c.req.raw.signal,
      },
      async () => {
        await next();
        c.header("X-Request-ID", id);
        c.header("traceparent", traceparent(trace));
        const route = matchedRoutes(c).findLast(({ path: matched }) => !matched.includes("*"))?.path ?? "unmatched";
        observeHttp(c.req.method, route, c.res.status, trace, routeScope(route, c.req.param()));
      },
    );
  });

  app.get("/healthz", (c) => c.json({ status: "ok", uptime_ms: Date.now() - runtime.startedAt }));
  app.get("/readyz", (c) => {
    const ready = runtime.accepting && runtime.ready && runtime.checks.every((check) => check.ok);
    return c.json({ status: ready ? "ready" : "not_ready", checks: runtime.checks }, ready ? 200 : 503);
  });
  app.get("/metrics", async (c) =>
    c.text(await prometheus(ctx.db), 200, { "content-type": "text/plain; version=0.0.4" }),
  );

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
  app.use("/api/v1/*", async (c: Context<Record<never, never>, "/api/v1/*">, next: Next) => {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && elsewhere(site, origin, c.req.url)) {
      return failure("cross-site writes are refused", 403);
    }
    if (site || origin) return sameOriginWrite(c, next);
    await next();
  });

  app.use("/api/v1/*", async (c: Context<Record<never, never>, "/api/v1/*">, next: Next) => {
    if (c.req.path === "/api/v1/attach") return next();
    return jsonBodyLimit(c, next);
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
