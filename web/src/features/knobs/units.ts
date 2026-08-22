import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../../i18n";

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
 * Which knobs are not the plain number they look like.
 *
 * Keyed by the same dotted path the server sends. A knob missing from here is
 * drawn as its own digits, which is right for `maxGroups` and wrong for anything
 * whose name ends in `Ms` — the check asserts that, so a new duration knob
 * cannot ship rendering as 1200000.
 */
export const KNOB_SHAPE: Record<string, Shape> = {
  turnTimeoutMs: "ms",
  leaseTimeoutMs: "ms",
  installTimeoutMs: "ms",
  parkAfterPausedMs: "ms",
  watchdogIntervalMs: "ms",
  eventRetentionMs: "ms",
  "watchdog.reemitMs": "ms",
  "watchdog.nudgeAfterMs": "ms",
  "watchdog.nudgeReemitMs": "ms",
  "watchdog.pausedNotifyMs": "ms",
  "watchdog.repoMapEveryMs": "ms",
  "timeouts.githubApiMs": "ms",
  "timeouts.credentialCheckMs": "ms",
  "timeouts.webhookMs": "ms",
  "timeouts.sandboxPingMs": "ms",
  "timeouts.networkPingMs": "ms",
  "timeouts.tokenRefreshMs": "ms",
  "timeouts.usageReadMs": "ms",
  "timeouts.transferMs": "ms",
  "intervals.recheckMs": "ms",
  "intervals.usagePollMs": "ms",
  "intervals.usageBackoffMs": "ms",
  "intervals.notifyBatchMs": "ms",
  telemetryCacheMs: "ms",
  "sandbox.ttlSeconds": "seconds",
  sessionRotateFraction: "percent",
  ctxBudgetChars: "count",
};

/** What to say when the typed text is not one of these. Shown on the row. */
export const WANTS: Record<Shape, MessageDescriptor> = {
  ms: msg`Wants a duration: 20 min, 45s, 3 hr all work`,
  seconds: msg`Wants a duration: 24 hr, 30 min both work`,
  count: msg`Wants a count: 8M, 200k, 45 all work`,
  percent: msg`Wants a percentage between 0 and 100, like 60%`,
};

/**
 * The key is ASCII and the label is translated, because this union used to be
 * both at once: `PER` was keyed on the same Chinese strings the page printed, so
 * translating the label would have changed what the arithmetic looked up.
 */
export type DurationUnit = "ms" | "s" | "min" | "h" | "d";

const UNIT_LABEL: Record<DurationUnit, MessageDescriptor> = {
  ms: msg`ms`,
  s: msg`sec`,
  min: msg`min`,
  h: msg`hr`,
  d: msg`day`,
};

/** `msg` at module scope, `i18n._` at call scope: a descriptor is locale-free
 *  data, so it is safe in a table built once at import. */
export const unitLabel = (unit: DurationUnit): string => i18n._(UNIT_LABEL[unit]);

export const PER: Record<DurationUnit, number> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Biggest first, so 1200000 reads as 20 min rather than 1200000 ms.
 *
 * Days are in the list because `eventRetentionMs` ships at seven of them, and
 * `168 hr` is the same defect one unit up: a number nobody can check without
 * dividing. Only two shipped values are a whole number of days, and both read
 * better as one.
 */
/** Biggest first, which is also the order the unit menu offers them. */
export const DURATION_UNITS: readonly DurationUnit[] = ["d", "h", "min", "s", "ms"];

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
    if (Number.isInteger(n) && (n !== 0 || unit === "s")) return { n, unit };
  }
  return { n: ms, unit: "ms" };
}

export function fmtDuration(ms: number): string {
  const { n, unit } = splitDuration(ms);
  return `${n} ${unitLabel(unit)}`;
}

/**
 * Every spelling of a unit someone might type, including the ones this page
 * prints. A bare number keeps the unit already on screen.
 */
// i18n-exempt: the keys are every spelling somebody might type, which includes
// the Chinese ones. They are input, not output — translating them would delete
// the spellings a Chinese reader has been typing since before this was English.
const ALIAS: Record<string, DurationUnit> = {
  ms: "ms",
  毫秒: "ms",
  s: "s",
  sec: "s",
  secs: "s",
  秒: "s",
  m: "min",
  min: "min",
  mins: "min",
  分: "min",
  分钟: "min",
  h: "h",
  hr: "h",
  hrs: "h",
  时: "h",
  小时: "h",
  d: "d",
  day: "d",
  days: "d",
  天: "d",
  日: "d",
};

/** Text back to milliseconds. `null` = not a duration. */
export function parseDuration(raw: string, unit: DurationUnit): number | null {
  // i18n-exempt: a character class, not a sentence — it has to match the Chinese
  // aliases above.
  const m = /^(\d+(?:\.\d+)?)\s*([a-z一-鿿]*)$/i.exec(raw.trim());
  if (!m) return null;
  // `Object.hasOwn`, not a truthy index: `ALIAS["constructor"]` is `Object`, and
  // `PER[Object]` is `undefined`, so `parseDuration("5constructor")` returned NaN
  // instead of null. Same accident `schemaAt` in `contracts/config.ts` closed.
  const key = m[2]?.toLowerCase();
  const found = key ? (Object.hasOwn(ALIAS, key) ? ALIAS[key] : undefined) : unit;
  if (!found) return null;
  // Rounded because 1.5 * 3_600_000 is exact but 0.1 * 3_600_000 is not, and a
  // duration that lands on 359999.99999 is a number no validator will accept.
  return Math.round(Number(m[1]) * PER[found]);
}

/** 8000000 → 8M, 272000 → 272k, 45 → 45. */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

export type CountUnit = "" | "k" | "M";

export const COUNT_UNITS: CountUnit[] = ["", "k", "M"];

const COUNT_PER: Record<CountUnit, number> = { "": 1, k: 1000, M: 1_000_000 };

/**
 * The largest unit this count is a *whole* number of, for a box that only takes
 * integers.
 *
 * Not `fmtCount`, which is for reading: it will happily print 8500000 as `8.5M`,
 * and 8.5 is not something an integer field can hold or a spinner can step
 * through. Here the same number is 8500k, so every value the config can hold has
 * an integer spelling and `read(split(x)) === x` on all of them.
 */
export function splitCount(n: number): { n: number; unit: CountUnit } {
  if (!Number.isFinite(n)) return { n: 0, unit: "" };
  for (const unit of ["M", "k"] as const) {
    const q = n / COUNT_PER[unit];
    if (q !== 0 && Number.isInteger(q)) return { n: q, unit };
  }
  return { n, unit: "" };
}

export const countOf = (n: number, unit: CountUnit): number => n * COUNT_PER[unit];

/** `null` = not a count. Thousands separators are allowed on the way in. */
export function parseCount(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw.trim().replace(/[,_\s]/g, ""));
  if (!m) return null;
  const mult = m[2] ? (m[2].toLowerCase() === "m" ? 1_000_000 : 1000) : 1;
  return Math.round(Number(m[1]) * mult);
}

/** 0.6 → 60%. Rounded to a tenth: 0.6 * 100 is 60.00000000000001 in a double. */
export function fmtPercent(f: number): string {
  return `${Math.round(f * 1000) / 10}%`;
}

/** `null` = not a percentage, or outside the range a fraction of one can hold. */
export function parsePercent(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(raw.trim());
  if (!m) return null;
  const p = Number(m[1]);
  if (p <= 0 || p > 100) return null;
  // Divided, not multiplied: 600 / 1000 is the same double as the literal 0.6,
  // while 60 * 0.01 is not.
  return Math.round(p * 10) / 1000;
}

/** A stored number as the row shows it. */
export function showNumber(value: number, shape?: Shape): string {
  switch (shape) {
    case "ms":
      return fmtDuration(value);
    case "seconds":
      return fmtDuration(value * 1000);
    case "count":
      return fmtCount(value);
    case "percent":
      return fmtPercent(value);
    case undefined:
      return String(value);
  }
}

/**
 * What the row shows back to a stored number. `null` = say so on the row.
 *
 * `current` supplies the unit for a bare number, so typing 30 over `20 min`
 * means thirty minutes and not thirty of whatever the parser felt like.
 */
export function readNumber(raw: string, current: number, shape?: Shape): number | null {
  switch (shape) {
    case "ms":
      return parseDuration(raw, splitDuration(current).unit);
    case "seconds": {
      const ms = parseDuration(raw, splitDuration(current * 1000).unit);
      return ms === null ? null : Math.round(ms / 1000);
    }
    case "count":
      return parseCount(raw);
    case "percent":
      return parsePercent(raw);
    case undefined: {
      const n = Number(raw);
      return raw !== "" && Number.isFinite(n) ? n : null;
    }
  }
}
