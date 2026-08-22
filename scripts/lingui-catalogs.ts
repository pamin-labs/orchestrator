import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import type { BunPlugin } from "bun";
import type { CatalogFormatter } from "@lingui/conf";

/**
 * `.po` catalogs, compiled at build time, for `Bun.build` and the test loader.
 *
 * This is what `@lingui/vite-plugin` does for Vite, through the same four public
 * calls from `@lingui/cli/api`: find the catalog a file belongs to, read its
 * translations, compile them, hand back an ES module. Lingui ships that plugin
 * for Vite, a loader for webpack and a transformer for Metro; there is none for
 * Bun, which is the only reason this file exists rather than a dependency.
 */
/**
 * Compiling here is what keeps `lingui compile` and its generated artefact out
 * of the tree: every one of `build:web`, `bun test`, `preflight`, `browse.ts`
 * and three workflows would have had to run it first.
 */
/**
 * It does not keep the ICU parser out of the browser, which an earlier version
 * of this comment claimed. `web/src/i18n.ts` installs one deliberately, so a
 * message with no catalogue row still renders its plural — under
 * `NODE_ENV=production` Lingui installs none, and the fallback comes out as the
 * literal `{n, plural, …}`. What compiling here buys is that no catalogue *row*
 * is parsed at runtime, which is every string on the screen but the fallbacks.
 */

const load = createRequire(import.meta.url) as <T>(id: string) => T;
/** Absolute, so `getConfig` does not search upward from a cwd `browse.ts` moved.
 *  Exported because `lingui-macros.ts` resolves the same file. */
export const CONFIG = join(import.meta.dirname, "lingui.config.js");

/**
 * The checkout root, with its trailing separator, for the three callers that
 * need an absolute path into this tree: the macro plugin's cache directory and
 * its `OURS` pattern, and `lingui.config.js`'s `rootDir`.
 */
/**
 * One definition where there were two, both spelled
 * `new URL("..", import.meta.url).pathname` — and a pathname is percent-encoded,
 * so a checkout under `~/My Projects` gave `/Users/…/My%20Projects/`: a cache
 * directory with a literal `%20` in it and an `OURS` that matches no file, which
 * per the note on `OURS` is every macro left unexpanded rather than a build
 * error. `import.meta.dirname` is already decoded and needs no `node:url`, which
 * matters for the caller that is a `.js` file outside the TypeScript program.
 */
export const ROOT = join(import.meta.dirname, "..") + sep;

type Api = typeof import("@lingui/cli/api");
type Catalogs = Awaited<ReturnType<Api["getCatalogs"]>>;

/**
 * What a caller of `translations` gets, narrowed on purpose.
 *
 * Lingui's own return type carries more, and naming it here would make every
 * reader of the README's progress table depend on the shape of a CLI internal.
 * These two fields are the whole contract: what is translated, and — by id —
 * what is not.
 */
export type Translations = { messages: Record<string, string>; missing: { id: string }[] };

/** Resolved once. `getCatalogs` walks the filesystem, and it is the same answer
 *  for every catalog in a build. */
let catalogs: Promise<Catalogs> | undefined;

/** The three things every call here needs, resolved together. */
function lingui(): { api: Api; config: ReturnType<typeof import("@lingui/conf").getConfig> } {
  const { getConfig } = load<typeof import("@lingui/conf")>("@lingui/conf");
  return { api: load<Api>("@lingui/cli/api"), config: getConfig({ configPath: CONFIG }) };
}

/**
 * What one locale's catalog holds, read the way `lingui extract` reads it.
 *
 * Exported because `i18n-progress.ts` and `i18n-validate.ts` need the same
 * answer and must not get it by parsing `.po` themselves — a second reader of a
 * format Lingui owns is a second thing to keep in step with it.
 */
export async function translations(locale: string): Promise<Translations> {
  const { api, config } = lingui();
  const catalog = (await (catalogs ??= api.getCatalogs(config)))[0];
  if (!catalog) throw new Error(`lingui: no catalog configured in ${CONFIG}`);
  return catalog.getTranslations(locale, {
    fallbackLocales: config.fallbackLocales,
    sourceLocale: config.sourceLocale,
  });
}

/**
 * The formatter `lingui.config.js` declares, and the locale it calls the source.
 *
 * `i18n-hant.ts` reads and writes a `.po` with it rather than parsing one:
 * a second `formatter({ … })` beside the config would be a second answer to how
 * this project's catalogues are written.
 */
export function catalogFormat(): { format: CatalogFormatter; sourceLocale: string } {
  const { config } = lingui();
  if (!config.format) throw new Error(`lingui: no catalog formatter in ${CONFIG}`);
  return { format: config.format, sourceLocale: config.sourceLocale };
}

async function compile(path: string): Promise<string> {
  const { api, config } = lingui();
  // `relative`, not a slice: `rootDir` is absolute and carries a trailing
  // separator, and getting that off by one silently matches no catalog.
  const within = relative(config.rootDir, path);
  const found = api.getCatalogForFile(within, await (catalogs ??= api.getCatalogs(config)));
  if (!found) throw new Error(`lingui: ${within} matches no catalog in ${CONFIG}`);

  const { locale, catalog } = found;
  const { messages, missing } = await catalog.getTranslations(locale, {
    fallbackLocales: config.fallbackLocales,
    sourceLocale: config.sourceLocale,
  });
  // Missing is not fatal: the README's table exists to report it, and an
  // untranslated message renders the English the macro hashed.
  if (missing.length > 0) console.warn(`lingui: ${locale} is missing ${missing.length} translations`);

  const { source, errors } = api.createCompiledCatalog(locale, messages, { namespace: "es" });
  // Compilation errors *are* fatal. A message that will not compile renders as
  // nothing at all, and it fails inside a React render where no boundary above
  // it can say which string it was.
  if (errors.length > 0) throw new Error(api.createCompilationErrorMessage(locale, errors));
  return source;
}

export const linguiCatalogs: BunPlugin = {
  name: "lingui-catalogs",
  setup(build) {
    // `[a-zA-Z-]`, not `[a-z-]`: a BCP-47 script subtag is title case, so
    // `zh-Hant.po` did not match — and the failure mode is not a build error but
    // a catalog that is never compiled, which reads as "that locale renders in
    // English" three layers away from here.
    build.onLoad({ filter: /[\\/]locales[\\/][a-zA-Z-]+\.po$/, namespace: "file" }, async ({ path }) => ({
      contents: await compile(path),
      loader: "js",
    }));
  },
};
