import { expect, test } from "bun:test";
import { K } from "../../web/src/shared/format.ts";

test("a token count never prints in a unit that does not exist", () => {
  // The tiers were hand-written and the tier was picked before the rounding, so
  // the last half-percent of each one rolled over inside its own label: 999500
  // came out "1000k" and 999999999 came out "1000M". Both are on the header and
  // the 成本 table, which is where the boss decides whether to double a budget.
  expect(K(999_500)).toBe("999.5k");
  expect(K(999_999_999)).toBe("1B");
  expect(K(9_999_999)).toBe("10M");

  // 1200 tokens rendered as "1k": rounding to whole thousands threw away a fifth
  // of a number small enough that the fifth is the interesting part.
  expect(K(1200)).toBe("1.2k");
  expect(K(999)).toBe("999");
  expect(K(0)).toBe("0");

  // Lowercase k, because units.ts writes the settings rows that way and both
  // sit on the same page.
  expect(K(272_000)).toBe("272k");
  expect(K(1_834_000)).toBe("1.8M");

  // A missing count is 0, and so is one that arrived as NaN — which used to
  // reach the screen spelled "NaN".
  expect(K(null)).toBe("0");
  expect(K(undefined)).toBe("0");
  expect(K(Number.NaN)).toBe("0");
});
