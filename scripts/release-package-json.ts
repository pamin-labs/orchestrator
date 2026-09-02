/**
 * The `package.json` that goes into a release archive.
 *
 * The archive is a compiled binary plus a built panel: no `scripts/`, no
 * `web/src`, no `node_modules`. Shipping the development manifest unchanged put
 * thirty-nine scripts in front of whoever unpacked it, of which seven could run,
 * and the first one anybody tries is `start`.
 */
/**
 * Measured on `orch-server-0.1.7-darwin-arm64`: `bun run start` fails with
 * `Module not found "scripts/build-web.ts"` — a file that was never in the
 * archive, naming a build step the archive exists to have already done. The
 * panel is at `web/dist`, the server is the binary beside it, and the error
 * points at neither.
 */
/**
 * The dependency lists go too. Both bundles are `--target bun` single files with
 * no external imports, so the 104 entries describe nothing in the archive and a
 * helpful `bun install` downloads all of them to be ignored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

/** Scripts an unpacked archive can actually run, and what each one needs to be
 *  there. Kept as data so the release job can check the files exist rather than
 *  trusting this list. */
export const KEPT = [
  ["orch", "src/orch/cli.ts"],
  ["db:up", "docker/postgres-compose.yml"],
  ["db:down", "docker/postgres-compose.yml"],
  ["db:test:up", "docker/postgres-test-compose.yml"],
  ["db:test:down", "docker/postgres-test-compose.yml"],
  ["trace:up", "docker/otel-compose.yml"],
  ["trace:down", "docker/otel-compose.yml"],
] as const;

/** `looseObject`, because every key but `scripts` is carried through untouched
 *  and this file has no business knowing what they are. */
export const DevManifestSchema = z.looseObject({
  // Named rather than left to the catchall: the release job checks the archive's
  // `version` against the tag, so an archive without one is a release that
  // cannot be verified.
  name: z.string(),
  version: z.string(),
  scripts: z.record(z.string(), z.string()).optional(),
});
export type DevManifest = z.infer<typeof DevManifestSchema>;

/**
 * `start` is the binary, and it is the whole point of the rewrite: it is the
 * name every ecosystem trains people to type, so it has to reach the thing the
 * archive was built to run rather than the build that produced it.
 */
export function releasePackageJson(dev: DevManifest, exe: string) {
  const from = dev.scripts ?? {};
  const scripts: Record<string, string> = { start: `./${exe}` };
  for (const [name] of KEPT) {
    const line = from[name];
    // Silently dropping one would ship an archive quietly missing `db:up`. A
    // renamed script is a release that stops, not a release that is thinner.
    if (!line) throw new Error(`release manifest: development package.json has no "${name}" script`);
    scripts[name] = line;
  }
  const { scripts: _s, dependencies: _d, devDependencies: _v, ...rest } = dev;
  return { ...rest, scripts };
}

if (import.meta.main) {
  const [path, exe] = process.argv.slice(2);
  if (!path || !exe) throw new Error("usage: release-package-json.ts <path/to/package.json> <exe-name>");
  const dev = DevManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(path, `${JSON.stringify(releasePackageJson(dev, exe), null, 2)}\n`);
}
