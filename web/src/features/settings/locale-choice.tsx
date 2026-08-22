import { Check } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Menu, MenuItem } from "../../ui/menu";
import { setPreference } from "../../i18n";
import { endonymOf, LOCALES, localeOf, type Locale } from "../../../../src/contracts/config";
import { api, mutate } from "../../shared/api";

/**
 * Which language this browser reads, and nothing else.
 *
 * A menu, not a combobox: a combobox is an `<input>`, so it carries a caret and
 * invites typing — and this is ten fixed values, none of which the reader is
 * meant to invent. The one beside it in `Models & budget` stays a combobox for the
 * opposite reason: `output.language` is free text that reaches a model.
 */
/**
 * Endonyms, from the one table in contracts: "Chinese" is no help to somebody
 * who cannot read the pane it is on. The tick follows the locale that is *live*
 * rather than the one asked for — they differ while a chunk is in flight, and
 * stay different if it never arrives, and a tick on a language that failed to
 * load would be the one thing here that is not true.
 */
/**
 * Told to the server as well as to this browser.
 *
 * `output.language` defaults to following this, so the server has to be able to
 * answer "what is the reader reading" — and a `localStorage` key is not
 * something it can read. Quiet and not awaited: the panel's own language has
 * already changed by the time this lands, and a settings row that failed to
 * write is not worth a toast over a preference the reader can see took effect.
 */
const choose = (locale: Locale): void => {
  setPreference(locale);
  void mutate(api.settings.$post({ json: { path: "panelLanguage", value: locale } }), true);
};

export function LocaleChoice() {
  // `useLingui`, and no second copy of the value in React state: the provider
  // already re-renders its consumers on `activate`, which is what the hand-rolled
  // `orch:locale` event used to do less well.
  const { i18n } = useLingui();
  const pref = localeOf(i18n.locale);

  return (
    <Menu label={endonymOf(pref)}>
      {LOCALES.map((locale) => (
        <MenuItem key={locale} onSelect={() => choose(locale)}>
          <span className="flex items-center gap-2">
            {/* The tick holds its width either way, so the names stay on one
                left edge rather than shifting as the choice moves. */}
            <Check size={12} strokeWidth={2.5} className={locale === pref ? "text-accent" : "invisible"} />
            {endonymOf(locale)}
          </span>
        </MenuItem>
      ))}
    </Menu>
  );
}
