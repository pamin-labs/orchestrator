import { useEffect, useState } from "react";
import { t } from "@lingui/core/macro";
import { Combobox } from "../../ui/combobox";
import { LOCALE_CHANGED, PrefSchema, preference, setPreference } from "../../i18n";
import { endonymOf, type Locale } from "../../../../src/contracts/config";

/**
 * Which language this browser reads, and nothing else.
 *
 * A list rather than the theme control's segments: three states fit on a row and
 * nine do not. Every language names itself — a menu that says "Chinese" is no
 * help to somebody who cannot read the pane it is on — and the names come from
 * the one table in contracts rather than from a copy here.
 */
export function LocaleChoice() {
  const [pref, setPref] = useState<Locale>(preference);
  useEffect(() => {
    const sync = () => setPref(preference());
    window.addEventListener(LOCALE_CHANGED, sync);
    return () => window.removeEventListener(LOCALE_CHANGED, sync);
  }, []);

  const byLabel = new Map(PrefSchema.options.map((p) => [endonymOf(p), p]));

  return (
    <Combobox
      value={endonymOf(pref)}
      options={[...byLabel.keys()]}
      empty={t`No such language`}
      width="12rem"
      onCommit={(picked) => {
        const next = byLabel.get(picked);
        if (!next) return;
        setPreference(next);
        setPref(next);
      }}
    />
  );
}
