import { linguiCatalogs } from "./lingui-catalogs.ts";
import { linguiMacros } from "./lingui-macros.ts";

/**
 * The panel bundle. Same entry the `bun build` line carried, plus `splitting`
 * — which the CLI does have as `--splitting` — and a plugin, which it does not.
 *
 * The panel's copy is behind a Lingui macro now, and a macro that reaches the
 * bundler unexpanded is a `throw` at module scope in the browser.
 */

const started = Bun.nanoseconds();
const built = await Bun.build({
  entrypoints: ["web/src/app/main.tsx"],
  outdir: "web/dist",
  target: "browser",
  minify: true,
  // Each catalog is its own chunk, fetched when a locale is first activated:
  // eight of them, ~52KB each compiled, and nobody reads two. English has no
  // catalog at all, so it fetches none.
  splitting: true,
  plugins: [linguiMacros, linguiCatalogs],
});

// `throw` defaults to true, so a failure never reaches here — and its message
// carries "error", which is what `src/mech/util/detect.ts` greps for.
const entry = built.outputs.find((o) => o.kind === "entry-point");
const bytes = entry ? (await entry.arrayBuffer()).byteLength : 0;
const chunks = built.outputs.filter((o) => o.kind === "chunk").length;
const mb = (bytes / 1e6).toFixed(2);
console.log(`web/dist/main.js  ${mb} MB + ${chunks} chunks  ${((Bun.nanoseconds() - started) / 1e6).toFixed(0)}ms`);
