import { setupI18n, type I18n, type Messages } from "@lingui/core";
import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { localeOf, type Locale } from "../../contracts/config.ts";
import { renderWith, type Said } from "../../contracts/said.ts";
import { messages as en } from "../../../locales/en.po";
import { messages as zh } from "../../../locales/zh.po";
import { messages as zhHant } from "../../../locales/zh-Hant.po";
import { messages as ja } from "../../../locales/ja.po";
import { messages as ko } from "../../../locales/ko.po";
import { messages as es } from "../../../locales/es.po";
import { messages as fr } from "../../../locales/fr.po";
import { messages as de } from "../../../locales/de.po";
import { messages as pt } from "../../../locales/pt.po";
import { messages as ru } from "../../../locales/ru.po";

/**
 * The strings the orchestrator itself says about its own work.
 *
 * This was two hand-kept tables — English and Simplified Chinese — behind an
 * `isChinese()` test, which is a language *pair*. A boss whose `output.language`
 * was `한국어` got English, however that knob was set, because there was no third
 * row to get. They are the same nine catalogues the panel reads, compiled into
 * this binary by the same plugin: `Bun.build` takes one, and only `bun build`
 * the CLI does not.
 */
/**
 * Ten locales, ten catalogues. English used to be `{}` here on the grounds that
 * the source locale's catalogue is empty by construction — but `en.po` exists,
 * and loading it renders every case identically (measured, plural and
 * selectordinal included), so the row that needed explaining is gone instead.
 */
const CATALOGS: Record<Locale, Messages> = { en, zh, "zh-Hant": zhHant, ja, ko, es, fr, de, pt, ru };

/**
 * One instance per locale, not `activate` on a shared one: `activate` is
 * process-wide state, and two requests can want two languages at once.
 */
const instances = new Map<Locale, I18n>();

function of(locale: Locale): I18n {
  const found = instances.get(locale);
  if (found) return found;
  const made = setupI18n({ locale, messages: { [locale]: CATALOGS[locale] } });
  // What lets the `message` on a descriptor be a catalogue of one: the
  // fallback arrives as ICU source, and this is the documented way to compile
  // it without a build step. A catalogue row is already compiled and skips it.
  made.setMessagesCompiler(compileMessageOrThrow);
  instances.set(locale, made);
  return made;
}

/**
 * A `Said` rendered for a reader who is not a browser: the notify webhook, the
 * `/readyz` detail, and the `body` column every stored event still has.
 *
 * `output.language` is free text a person typed, so `localeOf` decides which of
 * the ten it asks for.
 */
export const renderSaid = (lang: string | undefined, sentence: Said): string =>
  renderWith(of(localeOf(lang)), sentence);
