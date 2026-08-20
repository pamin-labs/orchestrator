import { useEffect, useState } from "react";
import { Segment, Segments } from "../../ui/segment";
import { LOCALE_CHANGED, type Pref, PrefSchema, preference, setPreference } from "../../i18n";

/**
 * Follow the server / 中文 / English, beside the theme control and for the same
 * reason: three states, because "follow" is what most people want and a bare
 * toggle silently pins whatever the fleet happened to be speaking that day.
 */
/**
 * The two language names are endonyms and stay untranslated — a menu that says
 * "Chinese" to somebody who cannot read the pane they are on is no help. The
 * followed value is `output.language`, the knob in Settings → 模型与预算, which
 * is also what the agents write in; this only decides the chrome around them.
 */
const LABEL: Record<Pref, string> = { follow: "跟随服务器", zh: "中文", en: "English" };

export function LocaleChoice() {
  const [pref, setPref] = useState<Pref>(preference);
  useEffect(() => {
    const sync = () => setPref(preference());
    window.addEventListener(LOCALE_CHANGED, sync);
    return () => window.removeEventListener(LOCALE_CHANGED, sync);
  }, []);

  return (
    <Segments
      value={pref}
      onValueChange={(v) => {
        const next = PrefSchema.parse(v);
        setPreference(next);
        setPref(next);
      }}
    >
      {PrefSchema.options.map((p) => (
        <Segment key={p} value={p}>
          {LABEL[p]}
        </Segment>
      ))}
    </Segments>
  );
}
