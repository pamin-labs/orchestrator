import { readFileSync } from "node:fs";

declare const __ORCH_VERSION__: string | undefined;

/**
 * What a build with neither a stamp nor a package.json calls itself.
 *
 * Every release build defines `__ORCH_VERSION__`; a checkout has none and reads
 * package.json instead. A *bundle* run away from the checkout has neither — the
 * agent's `orch`, at `/opt/orch/cli.ts` in a sandbox, is exactly that. This threw
 * from module scope, so every `orch` verb inside a container died at import with
 * `ENOENT: /package.json`, and the agent's only interface with it.
 */
const UNKNOWN = "0.0.0+unknown";

function packageVersion(): string {
  try {
    const metadata: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      "version" in metadata &&
      typeof metadata.version === "string"
    ) {
      return metadata.version;
    }
  } catch {
    // Nothing to read is the container's normal state, not a failure worth dying
    // for: the version is a string in `--version` and a span attribute.
  }
  return UNKNOWN;
}

export const VERSION = typeof __ORCH_VERSION__ === "string" ? __ORCH_VERSION__ : packageVersion();
