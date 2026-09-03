import { useEffect, useState } from "react";
import { Segment, Segments } from "./segment";
import { z } from "zod";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

/**
 * Light / dark / follow the system.
 *
 * Three states, not two: "follow the system" is what most people want and what a
 * bare toggle cannot express — it silently pins whatever the machine happened to
 * be when you first clicked. The stored value is the preference; `data-theme` is
 * always resolved to a concrete light or dark, which is why the stylesheet needs
 * one dark block instead of three.
 */
/**
 * The control lives in settings, not the header: it was an icon that cycled three
 * states one click at a time — a permanent control for a thing set once, and a
 * cycle button cannot show what the other two options are. Applying the stored
 * theme is separate (`startTheme`, at boot), because the page has to come up right
 * whether or not anyone opens settings.
 */
const PrefSchema = z.enum(["system", "light", "dark"]);
type Pref = z.infer<typeof PrefSchema>;
const KEY = "orch.theme";
const NEXT: Record<Pref, Pref> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Pref, MessageDescriptor> = { system: msg`Follow the system`, light: msg`Light`, dark: msg`Dark` };
const CHANGED = "orch:theme";

const read = (): Pref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};

const apply = (p: Pref) => {
  const dark = p === "dark" || (p === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // The markdown editor reads its own attribute, and it reads it here rather than
  // deciding for itself: left alone it follows `prefers-color-scheme`, which is
  // the one answer that is wrong whenever the boss has overridden the theme.
  document.documentElement.dataset.colorMode = dark ? "dark" : "light";
};

function set(p: Pref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {}
  apply(p);
  // So a control that is open follows the keyboard shortcut, and the other way
  // round. One stored value, no second copy in React state to keep in step.
  window.dispatchEvent(new CustomEvent(CHANGED));
}

/** ⌘⇧L, or Ctrl⇧L. Read off `key` rather than `code`, so it is the same chord on
 *  a layout where L is somewhere else. */
export const isThemeHotkey = (e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "key">): boolean =>
  (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "l";

/**
 * Apply the stored theme and keep it applied. Called once, at boot.
 *
 * On "system" the OS can change under us — at sunset, on a schedule — and the
 * page has to follow without a reload.
 */
/**
 * Named and removed before it is added, so calling this twice wires one listener.
 *
 * "Called once, at boot" was a sentence rather than a property: a second call
 * left two keydown listeners on the same window and one press cycled two steps.
 * A stable module-level function is all `removeEventListener` needs, so this
 * costs no state of its own — which a `started` flag would have been.
 */
const followSystem = () => {
  if (read() === "system") apply("system");
};

const onHotkey = (e: KeyboardEvent) => {
  if (!isThemeHotkey(e)) return;
  e.preventDefault();
  set(NEXT[read()]);
};

export function startTheme(): void {
  apply(read());
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.removeEventListener("change", followSystem);
  media.addEventListener("change", followSystem);
  window.removeEventListener("keydown", onHotkey);
  window.addEventListener("keydown", onHotkey);
}

/** The three states, said out loud. ⌘⇧L still cycles them from anywhere. */
export function ThemeChoice() {
  const { t } = useLingui();
  const [pref, setPref] = useState<Pref>(read);
  useEffect(() => {
    const sync = () => setPref(read());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);

  return (
    <Segments
      value={pref}
      onValueChange={(v) => {
        const next = PrefSchema.parse(v);
        set(next);
        setPref(next);
      }}
    >
      {PrefSchema.options.map((p) => (
        <Segment key={p} value={p}>
          {t(LABEL[p])}
        </Segment>
      ))}
    </Segments>
  );
}
