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
  /**
   * Absolute, from this file rather than from `process.cwd()`.
   *
   * `@lingui/conf` defaults `rootDir` to the directory holding the config, which
   * is `scripts/` — but `path` and `include` below only pick that up when they
   * are written as `<rootDir>/…`. Left relative they resolve against the cwd,
   * and `lingui extract` run from anywhere but the repository root then finds
   * **zero** messages and exits 0. With `--clean` on the script, zero found
   * means all 811 are obsolete. Measured from `scripts/`: every locale reported
   * 0/0 and the command succeeded.
   *
   * Same fix `lingui-macros.ts` already applies for `browse.ts`, which runs
   * `build:web` with the cwd set to a worktree.
   */
  rootDir: new URL("..", import.meta.url).pathname,
  sourceLocale: "en",
  // Kept in step with `LOCALES` in `src/contracts/config.ts`, which is what
  // decides whether a catalog can be reached at all; a locale here and not there
  // extracts into a file nothing loads.
  locales: ["en", "zh", "ja", "ko", "es", "fr", "de", "pt", "ru"],
  catalogs: [{ path: "<rootDir>/web/src/locales/{locale}", include: ["<rootDir>/web/src"] }],
  format: formatter({ origins: false }),
};
