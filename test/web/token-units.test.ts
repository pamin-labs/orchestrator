import { expect, test } from "bun:test";
import { i18n } from "../../web/src/i18n.ts";
import { K } from "../../web/src/shared/format.ts";

/**
 * A token count, in the notation of the language the panel is being read in.
 *
 * It was an `Intl.NumberFormat` of our own pinned to `en-US`, so the header and
 * the `Cost` table printed English notation to all ten readers. `i18n.number` is
 * the same `Intl` reached through the active locale, and the tiers below are a
 * language's own: `1.8M` is not a translation of `183.4万`, it is a different
 * way of writing the same quantity.
 */

// The restore is `setup.ts`'s `beforeEach` now, with the other process-globals:
// this file remembered and the file that leaked did not.

test("a token count never prints in a unit that does not exist", () => {
  i18n.activate("en");
  // The tiers were hand-written and the tier was picked before the rounding, so
  // the last half-percent of each one rolled over inside its own label: 999500
  // came out "1000k" and 999999999 came out "1000M". Both are on the header and
  // the `Cost` table, which is where the boss decides whether to double a budget.
  expect(K(999_500)).toBe("999.5K");
  expect(K(999_999_999)).toBe("1B");
  expect(K(9_999_999)).toBe("10M");

  // 1200 tokens rendered as "1k": rounding to whole thousands threw away a fifth
  // of a number small enough that the fifth is the interesting part.
  expect(K(1200)).toBe("1.2K");
  expect(K(999)).toBe("999");
  expect(K(0)).toBe("0");

  // CLDR's own suffix, not lowercased to match the settings box: `fmtCount`
  // there writes a value that gets typed back in, this is a number that gets read.
  expect(K(272_000)).toBe("272K");
  expect(K(1_834_000)).toBe("1.8M");
});

test("the same count, in the notation each language actually uses", () => {
  // Chinese groups by `万`, not by thousand, so 1200 is below its first tier and
  // 272000 is 27.2 of them. A reader of this panel writes it no other way.
  i18n.activate("zh");
  expect(K(1200)).toBe("1200");
  expect(K(272_000)).toBe("27.2万");
  expect(K(1_834_000)).toBe("183.4万");

  // Russian for the decimal comma as much as for the suffix, and the space
  // before the suffix is the non-breaking one CLDR specifies — a locale can move
  // the separator, the suffix and the space without moving the tier.
  i18n.activate("ru");
  expect(K(1_834_000)).toBe("1,8\u00a0\u043c\u043b\u043d");
});

test("a count that is not a number is zero, in every language", () => {
  // Which used to reach the screen spelled "NaN".
  for (const locale of ["en", "zh"]) {
    i18n.activate(locale);
    expect(K(null)).toBe("0");
    expect(K(undefined)).toBe("0");
    expect(K(Number.NaN)).toBe("0");
  }
});
