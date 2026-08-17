import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../../src/mech/ctx.ts";
import { orchRoutes } from "../../src/http/routes/orch.ts";
import { panelRoutes } from "../../src/http/routes/panel.ts";

export type RouteCall = {
  method: string;
  path: string;
  body: boolean;
  params: boolean;
};

/**
 * What the router actually registered, asked of the router.
 *
 * This used to match `.post("…", jsonBody(Schema), handler)` with a regular
 * expression over the route files, which meant a reformat, a helper rename or a
 * route declared through a variable could silently switch a guard off — and the
 * guards this feeds are the ones asserting that every body-taking route declares
 * its shape.
 *
 * Hono lists every middleware in `app.routes` as its own entry against the same
 * method and path, and keeps the function's name, so the validators name
 * themselves in `src/http/validate.ts` and the declaration is read rather than
 * recognised.
 */
export function routeCalls(ctx: Ctx): RouteCall[] {
  const calls = new Map<string, RouteCall>();
  for (const { method, path, handler } of [...panelRoutes(ctx).routes, ...orchRoutes(ctx).routes]) {
    // `ALL` is Hono's entry for `use()` middleware, which is not a route.
    if (method === "ALL") continue;
    const key = `${method} ${path}`;
    const call = calls.get(key) ?? { method: method.toLowerCase(), path, body: false, params: false };
    if (handler.name === "jsonBody" || handler.name === "formBody") call.body = true;
    if (handler.name === "pathParams") call.params = true;
    calls.set(key, call);
  }
  return [...calls.values()];
}

/**
 * Every line of the route layer, as one string.
 *
 * Two guards read the source rather than the behaviour: "this config key is
 * actually consumed" and "the budget knob reaches the thing it configures".
 * Both used to read `src/api.ts` when that was the only file. It is a directory
 * now, and pointing them at whichever module happens to hold the reader today
 * would put each guard back where the next move silently disarms it — the exact
 * failure they exist to catch.
 */
export function routeSource(): string {
  // Recursive: `src/api` grew a level (orch/ and panel/) and a guard that only
  // read the top of it would have gone quietly blind — which is the failure it
  // exists to catch, one directory up.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [readFileSync(join(dir, e.name), "utf8")]
          : [],
    );
  return [
    readFileSync(new URL("../../src/composition/api.ts", import.meta.url).pathname, "utf8"),
    ...walk(new URL("../../src/api", import.meta.url).pathname),
    ...walk(new URL("../../src/http", import.meta.url).pathname),
  ].join("\n");
}
