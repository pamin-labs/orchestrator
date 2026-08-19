import { useTranslation } from "react-i18next";
import { Segment, Segments } from "../../ui/segment";
import { setLocale } from "../../i18n";

/**
 * Chinese / English, for the interface itself.
 *
 * Same shape as `ThemeChoice`: a stored, machine-local preference, shown as a
 * segmented control rather than a dropdown because two options fit on one row.
 * `useTranslation()` already re-renders on `i18n.changeLanguage()` — no manual
 * event bridge needed, unlike the theme choice's `CustomEvent`, because
 * react-i18next's hook subscribes to i18next's own emitter.
 */
type Locale = "zh" | "en";
const OPTIONS: Locale[] = ["zh", "en"];
const LABEL: Record<Locale, string> = { zh: "中文", en: "English" };
const isLocale = (v: string): v is Locale => v === "zh" || v === "en";

export function LocaleChoice() {
  const { i18n } = useTranslation();
  const current = isLocale(i18n.language) ? i18n.language : "zh";

  return (
    <Segments value={current} onValueChange={(v) => setLocale(v)}>
      {OPTIONS.map((o) => (
        <Segment key={o} value={o}>
          {LABEL[o]}
        </Segment>
      ))}
    </Segments>
  );
}
