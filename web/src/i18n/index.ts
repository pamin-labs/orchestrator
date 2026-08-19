import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./locales/zh.json";
import en from "./locales/en.json";

/**
 * The interface's own language — buttons, labels, tabs.
 *
 * A different knob from `output.language` (`docs/adr/035-language-follows-who-wrote-it.md`):
 * that one governs what *agents* and the orchestrator write back to you, stored
 * server-side, per project. This one is client-only, machine-local — same
 * category as the theme choice it sits beside in Preferences — and covers only
 * the strings a person who built this UI happened to write, not anything an
 * agent generates.
 */
const LOCALE_KEY = "orch.locale";

const read = (): string => {
  try {
    return localStorage.getItem(LOCALE_KEY) ?? "zh";
  } catch {
    return "zh";
  }
};

void i18n.use(initReactI18next).init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng: read(),
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
  // Resource keys are flat and carry literal dots — `knobs.labels.embedding.mode`
  // matches the config's own path name exactly, with no renamed/underscored
  // second copy to keep in sync. Off, not the default `.`, or i18next would try
  // to nest-traverse `t("knobs.labels.embedding.mode")` as four levels deep.
  keySeparator: false,
});

export function setLocale(lng: string): void {
  try {
    localStorage.setItem(LOCALE_KEY, lng);
  } catch {}
  void i18n.changeLanguage(lng);
}

export default i18n;
