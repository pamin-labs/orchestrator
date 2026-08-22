import { linguiCatalogs } from "./lingui-catalogs.ts";
import { linguiMacros } from "./lingui-macros.ts";

/**
 * The panel bundle. Same entry the `bun build` line carried, plus `splitting`
 * — which the CLI does have as `--splitting` — and a plugin, which it does not.
 *
 * The panel's copy is behind a Lingui macro now, and a macro that reaches the
 * bundler unexpanded is a `throw` at module scope in the browser.
 */
/**
 * Exported so the two tests that boot the artefact build the same one. They had
 * their own argument lists, which is how they came to be testing a bundle
 * `build:web` does not produce: no `define`, so React's dev runtime and Lingui's
 * dev-only compiler, neither of which a browser is served.
 */
export const WEB_BUILD = {
  entrypoints: ["web/src/app/main.tsx"],
  target: "browser",
  minify: true,
  // Each catalog is its own chunk, fetched when a locale is first activated:
  // ten of them, ~90KB each compiled, and nobody reads two. English is one of
  // the ten — ADR 041 has why it stopped being the exception.
  splitting: true,
  /**
   * Bun inlines `process.env.NODE_ENV` as `"development"` unless told otherwise
   * — measured, both the CLI and the API — so the panel shipped React's dev
   * runtime: 1,781,240 B against 1,471,887 B, 17.4%.
   */
  /**
   * It also shipped Lingui's dev-only default, an ICU compiler the `I18n`
   * constructor installs when `NODE_ENV !== "production"`. Two comments here
   * claimed the parser was out of the browser and that `setMessagesCompiler`
   * was already in `web/src/i18n.ts`; neither was true, and the panel worked
   * because of that default. `i18n.ts` sets it explicitly now, so a message
   * with no catalogue row still renders its plural rather than raw ICU.
   */
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [linguiMacros, linguiCatalogs],
} satisfies Bun.BuildConfig;

if (import.meta.main) {
  const started = Bun.nanoseconds();
  const built = await Bun.build({ ...WEB_BUILD, outdir: "web/dist" });

  // `throw` defaults to true, so a failure never reaches here — and its message
  // carries "error", which is what `src/mech/util/detect.ts` greps for.
  const entry = built.outputs.find((o) => o.kind === "entry-point");
  const bytes = entry ? (await entry.arrayBuffer()).byteLength : 0;
  const chunks = built.outputs.filter((o) => o.kind === "chunk").length;
  const mb = (bytes / 1e6).toFixed(2);
  console.log(`web/dist/main.js  ${mb} MB + ${chunks} chunks  ${((Bun.nanoseconds() - started) / 1e6).toFixed(0)}ms`);
}
