import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Menu, MenuItem } from "../../ui/menu";
import { LOCALE_CHANGED, PrefSchema, preference, setPreference } from "../../i18n";
import { endonymOf, type Locale } from "../../../../src/contracts/config";

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
export function LocaleChoice() {
  const [pref, setPref] = useState<Locale>(preference);
  useEffect(() => {
    const sync = () => setPref(preference());
    window.addEventListener(LOCALE_CHANGED, sync);
    return () => window.removeEventListener(LOCALE_CHANGED, sync);
  }, []);

  return (
    <Menu label={endonymOf(pref)}>
      {PrefSchema.options.map((locale) => (
        <MenuItem
          key={locale}
          onSelect={() => {
            setPreference(locale);
            setPref(locale);
          }}
        >
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
