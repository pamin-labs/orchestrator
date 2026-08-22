import { linguiCatalogs } from "./lingui-catalogs.ts";
import { linguiMacros } from "./lingui-macros.ts";

/**
 * The server binary and the agent CLI bundle, built the way `build-web.ts`
 * builds the panel: `Bun.build` with the two Lingui plugins.
 *
 * `bun build` the CLI has no `--plugin`, and that one missing flag is what
 * ADR 041 read as "a macro cannot reach the server". The API takes plugins, so
 * the server writes `msg` the same way the panel does — and a release compiled
 * without them is a binary that throws at module scope on its first message.
 */
/**
 * `--target=bun-linux-x64-baseline` is two settings the API keeps apart: what
 * the bundle is for (`target: "bun"`) and which platform's runtime is stapled
 * to it (`compile.target`). Passing the second as the first is a type error
 * here rather than a binary that runs nowhere.
 */

/**
 * The five `release.yml` builds, written out so the argument types itself.
 *
 * `Bun.Build.CompileTarget` is a template-literal union, so a `string` from
 * `argv` needed a cast and a lint suppression to reach it. A lookup in a tuple
 * narrows instead, and a target the workflow adds without adding it here is a
 * usage error at the first build rather than a binary for the wrong platform.
 * `test/governance/workflows.test.ts` holds the other half: that this list and
 * the workflow's loop are the same five.
 */
export const TARGETS = [
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64-baseline",
] as const satisfies readonly Bun.Build.CompileTarget[];

/** Guarded like `build-web.ts`, because `TARGETS` is imported: a module that
 *  builds a binary on import is not one a test can read a constant out of. */
if (import.meta.main) {
  const [entrypoint, outfile, wanted] = process.argv.slice(2);
  if (!entrypoint || !outfile) throw new Error("usage: build-server.ts <entrypoint> <outfile> [bun-<os>-<arch>]");
  const compileTarget = TARGETS.find((t) => t === wanted);
  if (wanted && !compileTarget) throw new Error(`unknown target ${wanted}; one of: ${TARGETS.join(" | ")}`);

  const version = process.env.RELEASE_VERSION;
  const started = Bun.nanoseconds();
  const built = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    minify: true,
    ...(version ? { define: { __ORCH_VERSION__: JSON.stringify(version) } } : {}),
    ...(compileTarget ? { compile: { target: compileTarget, outfile } } : {}),
    plugins: [linguiMacros, linguiCatalogs],
  });

  // `outfile` is a **compile-only** option — it lives on `CompileBuildOptions`
  // (`bun-types/bun.d.ts:3026`) and not on `BuildConfig`. Passing it to an
  // ordinary bundle does not warn: the build succeeds, writes nothing, and the
  // next line fails with `ENOENT: stat`. So the bundle comes back in memory and is
  // written here, which is also how `sandbox.ts` gets the agent's CLI.
  const [output] = built.outputs;
  if (!compileTarget) {
    if (!output) throw new Error(`no bundle for ${entrypoint}`);
    await Bun.write(outfile, output);
  }
  const bytes = (await Bun.file(outfile).stat()).size;
  const ms = ((Bun.nanoseconds() - started) / 1e6).toFixed(0);
  console.log(`${outfile}  ${(bytes / 1e6).toFixed(1)} MB  ${compileTarget ?? "bundle"}  ${ms}ms`);
}
