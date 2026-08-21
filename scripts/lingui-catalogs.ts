import { createRequire } from "node:module";
import { relative } from "node:path";
import type { BunPlugin } from "bun";

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
 * of the tree — every one of `build:web`, `bun test`, `preflight`, `browse.ts`
 * and three workflows would have had to run it first — *and* keeps the ICU
 * parser out of the browser, which is what the docs mean by "catalogs should
 * always be compiled".
 */

const load = createRequire(import.meta.url) as <T>(id: string) => T;
const CONFIG = new URL("./lingui.config.js", import.meta.url).pathname;

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
