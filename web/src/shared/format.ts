/**
 * Token counts, in the unit that fits.
 *
 * Stopped at k, so a real project's total printed as "1834k" — which is both wrong
 * as a unit and unreadable as a number. A long-running project passes a billion
 * cached tokens, so B is not hypothetical.
 *
 * The tiers were hand-written, and the tier was chosen before the rounding: 999500
 * printed as "1000k" and 999999999 as "1000M" — a quantity in a unit that does not
 * exist, on the one panel the boss reads spend from. 1200 printed as "1k", a fifth
 * of it gone. `Intl` picks the tier from the rounded value, so neither can happen,
 * and it is the same call `toLocaleString` already makes elsewhere on this page.
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

/** How long something has been waiting, in the coarsest unit that still says it. */
export const waited = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "刚刚" : m < 60 ? `等待 ${m}m` : `等待 ${Math.round(m / 60)}h`;
};
