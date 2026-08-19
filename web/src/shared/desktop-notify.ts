import { z } from "zod";

/**
 * Whether desktop notifications are wanted, which is not whether they are allowed.
 *
 * The panel had only a 允许通知 button and no way back, because a page cannot
 * revoke its own permission — that lives in browser settings, under a hostname
 * rather than a product name. Two facts, kept apart: the permission is the
 * browser's, this is the boss's, and it is the one a settings pane can offer.
 */
/**
 * Off falls back to a toast, which is what an ungranted permission already does;
 * the tab title keeps the count either way. Local to this machine, like the theme
 * and for the same reason.
 *
 * In `shared/` rather than beside `ThemeChoice` in `ui/`: that file is a control,
 * this is a preference the stream reducer also reads — and `ui/` importing
 * `shared/` while `shared/` imported `ui/` is the cycle `module-graph.test.ts`
 * caught.
 */
const KEY = "orch.desktop-notify";
const WantSchema = z.enum(["on", "off"]);
export type NotifyWant = z.infer<typeof WantSchema>;

/** On unless it was turned off: a boss who granted the permission asked for these. */
export const notifyWanted = (): NotifyWant => {
  try {
    return WantSchema.catch("on").parse(localStorage.getItem(KEY));
  } catch {
    // Private browsing throws on `localStorage`, and refusing to notify would be
    // the wrong way to fail — the permission was granted deliberately.
    return "on";
  }
};

/**
 * No change event, unlike the theme's.
 *
 * The theme has to repaint what is already on screen, so a second control in
 * another tree has to hear about it. This is read once per notification, at the
 * moment one is about to be raised — so the next one already sees the new value
 * and there is nothing to keep in sync.
 */
export function setNotifyWanted(want: NotifyWant): void {
  try {
    localStorage.setItem(KEY, want);
  } catch {}
}
