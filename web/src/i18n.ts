import { i18n, type Messages } from "@lingui/core";
import { detect, fromNavigator, fromStorage } from "@lingui/detect-locale";
import { z } from "zod";
import { type Locale, LOCALES, localeOf } from "../../src/contracts/config.ts";

/**
 * The panel's catalogs, compiled.
 *
 * `scripts/lingui-catalogs.ts` turns each `.po` into an ES module exporting
 * `messages`, which is what `@lingui/vite-plugin` does for Vite. So this is the
 * documented shape — `const { messages } = await import(…)`, then `load`, then
 * `activate` — and no ICU parser reaches the browser.
 */
/**
 * A leaf module on purpose: `@lingui/core`, the catalogs, and one contract.
 * Nothing from `ui/` or `shared/`. `test/web/module-graph.test.ts` fails on a
 * cycle between panel modules, and PR #9's third commit exists because its i18n
 * folder imported `ui/segment` while `shared/select.ts` imported i18n.
 */

const PrefSchema = z.enum(LOCALES);

const KEY = "orch.locale";

/**
 * One `import()` per catalog, written out rather than built from a template: a
 * bundler splits what it can see, and a template literal it cannot resolve
 * either fails or pulls the whole directory into the entry point. Each is its
 * own chunk of about 52KB, and nobody reads two.
 */
const CATALOGS: Record<Exclude<Locale, "en">, () => Promise<{ messages: Messages }>> = {
  zh: () => import("../../locales/zh.po"),
  "zh-Hant": () => import("../../locales/zh-Hant.po"),
  ja: () => import("../../locales/ja.po"),
  ko: () => import("../../locales/ko.po"),
  es: () => import("../../locales/es.po"),
  fr: () => import("../../locales/fr.po"),
  de: () => import("../../locales/de.po"),
  pt: () => import("../../locales/pt.po"),
  ru: () => import("../../locales/ru.po"),
};

/**
 * Which language this browser reads, and nothing else decides it.
 *
 * It followed `output.language` at first, which conflated two things: that knob
 * tells the agents what to write and lives in the cache prefix, so changing it
 * rotates every session in the fleet. Reading a pane in another language is not
 * that, and must not cost that.
 */
/**
 * `detect` is Lingui's own, and it owns the fiddly half: reading storage without
 * throwing where storage is denied, then falling through to the navigator. What
 * it hands back is a raw string, so `localeOf` still decides which catalog can
 * serve it — the stored value is one of nine, `navigator.language` is whatever
 * the browser says.
 */
export const preference = (): Locale =>
  PrefSchema.catch(localeOf(detect(fromNavigator()) ?? "en")).parse(detect(fromStorage(KEY)) ?? "");

// English is the source: every id falls back to the message the macro hashed, so
// its catalog is empty by construction. Declared anyway — an unloaded locale
// warns on every render.
i18n.load("en", {});

/** Fetched once per locale per page. The entry point holds no catalog at all. */
async function load(locale: Locale): Promise<void> {
  if (locale === "en") return;
  const { messages } = await CATALOGS[locale]();
  i18n.load(locale, messages);
}

/** Activate, fetching the catalog the first time it is asked for. A no-op when
 *  the locale has not moved. */
/**
 * A catalog that cannot be fetched is not a reason for the panel not to start.
 * Each one is its own chunk, so a stale index or a half-deployed `web/dist`
 * makes this a real 404 — and it is awaited before the first paint, so the
 * rejection took the whole entry point down and rendered nothing at all. The
 * English source is every message's fallback, which is exactly the state to land
 * in: readable, in the language the code is written in.
 */
async function applyLocale(): Promise<void> {
  const next = preference();
  if (i18n.locale === next) return;
  try {
    await load(next);
  } catch (cause) {
    // Said out loud rather than swallowed: reading in the wrong language is a
    // thing somebody has to be able to find out about.
    console.error(`orch: the ${next} catalog did not load; reading in ${i18n.locale || "en"}`, cause);
    if (!i18n.locale) i18n.activate("en");
    return;
  }
  i18n.activate(next);
}

/** Before the first paint, with no server answer yet. */
export const startLocale = (): Promise<void> => applyLocale();

export function setPreference(pref: Locale): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
  // No event of our own: `I18nProvider` re-renders every `useLingui` consumer on
  // `activate`, and the control that shows the choice is one of them.
  //
  // `void` and not a dangling promise: `applyLocale` handles its own failure and
  // resolves either way, so there is no rejection here to lose.
  void applyLocale();
}

export { i18n, PrefSchema };
