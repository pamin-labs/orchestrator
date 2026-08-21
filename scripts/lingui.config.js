import { formatter } from "@lingui/format-po";

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
 * `.po`, the format Lingui's own docs and tooling are built around. A translator
 * reads `msgid "Skills"` above `msgstr "Fähigkeiten"`; the JSON this replaced
 * was keyed by hash, so the same line read `"PCSkw2": "技能"` and the English it
 * translates lived in a sibling field.
 *
 * The catalogs are compiled by `scripts/lingui-catalogs.ts`, the way
 * `@lingui/vite-plugin` compiles them for Vite — so nothing here needs a
 * `lingui compile` step and no ICU parser ships to the browser.
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
  // `zh-Hant` is generated from `zh` by `scripts/i18n-hant.ts` rather than
  // translated, but it is listed here all the same: `lingui extract` is what
  // adds and retires message ids, and a catalog it does not know about goes
  // stale the first time an English string is reworded.
  locales: ["en", "zh", "zh-Hant", "ja", "ko", "es", "fr", "de", "pt", "ru"],
  catalogs: [{ path: "<rootDir>/web/src/locales/{locale}", include: ["<rootDir>/web/src"] }],
  format: formatter({ origins: false }),
};
