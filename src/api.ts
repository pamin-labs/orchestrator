import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import type { Ctx } from "./ctx.ts";
import { orchRoutes } from "./http/routes/orch.ts";
import { panelRoutes } from "./http/routes/panel.ts";
import { errText } from "./mech/util/text.ts";

export type { Caller, Ctx } from "./ctx.ts";
export { bossFact, imagePaths, withAttachments, type Attachment } from "./api/panel/attach.ts";
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

export function makeApp(ctx: Ctx): (req: Request) => Promise<Response> {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && elsewhere(site, origin, c.req.url)) {
      return c.json({ error: "cross-site writes are refused" }, 403);
    }
    if (site || origin) return sameOriginWrite(c, next);
    await next();
  });

  app.use(
    "/api/attach",
    bodyLimit({ maxSize: UPLOAD_LIMIT, onError: (c) => c.json({ error: `一次最多传 ${UPLOAD_LIMIT >> 20}MB` }, 413) }),
  );

  app.onError((error, c) =>
    error instanceof HTTPException
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: errText(error) }, 500),
  );

  app.route("/orch", orchRoutes(ctx));
  app.route("/api", panelRoutes(ctx));
  app.notFound((c) => c.json({ error: "not found" }, 404));
  return async (request) => app.fetch(request);
}
