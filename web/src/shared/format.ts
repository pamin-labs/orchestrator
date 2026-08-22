import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";

/** Whatever the panel is being read in. Empty until the first `activate`, and
 *  `Intl` throws on an empty tag rather than falling back. */
const locale = () => i18n.locale || "en";

/**
 * Token counts, in the unit that fits.
 *
 * Stopped at k, so a real project's total printed as "1834k" — wrong as a unit and
 * unreadable as a number. A long-running project passes a billion cached tokens, so
 * B is not hypothetical.
 */
/**
 * The tiers were hand-written and the tier was chosen before the rounding: 999500
 * printed as "1000k" and 999999999 as "1000M" — a quantity in a unit that does not
 * exist, on the one panel the boss reads spend from — while 1200 printed as "1k", a
 * fifth of it gone. `Intl` picks the tier from the rounded value, so neither can
 * happen.
 */
/**
 * `Intl` at the active locale, not an `Intl.NumberFormat` of our own pinned to
 * `en-US`. The compact tier is a language's own: `183.4万` is how a Chinese
 * reader writes the number `1834000`, and `1,8 Mio.` is how a German one does. A
 * formatter frozen to one locale put every other reader's spend on screen in
 * English notation.
 */
/**
 * Built per call rather than once at module scope, and `Intl.NumberFormat`
 * rather than `i18n.number`: the locale moves while the page is open, and
 * Lingui deprecated its own wrapper in v6 in favour of calling `Intl` directly.
 * The engine caches the format instance behind the constructor.
 */
export const K = (v?: number | null) => {
  const n = v ?? 0;
  // A count that is not a number used to reach the screen spelled "NaN".
  if (!Number.isFinite(n)) return "0";
  // The one thing still spelled by hand, and it is typography rather than
  // language: English's compact tier is `K`, and the settings rows beside this
  // on the same page write it lowercase. No other locale's suffix contains one.
  return new Intl.NumberFormat(locale(), { notation: "compact", maximumFractionDigits: 1 }).format(n).replace("K", "k");
};

/** A timestamp as wall-clock time, for rows the boss scans against their own day. */
/**
 * `hourCycle: "h23"` rather than the locale's default, and that is the one thing
 * here that is not the reader's choice: these sit in a fixed-width column beside
 * each other, and `6:53 AM` next to `18:53` is a column that no longer lines up.
 * Everything else — separator, digit shaping — comes from the active locale.
 */
export const clock = (ms: number) =>
  new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

/**
 * How long something took, in the coarsest unit that does not lose the point.
 *
 * Span durations cover six orders of magnitude on this page — a cached prompt
 * assembly is under a millisecond, a cold sandbox is minutes — so one unit
 * cannot serve them. The tiers are chosen so a number never reads as a
 * different quantity than it is: below a second stays in milliseconds because
 * "0.0s" is not a duration, and above a minute splits into `m` and `s` because
 * "192.4s" makes the reader do the division that the panel exists to save them.
 */
export const duration = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
};

/** How long something has been waiting, in the coarsest unit that still says it. */
export const waited = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return t`Just now`;
  const span = m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
  return t`waiting ${span}`;
};
