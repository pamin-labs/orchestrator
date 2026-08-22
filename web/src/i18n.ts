import { i18n, type Messages } from "@lingui/core";
import { type Locale, localeOf } from "../../src/contracts/config.ts";

/**
 * The panel's catalogs, compiled.
 *
 * `scripts/lingui-catalogs.ts` turns each `.po` into an ES module exporting
 * `messages`, which is what `@lingui/vite-plugin` does for Vite. So this is the
 * documented shape — `const { messages } = await import(…)`, then
 * `loadAndActivate` — and no ICU parser reaches the browser.
 */
/**
 * A leaf module on purpose: `@lingui/core`, the catalogs, and one contract.
 * Nothing from `ui/` or `shared/`. `test/web/module-graph.test.ts` fails on a
 * cycle between panel modules, and PR #9's third commit exists because its i18n
 * folder imported `ui/segment` while `shared/select.ts` imported i18n.
 */

const KEY = "orch.locale";

/**
 * One `import()` per catalog, written out rather than built from a template: a
 * bundler splits what it can see, and a template literal it cannot resolve
 * either fails or pulls the whole directory into the entry point. Each is its
 * own chunk of about 90KB, and nobody reads two.
 */
/**
 * English is in the list. It used to be `Exclude<Locale, "en">` with an empty
 * catalogue loaded beside it — the source locale renders from the `message` the
 * macro left in the bundle, so the chunk bought nothing but a saved fetch. Ten
 * locales through one path is what Lingui's own SSR example does, and it is what
 * lets `saidText` be one line; ADR 041 records the fetch as the price.
 */
const CATALOGS: Record<Locale, () => Promise<{ messages: Messages }>> = {
  en: () => import("../../locales/en.po"),
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
 * The read is guarded, because `localStorage` is not always there to read.
 * Chrome's "block all cookies", Firefox's `dom.storage.enabled=false` and a
 * handful of enterprise policies make the *getter* throw, not return null, and
 * `startLocale()` is awaited before `createRoot().render()` — so the whole panel
 * was a blank page.
 */
/**
 * It used to go through `@lingui/detect-locale`, on the strength of a comment
 * saying it owned that. Its `detectFromStorage` is a bare
 * `globalThis.localStorage.getItem(key)`, and `fromStorage(KEY)` was evaluated
 * at the call site anyway, so the throw landed before `detect` was entered.
 */
/**
 * `localeOf` and nothing else, where this used to be `z.enum(LOCALES)` over the
 * stored value with a `detect(fromNavigator())` fallback. It is total by
 * construction (`?? "en"`), it takes a stored `Locale` and a raw
 * `navigator.language` identically, and it accepts the legacy values a `z.enum`
 * would have thrown away — a browser holding `"zh-CN"` from before this key was
 * a `Locale` reads Simplified rather than English.
 */
export const preference = (): Locale => {
  let stored = "";
  try {
    stored = localStorage.getItem(KEY) ?? "";
  } catch {}
  return localeOf(stored || navigator.language);
};

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
export async function startLocale(want?: Locale): Promise<void> {
  const next = want ?? preference();
  if (i18n.locale === next) return;
  try {
    // `loadAndActivate`, not `load` then `activate`: those are two `change`
    // events and therefore two renders of every consumer, with the middle one
    // showing the new catalog under the old locale. Fetched once per locale per
    // page, English included — the entry point holds no catalog at all.
    const { messages } = await CATALOGS[next]();
    i18n.loadAndActivate({ locale: next, messages });
  } catch (cause) {
    // Said out loud rather than swallowed: reading in the wrong language is a
    // thing somebody has to be able to find out about.
    console.error(`orch: the ${next} catalog did not load; reading in ${i18n.locale || "en"}`, cause);
    // The floor, and only when nothing is active. `i18n.activate("en")` alone was
    // the old floor and it is what kept `setMessagesCompiler` in the bundle: with
    // no catalog loaded every id falls back to ICU source, which needs a compiler
    // in the browser to render a plural. Loading `en.po` takes the same door every
    // other locale takes and the rows arrive compiled — 19,903 bytes of
    // `@messageformat/parser` off `main.js`.
    if (i18n.locale) return;
    try {
      const { messages } = await CATALOGS.en();
      i18n.loadAndActivate({ locale: "en", messages });
    } catch {
      // If the English chunk is gone too then the deploy is gone; `activate` at
      // least gives React a locale to render the untranslated sources under.
      i18n.activate("en");
    }
  }
}

export function setPreference(pref: Locale): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
  // The value, not a re-read of the store. Writing it can be refused — the same
  // policies that make the getter throw — and re-reading then returned the old
  // one, so picking a language did nothing and said nothing.
  //
  // No event of our own: `I18nProvider` re-renders every `useLingui` consumer on
  // `activate`, and the control that shows the choice is one of them.
  //
  // `void` and not a dangling promise: `startLocale` handles its own failure and
  // resolves either way, so there is no rejection here to lose.
  void startLocale(pref);
}

export { i18n };
