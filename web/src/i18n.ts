import { i18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { z } from "zod";
import { localeOf } from "../../src/contracts/config.ts";
import zh from "./locales/zh.json";

/**
 * The panel's catalogs, raw. `@lingui/core` takes uncompiled ICU strings when a
 * compiler is registered, so `lingui compile` and its generated artefact never
 * exist — `build:web`, `bun test`, preflight, `browse.ts` and three workflows
 * would each have had to produce one first, and a fresh checkout that forgot
 * fails from inside a React component.
 */
/**
 * A leaf module on purpose: `@lingui/core`, the catalogs, and one contract.
 * Nothing from `ui/` or `shared/`. `test/web/module-graph.test.ts` fails on a
 * cycle between panel modules, and PR #9's third commit exists because its i18n
 * folder imported `ui/segment` while `shared/select.ts` imported i18n.
 */

const PrefSchema = z.enum(["follow", "zh", "en"]);
type Pref = z.infer<typeof PrefSchema>;

const KEY = "orch.locale";
/** What `follow` resolved to last time, so a reload does not start in the wrong
 *  language and correct itself once `/state` lands. */
const RESOLVED = "orch.locale.at";
export const LOCALE_CHANGED = "orch:locale";

const read = <T>(key: string, parse: (v: string | null) => T): T => {
  try {
    return parse(localStorage.getItem(key));
  } catch {
    return parse(null);
  }
};

export const preference = (): Pref => read(KEY, (v) => PrefSchema.catch("follow").parse(v));

/** The catalog on disk carries the English source beside each hashed id; the
 *  runtime wants only `{id: translation}`. */
const messages = (catalog: Record<string, { translation?: string }>): Record<string, string> => {
  const out: Record<string, string> = {};
  // An empty translation is a message nobody has done yet: leaving it out is
  // what makes the source text render instead of a blank pane.
  for (const [id, m] of Object.entries(catalog)) if (m.translation) out[id] = m.translation;
  return out;
};

i18n.setMessagesCompiler(compileMessage);
i18n.load("zh", messages(zh));
// English is the source: every id falls back to the message the macro hashed, so
// the catalog is empty by construction. Declared anyway — an unloaded locale
// warns on every render, and `en.json` is 800 `"translation": ""` lines nobody
// should ship to say what the source already says.
i18n.load("en", {});

/**
 * What to speak, given the stored preference and whatever the server last said.
 *
 * An empty `serverLanguage` is "not answered yet", not a language: on the first
 * paint of a first-ever load that leaves `zh`, which is what `output.language`
 * defaults to. Every later load reads the cached resolution instead, so the
 * flash happens once per browser rather than once per reload.
 */
export function resolve(pref: Pref, serverLanguage: string): "zh" | "en" {
  if (pref !== "follow") return pref;
  if (serverLanguage) return localeOf(serverLanguage);
  return read(RESOLVED, (v) => (v === "en" ? "en" : "zh"));
}

/** The last thing the server said, so changing the preference can re-resolve
 *  without waiting for the next `/state`. */
let announced = "";

/** Activate, and remember what `follow` came to. A no-op when nothing moved. */
export function applyLocale(serverLanguage: string): void {
  if (serverLanguage) announced = serverLanguage;
  const next = resolve(preference(), announced);
  if (preference() === "follow" && announced) {
    try {
      localStorage.setItem(RESOLVED, next);
    } catch {}
  }
  if (i18n.locale !== next) i18n.activate(next);
}

/** Before the first paint, with no server answer yet. */
export function startLocale(): void {
  applyLocale("");
}

export function setPreference(pref: Pref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
  // The pane that is open follows a change made anywhere else, without a second
  // copy of the value in React state.
  window.dispatchEvent(new CustomEvent(LOCALE_CHANGED));
  applyLocale("");
}

export { i18n, PrefSchema, type Pref };
