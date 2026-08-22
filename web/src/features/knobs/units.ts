import { msg } from "@lingui/core/macro";
import { per } from "../../shared/format";

/**
 * The units the boss reads in, and the numbers the server stores.
 *
 * `turnTimeoutMs` is 1200000 and means twenty minutes; `leaseTimeoutMs` is
 * 10800000 and means three hours. Printed raw they are two seven-digit strings
 * differing in the middle, and telling them apart means counting zeros — on a page
 * whose job is letting someone change one without opening the source. Same for
 * token caps: at that width a cap and a typo look identical.
 */
/**
 * So the page shows `20 min` and `8M`. Every function here is exact in both
 * directions for every value the config ships — `read(show(x)) === x` — and
 * `knob-units.test.ts` is that sentence as a check, because a rounding bug here is
 * the silent kind: the field reads right and the fleet runs on a different number.
 */

export type Shape =
  /** A duration stored in milliseconds. */
  | "ms"
  /** A duration stored in seconds. */
  | "seconds"
  /** Tokens or characters, read as 8M / 200k. */
  | "count"
  /** A fraction of one, read as a percentage. */
  | "percent";

/**
 * Which shape a knob is, read off the name the server stores it under.
 *
 * This was twenty-six rows keyed by dotted path, and every one of them followed
 * the suffix: twenty-three `…Ms`, one `…Seconds`, one `…Fraction`, one `…Chars`.
 * The rule was already written down — in this file's own guard, as
 * `/(Ms|Seconds|Fraction)$/` — so the table was that rule's second copy, and the
 * copy is the one that goes stale. A knob whose name ends in none of these is
 * drawn as its own digits, which is right for `maxGroups`.
 */
/** Ordered, because `endsWith` is a first match: nothing here is a suffix of
 *  anything else today, and the tuple says so rather than a `Record` implying
 *  the order does not matter. */
const SHAPES: readonly (readonly [string, Shape])[] = [
  ["Ms", "ms"],
  ["Seconds", "seconds"],
  ["Fraction", "percent"],
  ["Chars", "count"],
];

export const shapeOf = (path: string): Shape | undefined => SHAPES.find(([suffix]) => path.endsWith(suffix))?.[1];

/**
 * What to say when a percentage is out of range. Shown on the row.
 *
 * One line where there were four. The other three said what spellings the free
 * text parser took — `8M, 200k, 45 all work` — and there is no free text left to
 * spell: a duration, a count and a percentage each get a digits box and a unit
 * beside it, so the only thing the reader can get wrong is the number.
 */
export const WANTS_PERCENT = msg`Wants a percentage between 0 and 100, like 60%`;

/**
 * One table: how many milliseconds each unit is, biggest first.
 *
 * The keys are ECMA-402's own unit identifiers, so nothing maps our name to
 * CLDR's — `unitLabel` hands the key straight to `Intl`. They were `d|h|min|s|ms`
 * beside a second table pairing each with `day|hour|…`: two lists to keep in
 * step for no reader's benefit, since this is a protocol key, indexed by the
 * arithmetic and never shown.
 */
/**
 * Biggest first is load-bearing twice, and declaration order is both: it is the
 * order `splitDuration` tries, so 1200000 reads as 20 minutes rather than
 * 1200000 milliseconds, and it is the order the unit menu offers. `day` is in
 * the list because `eventRetentionMs` ships at seven of them, and `168 hr` is
 * the same defect one unit up — a number nobody can check without dividing.
 */
export const PER = {
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1000,
  millisecond: 1,
} as const;

export type DurationUnit = keyof typeof PER;

/** The keys, in the order they are declared above. A predicate rather than a
 *  cast, so nothing here narrows `string[]` by assertion. */
const isDuration = (key: string): key is DurationUnit => key in PER;
export const DURATION_UNITS = Object.keys(PER).filter(isDuration);

/**
 * How this locale spells a unit, from CLDR rather than from a catalogue row.
 *
 * These were five `msg` descriptors and fifty translated lines, which is fifty
 * chances to disagree with the word `Intl` already prints beside a number
 * everywhere else on the page. `formatToParts` because the menu shows the unit
 * on its own: the `unit` part is the name without the digits. `1`, so the label
 * is the singular a reader expects beside a spinner — `day`, not `days`.
 */
const unitNames = per(
  (locale) =>
    new Map(
      DURATION_UNITS.map((u) => [
        u,
        new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "short" })
          .formatToParts(1)
          .find((part) => part.type === "unit")?.value ?? u,
      ]),
    ),
);

export const unitLabel = (unit: DurationUnit): string => unitNames().get(unit) ?? unit;

/**
 * The largest unit this many milliseconds is a whole number of.
 *
 * Whole, not nearest: 90 min stays 90 min rather than becoming 1.5 hr, and
 * every split can be multiplied back to exactly the number that came in.
 */
export function splitDuration(ms: number): { n: number; unit: DurationUnit } {
  for (const unit of DURATION_UNITS) {
    const n = ms / PER[unit];
    // Zero is a whole number of hours too; it should read as 0 sec.
    if (Number.isInteger(n) && (n !== 0 || unit === "second")) return { n, unit };
  }
  return { n: ms, unit: "millisecond" };
}

/**
 * One table again: how many the tier is worth, biggest first.
 *
 * `k` and `M` are not translated and not CLDR's — they are the spelling the box
 * stores and the reader types back, which is why `shared/format.ts` stopped
 * lowercasing `Intl`'s compact `K` to match them rather than the other way round.
 */
const COUNT_PER = { M: 1_000_000, k: 1000, "": 1 } as const;

export type CountUnit = keyof typeof COUNT_PER;

const isCount = (key: string): key is CountUnit => key in COUNT_PER;
/** Biggest first, which is the order `splitCount` tries. */
const COUNT_TIERS = Object.keys(COUNT_PER).filter(isCount);
/** Smallest first, which is how a menu reads. */
export const COUNT_UNITS: CountUnit[] = [...COUNT_TIERS].reverse();

/**
 * The largest unit this count is a *whole* number of, for a box that only takes
 * integers.
 *
 * Whole, not largest: 8500000 as `8.5M` is not something an integer field can
 * hold or a spinner can step through. Here the same number is 8500k, so every
 * value the config can hold has an integer spelling.
 */
export function splitCount(n: number): { n: number; unit: CountUnit } {
  if (!Number.isFinite(n)) return { n: 0, unit: "" };
  for (const unit of COUNT_TIERS) {
    const q = n / COUNT_PER[unit];
    if (q !== 0 && Number.isInteger(q)) return { n: q, unit };
  }
  return { n, unit: "" };
}

export const countOf = (n: number, unit: CountUnit): number => n * COUNT_PER[unit];

/**
 * The plain-number row, which is the only one that is still free text.
 *
 * These used to switch on `Shape` and hand a duration, a count or a percentage
 * to its own parser. Every one of those shapes now returns its own editor before
 * the text box is reached — a digits input and a unit beside it — so the four
 * branches were unreachable, and so were `parseDuration`, `parseCount`,
 * `parsePercent` and the alias table behind them. The comment above `Amount`
 * saying "the parser stays" was the last thing left of it.
 */
export const readNumber = (raw: string): number | null => {
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) ? n : null;
};
