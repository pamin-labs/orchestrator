import { useEffect, useState } from "react";
import { t } from "@lingui/core/macro";
import { Combobox } from "../../ui/combobox";
import { LOCALE_CHANGED, type Pref, PrefSchema, preference, setPreference } from "../../i18n";
import { endonymOf } from "../../../../src/contracts/config";

/**
 * Follow the server, or one of the catalogs, for this browser only.
 *
 * A list rather than the theme control's segments: three states fit on a row and
 * ten do not. Follow is first because it is what most people want — a bare
 * choice silently pins whatever the fleet happened to be speaking that day.
 */
/**
 * Every language names itself, and the follow entry is the only one that is a
 * sentence rather than a name — so it is the only one translated. It said
 * "follow the server" first, which named no setting anybody could find: a server
 * has no language, `output.language` does.
 *
 * The names come from `LANGUAGES` in contracts rather than from a copy here:
 * this list used to exist in five places and adding a language meant finding
 * all five.
 */
export function LocaleChoice() {
  const [pref, setPref] = useState<Pref>(preference);
  useEffect(() => {
    const sync = () => setPref(preference());
    window.addEventListener(LOCALE_CHANGED, sync);
    return () => window.removeEventListener(LOCALE_CHANGED, sync);
  }, []);

  const follow = t`Same as the agents' language`;
  const label = (p: Pref): string => (p === "follow" ? follow : endonymOf(p));
  const byLabel = new Map(PrefSchema.options.map((p) => [label(p), p]));

  return (
    <Combobox
      value={label(pref)}
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
