import { i18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { z } from "zod";
import { type Locale, LOCALES, localeOf } from "../../src/contracts/config.ts";

/**
 * The panel's catalogs, raw. `@lingui/core` takes uncompiled ICU strings when a
 * compiler is registered, so `lingui compile` and its generated artefact never
 * exist — `build:web`, `bun test`, preflight, `browse.ts` and three workflows
 * would each have had to produce one first, and a fresh checkout that forgot
 * fails from inside a React component.
 */
/**
 * A leaf module on purpose: `@lingui/core`, the catalogs, and one contract.
 * Nothing from `ui/` or `shared/`. `test/web/module-graph.test.ts` fails on a
 * cycle between panel modules, and PR #9's third commit exists because its i18n
 * folder imported `ui/segment` while `shared/select.ts` imported i18n.
 */

const PrefSchema = z.enum(["follow", ...LOCALES]);
type Pref = z.infer<typeof PrefSchema>;

const KEY = "orch.locale";
/** What `follow` resolved to last time, so a reload does not start in the wrong
 *  language and correct itself once `/state` lands. */
const RESOLVED = "orch.locale.at";
export const LOCALE_CHANGED = "orch:locale";

/**
 * One `import()` per catalog, written out rather than built from a template: a
 * bundler splits what it can see, and a template literal it cannot resolve
 * either fails or pulls the whole directory into the entry point. Eight
 * catalogs are ~1MB of JSON against a 1.9MB bundle, and nobody reads two.
 */
const CATALOGS: Record<Exclude<Locale, "en">, () => Promise<{ default: unknown }>> = {
  zh: () => import("./locales/zh.json"),
  ja: () => import("./locales/ja.json"),
  ko: () => import("./locales/ko.json"),
  es: () => import("./locales/es.json"),
  fr: () => import("./locales/fr.json"),
  de: () => import("./locales/de.json"),
  pt: () => import("./locales/pt.json"),
  ru: () => import("./locales/ru.json"),
};

/** Only the field the runtime needs. `lingui extract` writes four more per
 *  message and is free to write a fifth. */
const CatalogSchema = z.record(z.string(), z.object({ translation: z.string().optional() }));

const read = <T>(key: string, parse: (v: string | null) => T): T => {
  try {
    return parse(localStorage.getItem(key));
  } catch {
    return parse(null);
  }
};

export const preference = (): Pref => read(KEY, (v) => PrefSchema.catch("follow").parse(v));

/**
 * Exported for the test preload, which cannot await: a preload's top-level
 * `await` does not hold back the test module under `--parallel`, so the suite
 * loads its one catalog synchronously from a static import instead.
 */
export const messages = (catalog: Record<string, { translation?: string | undefined }>): Record<string, string> => {
  const out: Record<string, string> = {};
  // An empty translation is a message nobody has done yet: leaving it out is
  // what makes the source text render instead of a blank pane.
  for (const [id, m] of Object.entries(catalog)) if (m.translation) out[id] = m.translation;
  return out;
};

i18n.setMessagesCompiler(compileMessage);
// English is the source: every id falls back to the message the macro hashed, so
// its catalog is empty by construction. Declared anyway — an unloaded locale
// warns on every render.
i18n.load("en", {});

/**
 * What to speak, given the stored preference and whatever the server last said.
 *
 * An empty `serverLanguage` is "not answered yet", not a language: on the first
 * paint of a first-ever load that leaves `zh`, which is what `output.language`
 * defaults to. Every later load reads the cached resolution instead, so the
 * flash happens once per browser rather than once per reload.
 */
export function resolve(pref: Pref, serverLanguage: string): Locale {
  if (pref !== "follow") return pref;
  if (serverLanguage) return localeOf(serverLanguage);
  return read(RESOLVED, (v) => PrefSchema.exclude(["follow"]).catch("zh").parse(v));
}

/** The last thing the server said, so changing the preference can re-resolve
 *  without waiting for the next `/state`. */
let announced = "";

/** Fetched once per locale per page. The entry point holds no catalog at all. */
async function load(locale: Locale): Promise<void> {
  if (locale === "en") return;
  const catalog = await CATALOGS[locale]();
  i18n.load(locale, messages(CatalogSchema.parse(catalog.default)));
}

/** Activate, and remember what `follow` came to. A no-op when nothing moved. */
export async function applyLocale(serverLanguage: string): Promise<void> {
  if (serverLanguage) announced = serverLanguage;
  const next = resolve(preference(), announced);
  if (preference() === "follow" && announced) {
    try {
      localStorage.setItem(RESOLVED, next);
    } catch {}
  }
  if (i18n.locale === next) return;
  await load(next);
  i18n.activate(next);
}

/** Before the first paint, with no server answer yet. */
export const startLocale = (): Promise<void> => applyLocale("");

export function setPreference(pref: Pref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
  // The pane that is open follows a change made anywhere else, without a second
  // copy of the value in React state.
  window.dispatchEvent(new CustomEvent(LOCALE_CHANGED));
  void applyLocale("");
}

export { i18n, PrefSchema, type Pref };
