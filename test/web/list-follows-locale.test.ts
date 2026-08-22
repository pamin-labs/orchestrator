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
 * It is for measurement — `3 ft 7 in` — so CLDR gives `zh` no separator at all
 * and `ja` a space. Pinned because "drop the conjunction" is the obvious next
 * request, and this is the measurement that answers it.
 */
/**
 * `style: "narrow"` is the other thing that looks like an answer, and it is not
 * asserted here on purpose: it moves with the runtime's ICU data. Measured on
 * the same commit — Bun 1.3.14 on macOS renders `zh` narrow as `a、b和c`, the
 * Linux runner as `a、b、c`. A first cut of this file asserted the macOS answer
 * and went red on CI. Whatever else it is, a mode whose output depends on which
 * machine ran it is not one to build a rendering rule on.
 */
test('`type: "unit"` is measurement, not a list', () => {
  const items = ["a", "b", "c"];
  expect(new Intl.ListFormat("zh", { type: "unit" }).format(items)).toBe("abc");
  expect(new Intl.ListFormat("ja", { type: "unit" }).format(items)).toBe("a b c");
});

test("one name is that name, and none is the empty string", () => {
  i18n.activate("en");
  expect(list(["alpha"])).toBe("alpha");
  expect(list([])).toBe("");
});
