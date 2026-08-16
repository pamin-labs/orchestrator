import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [readFileSync(join(dir, e.name), "utf8")] : [],
    );
  return [
    readFileSync(new URL("../src/api.ts", import.meta.url).pathname, "utf8"),
    ...walk(new URL("../src/api", import.meta.url).pathname),
    ...walk(new URL("../src/http", import.meta.url).pathname),
  ].join("\n");
}
