import { afterEach, expect, test } from "bun:test";
import { list } from "../../web/src/shared/format.ts";
import { i18n } from "../../web/src/i18n.ts";

/**
 * A row of names carries a conjunction, and no separator of ours can supply it.
 *
 * Six call sites wrote `names.join(t`, `)`, which made `", "` a catalogue row
 * translated nine times — and still produced `a, b, c` in every one of them.
 * `Intl.ListFormat` is where CLDR keeps both halves: the separator *and* the
 * word each language puts before the last name.
 */

afterEach(() => {
  i18n.activate("zh");
});

test("the separator and the conjunction both follow the reader's language", () => {
  const names = ["alpha", "beta", "gamma"];

  i18n.activate("en");
  // The conjunction is the half a join can never produce.
  expect(list(names)).toBe("alpha, beta, and gamma");

  i18n.activate("zh");
  // Chinese uses the enumeration comma and glues `和` on with no space.
  expect(list(names)).toBe("alpha、beta和gamma");

  i18n.activate("de");
  expect(list(names)).toBe("alpha, beta und gamma");

  i18n.activate("es");
  expect(list(names)).toBe("alpha, beta y gamma");
});

/**
 * `type: "unit"` is not the mode for a plain enumeration, whatever it reads like.
 *
 * It is for measurement — `3 ft 7 in` — so CLDR gives `zh` and `ja` no separator
 * at all. Pinned here because "drop the conjunction" is the obvious next request
 * and this is the measurement that answers it: there is no CLDR mode meaning
 * "the reader's separators, no conjunction" in every language. A run of paths is
 * data and joins itself.
 */
test("there is no CLDR mode for separators without a conjunction", () => {
  const items = ["a", "b", "c"];
  expect(new Intl.ListFormat("zh", { type: "unit" }).format(items)).toBe("abc");
  expect(new Intl.ListFormat("ja", { type: "unit" }).format(items)).toBe("a b c");
  // And narrow only drops it where the language separates with a comma anyway.
  expect(new Intl.ListFormat("zh", { type: "conjunction", style: "narrow" }).format(items)).toBe("a、b和c");
});

test("one name is that name, and none is the empty string", () => {
  i18n.activate("en");
  expect(list(["alpha"])).toBe("alpha");
  expect(list([])).toBe("");
});
