import { linguiMacros } from "./lingui-macros.ts";

/**
 * The panel bundle. Same entry and same flags the `bun build` line carried,
 * plus the one thing the CLI has no way to accept: a plugin.
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
  // Each catalog is its own chunk, fetched when a locale is first activated.
  // Nine of them are ~1MB of JSON against a 1.9MB bundle, and nobody reads two.
  splitting: true,
  plugins: [linguiMacros],
});

// `throw` defaults to true, so a failure never reaches here — and its message
// carries "error", which is what `src/mech/util/detect.ts` greps for.
const entry = built.outputs.find((o) => o.kind === "entry-point");
const bytes = entry ? (await entry.arrayBuffer()).byteLength : 0;
const chunks = built.outputs.filter((o) => o.kind === "chunk").length;
const mb = (bytes / 1e6).toFixed(2);
console.log(`web/dist/main.js  ${mb} MB + ${chunks} chunks  ${((Bun.nanoseconds() - started) / 1e6).toFixed(0)}ms`);
