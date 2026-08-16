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
  const dir = new URL("../src/api", import.meta.url).pathname;
  const parts = [readFileSync(new URL("../src/api.ts", import.meta.url).pathname, "utf8")];
  for (const f of readdirSync(dir)) if (f.endsWith(".ts")) parts.push(readFileSync(join(dir, f), "utf8"));
  return parts.join("\n");
}
