import type { Usage } from "../../shared/api";
import i18n from "../../i18n";

const WARN_AT = 80;

/**
 * How old a reading may be before the failure behind it is worth showing.
 *
 * A failed read is not news: the last one is minutes old and these windows move
 * in hours, so the honest thing is to keep showing it and say nothing. It only
 * becomes the boss's problem when the number on screen is old enough to be wrong,
 * and an hour is well inside a five-hour window.
 */
const STALE_MS = 60 * 60_000;

const WHY: Record<string, { key: string; text: string }> = {
  rate_limited: { key: "rateLimited", text: "读用量被限流了，过一会自己恢复" },
  unreachable: { key: "unreachable", text: "连不上用量接口" },
  no_windows: { key: "noWindows", text: "这个账号没有窗口" },
};

/** Ring geometry. Hand-drawn at 15px, so the arc is a dash pattern, not a chart. */
export const R = 5.5;
const C = 2 * Math.PI * R;
export type RingInput = { v?: number; at?: number; read?: number; stale: boolean; why?: string };

/** "3h12m" / "2天4h". A reset three days out is not worth a minute count. */
export function until(unixSecs?: number): string {
  if (!unixSecs) return "";
  const ms = unixSecs * 1000 - Date.now();
  if (ms <= 0) return i18n.t("usage.model.resettingSoon", "即将重置");
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return i18n.t("usage.model.daysHours", "{{d}}天{{h}}h", { d, h: h % 24 });
  return h >= 1 ? `${h}h${min % 60}m` : `${min}m`;
}

/** A reading only becomes news once it is too old to trust. */
export const staleMark = (u: Usage) => !!u.error && Date.now() - u.at > STALE_MS;
/** The arc, or null for a window this plan does not have. A floor of 2% stays visible. */
export const ringArc = (v?: number) => (v === undefined ? null : `${(Math.min(100, Math.max(2, v)) / 100) * C} ${C}`);

/**
 * Terse: a number and when it resets, or why there is no number. The sentence it
 * replaced said "5 小时窗口" next to a ring already labelled 5h, and repeated the
 * failure text under every window it had already been shown for.
 *
 * The age only when it is old enough to matter. The poll is deliberately slow —
 * the endpoint 429s anything faster and then stays 429 — so a number can be
 * twenty minutes old, and at that point "the window has not moved" and "this has
 * not been refreshed" stop being the same sentence.
 */
export function ringTip(p: RingInput): string {
  if (p.v === undefined) {
    const entry = WHY[p.why ?? ""];
    return entry ? i18n.t(`usage.model.why.${entry.key}`, entry.text) : i18n.t("usage.model.unreadable", "读不到");
  }
  const age = p.read ? Math.round((Date.now() - p.read) / 60_000) : 0;
  return `${Math.round(p.v)}%${p.at ? ` · ${i18n.t("usage.model.resetsAfter", "{{t}}后重置", { t: until(p.at) })}` : ""}${age >= 15 ? ` · ${i18n.t("usage.model.minutesAgo", "{{age}}m 前", { age })}` : ""}`;
}

/**
 * One window's ring, or null when there is nothing to draw. An account without
 * this window holds the column open and says nothing in it: an empty ring plus a
 * dash was two marks claiming the reading failed, when the truth is the window
 * does not exist on that plan.
 */
export function ringView(p: RingInput) {
  if (p.v === undefined && !p.stale) return null;
  return { hot: p.v !== undefined && p.v >= WARN_AT, arc: ringArc(p.v), tip: ringTip(p) };
}
