import { setupI18n, type I18n } from "@lingui/core";
import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { localeOf, type Locale } from "../../contracts/config.ts";
import type { Said } from "../../contracts/said.ts";
import { MESSAGES, type MessageId } from "./messages.generated.ts";

/**
 * The strings the orchestrator itself says about its own work.
 *
 * This was two hand-kept tables — English and Simplified Chinese — behind an
 * `isChinese()` test, which is a language *pair*. A boss whose `output.language`
 * was `한국어` got English, however that knob was set, because there was no third
 * row to get. The tables are now the nine catalogs the panel already had, folded
 * into `messages.generated.ts` by `bun run i18n:messages`.
 */
/**
 * Lingui at runtime, which ADR 041 did not actually forbid: what `bun build
 * --compile` cannot do is run the plugin that compiles a `.po`, so the catalog
 * arrives as a generated module instead. The library itself compiles ICU here,
 * which is why a Russian `few` branch is right without us writing a rule.
 */
/**
 * One instance per locale, not `activate` on a shared one: `activate` is
 * process-wide state, and two requests can want two languages at once.
 */
const instances = new Map<Locale, I18n>();

function of(locale: Locale): I18n {
  const found = instances.get(locale);
  if (found) return found;
  const made = setupI18n({ locale, messages: { [locale]: MESSAGES[locale] } });
  made.setMessagesCompiler(compileMessageOrThrow);
  instances.set(locale, made);
  return made;
}

/**
 * The typed way to name a sentence without rendering it.
 *
 * `Said["id"]` is a `string` — `src/contracts` cannot see the generated table —
 * so an emitter writing `{ id: "ev.wd.stalledd" }` by hand would compile. This
 * is the one door with `MessageId` on it, and every `bus.emit` goes through it.
 */
export const said = (id: MessageId, values?: Said["values"]): Said => (values ? { id, values } : { id });

/**
 * A `Said` rendered for a reader who is not a browser: the notify webhook, and
 * the `body` column every row written before `meta.say` existed still has.
 *
 * `output.language` is free text a person typed, so `localeOf` decides which of
 * the ten it asks for. An id with no row renders as itself rather than throwing.
 */
export const renderSaid = (lang: string | undefined, sentence: Said): string =>
  of(localeOf(lang))._(sentence.id, sentence.values);

/** The same, for a caller that has the id and its values loose. */
export const say = (lang: string | undefined, id: MessageId, values?: Said["values"]): string =>
  renderSaid(lang, said(id, values));
