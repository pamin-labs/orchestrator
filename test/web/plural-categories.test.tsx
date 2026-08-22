import { afterEach, expect, test } from "bun:test";
import { i18n } from "../../web/src/i18n.ts";
import { messages } from "../../locales/ru.po";

/**
 * Russian has four plural categories where English has two, and the boundaries
 * are not where a reader of English would guess: 11 takes the same form as 5,
 * while 21 takes the same form as 1.
 *
 * The catalogs carry `few` and `many` branches the source never had. Nothing
 * else checks they reach the screen — `i18n:validate` compares placeholder
 * names, and the branch count is allowed to differ per language, which is the
 * whole point of ICU.
 */
const SLICES = "6bwnTR";

afterEach(() => i18n.activate("zh"));

test("a Russian plural picks one, few and many at the CLDR boundaries", () => {
  i18n.load("ru", messages);
  i18n.activate("ru");
  const of = (n: number) => String(i18n._(SLICES, { n }));

  // 1 and 21 are `one`; 111 is not, because 11 governs it.
  expect(of(1)).toBe("1 срез");
  expect(of(21)).toBe("21 срез");
  // 2–4 and 22–24 are `few`.
  expect(of(2)).toBe("2 среза");
  expect(of(22)).toBe("22 среза");
  // 5–20 are `many`, and so is every teen — 11 is the one English speakers miss.
  expect(of(5)).toBe("5 срезов");
  expect(of(11)).toBe("11 срезов");
  expect(of(111)).toBe("111 срезов");
});
