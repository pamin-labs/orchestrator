import { expect, test } from "bun:test";
import { settablePaths, defaultFor } from "../../src/platform/config/settings.ts";
import { COPY, KNOBS_ELSEWHERE, SECTIONS } from "../../web/src/features/knobs/view.tsx";
import {
  COUNT_UNITS,
  countOf,
  DURATION_UNITS,
  PER,
  readNumber,
  shapeOf,
  splitCount,
  splitDuration,
  unitLabel,
} from "../../web/src/features/knobs/units.ts";
import { i18n } from "../../web/src/i18n.ts";

/**
 * The settings page shows `20` beside `分钟` and posts 1200000.
 *
 * This is the one part of that page that can be wrong without looking wrong: a
 * field that reads 20 `min` and stores 1_200_000.0000001 is refused by the type
 * check on the way in, and one that stores 1_800_000 is accepted and runs the
 * whole fleet on a different number. So every conversion is asserted in both
 * directions, on the values the config actually ships.
 */

test("a duration survives the trip to the screen and back, exactly", () => {
  // Every duration in DEFAULTS, by the name the panel knows it by.
  const shipped = [1_200_000, 10_800_000, 7_200_000, 30_000, 86_400_000, 604_800_000];
  for (const ms of shipped) {
    const { n, unit } = splitDuration(ms);
    // The two controls the row actually has: a digits box and a unit beside it.
    expect(n * PER[unit]).toBe(ms);
    expect(Number.isInteger(n)).toBe(true);
  }
  // The units themselves, so a change of unit is a change of this line. Whole,
  // not nearest: 90 minutes stays 90 minutes rather than becoming 1.5 hours.
  expect(splitDuration(1_200_000)).toEqual({ n: 20, unit: "minute" });
  expect(splitDuration(10_800_000)).toEqual({ n: 3, unit: "hour" });
  expect(splitDuration(604_800_000)).toEqual({ n: 7, unit: "day" });
  expect(splitDuration(5_400_000)).toEqual({ n: 90, unit: "minute" });
  // Zero is a whole number of days too, and reads as seconds.
  expect(splitDuration(0)).toEqual({ n: 0, unit: "second" });
  // Nothing divides evenly, so it stays in the unit that keeps the number.
  expect(splitDuration(90_500)).toEqual({ n: 90_500, unit: "millisecond" });
});

/**
 * The unit beside the digits is CLDR's word, not a catalogue row of ours.
 *
 * Five `msg` descriptors and fifty translated lines used to say what `Intl`
 * already prints beside every other number on the page — fifty chances for the
 * settings row to spell an hour differently from the cost chart.
 */
test("a unit is spelled the way the reader's language spells it", () => {
  const was = i18n.locale;
  // `loadAndActivate` with an empty catalogue, not `activate`: nothing here
  // reads a message — `unitLabel` reads `i18n.locale` and asks CLDR — and
  // `activate` on a locale with no catalogue loaded warns about exactly that.
  const speak = (locale: string) => i18n.loadAndActivate({ locale, messages: {} });
  try {
    speak("zh");
    expect(DURATION_UNITS.map(unitLabel)).toEqual(["天", "小时", "分钟", "秒", "毫秒"]);
    speak("en");
    expect(DURATION_UNITS.map(unitLabel)).toEqual(["day", "hr", "min", "sec", "ms"]);
    speak("de");
    expect(unitLabel("hour")).toBe("Std.");
  } finally {
    i18n.activate(was);
  }
});

test("token counts split into a whole number and a tier", () => {
  const shipped = [8_000_000, 20_000_000, 30_000_000, 200_000, 1_000_000, 272_000, 16_000, 45, 0];
  for (const n of shipped) {
    const split = splitCount(n);
    expect(countOf(split.n, split.unit)).toBe(n);
    expect(Number.isInteger(split.n)).toBe(true);
  }
  expect(splitCount(8_000_000)).toEqual({ n: 8, unit: "M" });
  expect(splitCount(272_000)).toEqual({ n: 272, unit: "k" });
  // 8.5 is not something an integer field can hold or a spinner can step, so
  // the tier drops rather than the number gaining a decimal point.
  expect(splitCount(8_500_000)).toEqual({ n: 8500, unit: "k" });
  expect(splitCount(45)).toEqual({ n: 45, unit: "" });
  expect(COUNT_UNITS).toEqual(["", "k", "M"]);
});

/**
 * The one row that is still free text: a bare number with no unit at all.
 *
 * The four shaped rows each return their own editor before the text box is
 * reached, which is why `readNumber` no longer takes a shape — and why
 * `parseDuration`, `parseCount`, `parsePercent` and the alias table behind them
 * were deleted rather than translated.
 */
test("a plain number row takes digits and refuses everything else", () => {
  expect(readNumber("45")).toBe(45);
  expect(readNumber("1.5")).toBe(1.5);
  expect(readNumber("")).toBeNull();
  expect(readNumber("soon")).toBeNull();
  expect(readNumber("20 光年")).toBeNull();
});

/**
 * The suffix rule answers for every numeric knob the server offers.
 *
 * This used to compare a twenty-six-row table against this regex — the rule
 * written twice, once as a rule and once as a transcript of it. `shapeOf` is the
 * rule, so what is left to assert is that the rule is *complete*: no numeric
 * knob ends in a duration-shaped suffix without getting a unit, and every path
 * the rule does answer for is really a number.
 */
test("every numeric knob whose name says it is a duration gets a unit", () => {
  const numeric = [...settablePaths()].filter(([, type]) => type === "number");

  // The failure this whole file exists to prevent: a knob named `somethingMs`
  // rendered as seven digits.
  const unshaped = numeric.filter(([path]) => !shapeOf(path)).map(([path]) => path);
  expect(unshaped.filter((path) => /(Ms|Seconds|Fraction|Chars)$/.test(path))).toEqual([]);

  // And nothing the rule answers for is anything but a finite number.
  for (const [path] of numeric.filter(([path]) => shapeOf(path))) {
    const value = defaultFor(path);
    expect(typeof value).toBe("number");
    if (typeof value !== "number") throw new Error(`${path} is not numeric`);
    expect(Number.isFinite(value)).toBe(true);
  }

  // The rule itself, on names rather than on the config — so it is still a check
  // when a knob is renamed, and so this line fails if a suffix is dropped.
  expect(shapeOf("turnTimeoutMs")).toBe("ms");
  expect(shapeOf("sandbox.ttlSeconds")).toBe("seconds");
  expect(shapeOf("sessionRotateFraction")).toBe("percent");
  expect(shapeOf("ctxBudgetChars")).toBe("count");
  // A knob that is the plain number it looks like gets no unit, which is right.
  expect(shapeOf("maxGroups")).toBeUndefined();
});

/**
 * `shapeOf` reads a name, and one name in the config is not a scalar.
 *
 * `intervals.notifyBackoffMs` is `z.array(count)` — a reminder ladder — so the
 * suffix answers `ms` for it where the old table, keyed by path, simply had no
 * row. It is unreachable: `scalarValue` sends only `type === "number"` to
 * `numberValue`, which is the one caller. Pinned rather than explained, because
 * the day an array editor wants a unit is the day this line has to be read.
 */
test("the suffix answers for a path no number editor ever asks about", () => {
  expect(shapeOf("intervals.notifyBackoffMs")).toBe("ms");
  expect([...settablePaths()].find(([path]) => path === "intervals.notifyBackoffMs")?.[1]).toBe("array");
});

test("every settable knob appears in a section, or the settings page cannot draw it", () => {
  // `SECTIONS` is a hand-written path list, which is the shape this branch has
  // already paid for once with role names: a list nobody extends silently drops
  // what it does not mention. Thirteen keys landed settable through the API and
  // invisible on the page, which is a control the boss cannot find.
  const placed = new Set(Object.values(SECTIONS).flatMap((s) => s.groups.flatMap((g) => g.paths)));
  const missing = [...settablePaths()]
    .map(([path]) => path)
    .filter((path) => !placed.has(path) && !KNOBS_ELSEWHERE.has(path));
  expect(missing).toEqual([]);
});

test("every knob a section draws has a human label, and no knob has two controls", () => {
  // What the boss actually reported: `intervals.notifyBackoffMs` on the page as
  // its own dotted path beside a raw number box. `copyFor` falls back to the path
  // when `COPY` has no row, so a knob added to a section and forgotten here is
  // invisible as a defect to everything except a person reading the pane —
  // thirty-five of them were.
  const placed = Object.values(SECTIONS).flatMap((s) => s.groups.flatMap((g) => g.paths));
  expect(placed.filter((path) => !COPY[path])).toEqual([]);

  // The other half of the same complaint: a value drawn twice, once by the
  // control built for it and once by the generic row. A path in both lists is
  // that bug, and it shipped as `embedding.model` under a picker already showing
  // the same string.
  expect(placed.filter((path) => KNOBS_ELSEWHERE.has(path))).toEqual([]);
  // A section listing the same path twice draws it twice, with two React keys
  // that are equal.
  expect(placed.length).toBe(new Set(placed).size);

  // And nothing is excused that the server never offered: a typo in
  // KNOBS_ELSEWHERE excuses a path that does not exist while the real one stays
  // undrawn, which is the coverage check above passing over a hole.
  const settable = new Set<string>([...settablePaths()].map(([path]) => path));
  expect([...KNOBS_ELSEWHERE].filter((path) => !settable.has(path))).toEqual([]);
});
