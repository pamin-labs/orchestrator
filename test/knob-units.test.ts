import { expect, test } from "bun:test";
import { settablePaths, defaultFor } from "../src/platform/config/settings.ts";
import { isSettingPath } from "../src/contracts/config.ts";
import {
  KNOB_SHAPE,
  fmtCount,
  fmtDuration,
  fmtPercent,
  parseCount,
  parseDuration,
  parsePercent,
  readNumber,
  showNumber,
  splitDuration,
} from "../web/src/lib/units.ts";

/**
 * The settings page shows `20 分钟` and posts 1200000.
 *
 * This is the one part of that page that can be wrong without looking wrong: a
 * field that reads 20 分钟 and stores 1_200_000.0000001 is refused by the type
 * check on the way in, and one that stores 1_800_000 is accepted and runs the
 * whole fleet on a different number. So every conversion is asserted in both
 * directions, on the values the config actually ships.
 */

test("a duration survives the trip to the screen and back, exactly", () => {
  // Every duration in DEFAULTS, by the name the panel knows it by.
  const shipped = [1_200_000, 10_800_000, 7_200_000, 30_000, 86_400_000];
  for (const ms of shipped) {
    const { n, unit } = splitDuration(ms);
    expect(parseDuration(String(n), unit)).toBe(ms);
    // And what the box actually holds, read back as typed.
    expect(readNumber(fmtDuration(ms), ms, "ms")).toBe(ms);
  }
  // The readings themselves, so a change of unit is a change of this line.
  expect(fmtDuration(1_200_000)).toBe("20 分钟");
  expect(fmtDuration(10_800_000)).toBe("3 小时");
  expect(fmtDuration(7_200_000)).toBe("2 小时");
  expect(fmtDuration(30_000)).toBe("30 秒");
  expect(fmtDuration(0)).toBe("0 秒");
  // Not a whole number of any bigger unit, so it stays honest rather than round.
  expect(fmtDuration(90_500)).toBe("90500 毫秒");
  expect(readNumber("90500 毫秒", 90_500, "ms")).toBe(90_500);
});

test("a bare number keeps the unit on the screen, a suffix overrides it", () => {
  // 1_200_000 shows as `20 分钟`, so typing 30 over it means thirty minutes.
  expect(readNumber("30", 1_200_000, "ms")).toBe(1_800_000);
  // ...and the same box takes 45s, 3h, 2 小时 when the boss wants another unit.
  expect(readNumber("45s", 1_200_000, "ms")).toBe(45_000);
  expect(readNumber("3h", 1_200_000, "ms")).toBe(10_800_000);
  expect(readNumber("2 小时", 1_200_000, "ms")).toBe(7_200_000);
  expect(readNumber("1.5 小时", 1_200_000, "ms")).toBe(5_400_000);
  // Junk is refused rather than turned into NaN or zero.
  expect(readNumber("", 1_200_000, "ms")).toBeNull();
  expect(readNumber("soon", 1_200_000, "ms")).toBeNull();
  expect(readNumber("20 光年", 1_200_000, "ms")).toBeNull();
});

test("the sandbox TTL is stored in seconds and still reads in hours", () => {
  // 86400 seconds. The one knob on the page whose unit is not milliseconds; a
  // shared helper that forgot it would silently make the sandbox live 1000x too
  // long, which is a bill rather than an error message.
  expect(showNumber(86_400, "seconds")).toBe("24 小时");
  expect(readNumber("24 小时", 86_400, "seconds")).toBe(86_400);
  expect(readNumber("30 分钟", 86_400, "seconds")).toBe(1800);
  expect(readNumber("12", 86_400, "seconds")).toBe(43_200);
});

test("token counts round-trip, including the tiers and every context window", () => {
  const shipped = [8_000_000, 20_000_000, 30_000_000, 200_000, 1_000_000, 272_000, 16_000, 45, 0];
  for (const n of shipped) expect(parseCount(fmtCount(n))).toBe(n);
  expect(fmtCount(8_000_000)).toBe("8M");
  expect(fmtCount(272_000)).toBe("272k");
  expect(fmtCount(16_000)).toBe("16k");
  expect(fmtCount(1_500_000)).toBe("1.5M");
  expect(fmtCount(45)).toBe("45");
  // Typed by hand, in any of the spellings a person uses for these.
  expect(parseCount("8m")).toBe(8_000_000);
  expect(parseCount("1,000,000")).toBe(1_000_000);
  expect(parseCount("0.5M")).toBe(500_000);
  expect(parseCount("")).toBeNull();
  expect(parseCount("lots")).toBeNull();
});

test("the rotation fraction is a percentage on the screen and a fraction underneath", () => {
  // 0.6 * 100 is 60.00000000000001 in a double, and 60 * 0.01 is not 0.6.
  expect(fmtPercent(0.6)).toBe("60%");
  for (const f of [0.6, 0.5, 0.75, 0.85, 0.333, 1]) expect(parsePercent(fmtPercent(f))).toBe(f);
  expect(parsePercent("60")).toBe(0.6);
  // A fraction of one cannot be 0 or 140, and saying so beats storing it.
  expect(parsePercent("0")).toBeNull();
  expect(parsePercent("140")).toBeNull();
  expect(parsePercent("half")).toBeNull();
});

test("every duration knob the server offers has a unit on the page", () => {
  // The check that makes the table above maintainable rather than a snapshot: a
  // knob named `somethingMs` that nobody added to KNOB_SHAPE renders as seven
  // digits, which is the bug this whole file exists to prevent.
  const missing = [...settablePaths()]
    .filter(([path, type]) => type === "number" && /(Ms|Seconds|Fraction)$/.test(path.split(".").at(-1)!))
    .filter(([path]) => !KNOB_SHAPE[path])
    .map(([path]) => path);
  expect(missing).toEqual([]);

  // And every shape matches a default that is really a number.
  for (const path of Object.keys(KNOB_SHAPE).filter(isSettingPath)) {
    const value = defaultFor(path);
    expect(typeof value).toBe("number");
    if (typeof value !== "number") throw new Error(`${path} is not numeric`);
    expect(showNumber(value, KNOB_SHAPE[path])).not.toContain("NaN");
  }
});
