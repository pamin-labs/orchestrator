import { i18n } from "@lingui/core";

/**
 * One `Intl` formatter per locale, built the first time that locale is read in.
 *
 * Measured 10.05µs per call against 0.225µs reused, on a cost table that
 * formats hundreds of numbers a frame. Not at module scope: the locale moves
 * while the page is open, and `i18n.locale` is empty until the first `activate`.
 */
export function per<T>(make: (locale: string) => T): () => T {
  const made = new Map<string, T>();
  return () => {
    const locale = i18n.locale || "en";
    const found = made.get(locale);
    if (found) return found;
    const fresh = make(locale);
    made.set(locale, fresh);
    return fresh;
  };
}

/**
 * Token counts, in the unit that fits — `Intl`'s answer, untouched.
 *
 * The tiers were hand-written once and picked before the rounding, so 999500
 * printed as "1000k" and 1200 as "1k". The suffix belongs to the language:
 * `183.4万`, `1,8 Mio.`, and English's `K`. This used to lowercase that K to
 * match the settings rows, which is editing what CLDR said; those rows spell it
 * the way they store it, and they no longer take free text at all.
 * i18n-exempt: how each language writes a number is the subject.
 */
const compact = per((locale) => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }));

export const K = (v?: number | null) => {
  const n = v ?? 0;
  // A count that is not a number used to reach the screen spelled "NaN".
  if (!Number.isFinite(n)) return "0";
  return compact().format(n);
};

/**
 * Wall-clock time, for rows the boss scans against their own day.
 *
 * `hourCycle: "h23"` is the one thing here that is not the reader's choice: the
 * column is fixed-width and `6:53 AM` beside `18:53` no longer lines up.
 */
const hhmm = per((locale) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));

export const clock = (ms: number) => hhmm().format(ms);

/**
 * The coarsest trend-axis label, from the same `Intl` the clock uses.
 *
 * The axis built this as `${month + 1}/${date}`, so `8/20` was 20 August here
 * and 8 August to a German, French or Korean reader — half the shipped locales
 * read month-first as a date they did not get.
 */
const mmdd = per((locale) => new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }));

export const day = (at: Date | number) => mmdd().format(at);

/**
 * How long something took, in the coarsest unit that does not lose the point.
 *
 * Six orders of magnitude on one page, so no single unit serves: below a second
 * stays in milliseconds because "0.0s" is not a duration, and above a minute
 * splits rather than leave the reader dividing "192.4s". The units are SI
 * symbols, which is why they are not translated.
 */
export const duration = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
};

/**
 * How long something has been waiting, in the coarsest unit that still says it.
 *
 * `Intl.RelativeTimeFormat` and not two messages of ours: this was
 * `` t`Just now` `` and `` t`waiting ${span}` `` with the span built as `20m`,
 * so twenty translated rows said what CLDR says in every language and got the
 * word order wrong in three of them — French and Spanish put the phrase in front
 * (`il y a 20 min`, `hace 20 min`) and nothing in an interpolated suffix can.
 * `numeric: "auto"` is what turns zero into `now` rather than `in 0 seconds`.
 */
const ago = per((locale) => new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }));

export const waited = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return ago().format(0, "second");
  return m < 60 ? ago().format(-m, "minute") : ago().format(-Math.round(m / 60), "hour");
};
