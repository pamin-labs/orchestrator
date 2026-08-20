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
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const K = (v?: number | null) => {
  const n = v ?? 0;
  // A count that is not a number used to reach the screen spelled "NaN".
  if (!Number.isFinite(n)) return "0";
  // en-US stamps the thousands tier "K"; the rest of the panel — the settings
  // rows in features/knobs/units.ts — writes it lowercase, and M / B already agree.
  return COMPACT.format(n).replace("K", "k");
};

/** A timestamp as wall-clock time, for rows the boss scans against their own day. */
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

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
  return m < 1 ? "刚刚" : m < 60 ? `等待 ${m}m` : `等待 ${Math.round(m / 60)}h`;
};
