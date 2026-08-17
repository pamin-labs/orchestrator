import { readFileSync } from "node:fs";

declare const __ORCH_VERSION__: string | undefined;

function packageVersion(): string {
  const metadata: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "version" in metadata &&
    typeof metadata.version === "string"
  ) {
    return metadata.version;
  }
  throw new Error("package.json must contain a string version");
}

export const VERSION = typeof __ORCH_VERSION__ === "string" ? __ORCH_VERSION__ : packageVersion();
