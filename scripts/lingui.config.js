import { formatter } from "@lingui/format-json";

/**
 * The panel's messages, keyed by their English source.
 *
 * `.js` rather than `.ts` on purpose: `@lingui/conf` loads a TypeScript config
 * through jiti, and this file is read once per process by the macro plugin —
 * `scripts/build-web.ts` and every `bun test` worker that touches `web/src`.
 */
/**
 * Read by `@lingui/conf` from a path — `lingui extract` resolves it from
 * `--config`, `lingui-macros.ts` hands the same path to `getConfig` — so no
 * import graph reaches it and Fallow is told about its formatter separately.
 */
/**
 * JSON rather than `.po`, so Bun imports the catalogs natively — a `.po` needs
 * a loader plugin in both the bundler and the test preload to compile it.
 *
 * The default `lingui` style keeps the English `message` beside each hashed id,
 * which is the only thing that makes a catalog of hashes reviewable: `minimal`
 * would leave a translator a file of `"PCSkw2": "技能"`.
 */
export default {
  sourceLocale: "en",
  locales: ["en", "zh"],
  catalogs: [{ path: "web/src/locales/{locale}", include: ["web/src"] }],
  format: formatter({ origins: false }),
};
