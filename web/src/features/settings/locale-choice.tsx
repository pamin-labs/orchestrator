import { Check } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Menu, MenuItem } from "../../ui/menu";
import { PrefSchema, setPreference } from "../../i18n";
import { endonymOf } from "../../../../src/contracts/config";

/**
 * Which language this browser reads, and nothing else.
 *
 * A menu, not a combobox: a combobox is an `<input>`, so it carries a caret and
 * invites typing — and this is nine fixed values, none of which the reader is
 * meant to invent. The one beside it in 模型与预算 stays a combobox for the
 * opposite reason: `output.language` is free text that reaches a model.
 */
/**
 * Every language names itself. "Chinese" is no help to somebody who cannot read
 * the pane it is on, so the names are endonyms and come from the one table in
 * contracts rather than from a copy here.
 */
/**
 * The tick follows the locale that is *live*, not the one that was asked for.
 *
 * They differ while a catalog chunk is in flight, and they stay different if it
 * never arrives — `applyLocale` falls back to English rather than leaving the
 * panel unrendered. A tick on the language that failed to load would be the one
 * thing on this pane that is not true.
 */
export function LocaleChoice() {
  // `useLingui`, and no second copy of the value in React state: the provider
  // already re-renders its consumers on `activate`, which is what the hand-rolled
  // `orch:locale` event used to do less well.
  const { i18n } = useLingui();
  const pref = PrefSchema.catch("en").parse(i18n.locale);

  return (
    <Menu label={endonymOf(pref)}>
      {PrefSchema.options.map((locale) => (
        <MenuItem key={locale} onSelect={() => setPreference(locale)}>
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
