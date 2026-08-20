import { expect, test } from "bun:test";
import { SAY_KEYS, say } from "../../src/platform/text/lang.ts";
import { isChinese } from "../../src/contracts/config.ts";

/**
 * The two tables and the keys callers may name.
 *
 * `EN` used to be annotated `Record<string, string>`, which made `keyof typeof EN`
 * mean `string` — so `say`'s `key` parameter checked nothing, in any caller, ever.
 * And `say` answers an unknown key with `String(key)`: it does not throw and does
 * not log, it puts the literal `wd.stalledd` into the boss's feed.
 *
 * The annotation is gone and the union is real; this file covers what a type cannot.
 */

test("both languages answer every key, with the arguments filled in", () => {
  expect(say("中文", "wd.stalled", { why: "boom" })).toContain("boom");
  expect(say("English", "wd.stalled", { why: "boom" })).toContain("boom");
  // Anything that is not Chinese gets the English row — that is the whole rule,
  // and `output.language` may now be any language at all.
  expect(say("日本語", "gate.pass", { name: "x" })).toBe(say("English", "gate.pass", { name: "x" }));
  expect(say("zh-CN", "gate.pass", { name: "x" })).toBe(say("中文", "gate.pass", { name: "x" }));
  // A unit test builds a Ctx without config; a missing language is not a reason
  // to throw inside a bus.emit.
  expect(() => say(undefined, "gate.pass", {})).not.toThrow();
});

test("no placeholder survives into the boss's feed unfilled", () => {
  // `{name}` reaching the screen is the visible half of the same failure the key
  // check covers: the sentence is there, and the thing it was about is not.
  const args = {
    name: "g1",
    n: 3,
    seq: 2,
    role: "engineer",
    from: "qa",
    file: "a.ts",
    tokens: "8M",
    min: 5,
    at: "18:00",
    resource: "test",
    repo: "o/r",
    files: "a.ts",
    why: "boom",
    pr: 7,
    branch: "b",
  };
  for (const lang of ["中文", "English"]) {
    for (const key of SAY_KEYS) {
      const out = say(lang, key, args);
      expect(out.length).toBeGreaterThan(0);
      // Not `{`, which is what an argument nobody passed leaves behind.
      expect([key, out.includes("{")]).toEqual([key, false]);
    }
  }
});

test("the language test is one predicate, and `en` is not what it answers to", () => {
  // `escalation.ts` asked `language === "en"` while this module asked whether the
  // string starts with 中 or zh. The default is "中文" and the panel offers
  // "English", so that branch was unreachable for every value the setting can hold
  // — the boss reading English got a Chinese prompt, from a comparison that looked
  // deliberate. Free text in, so the test is what the value looks like.
  expect([isChinese("中文"), isChinese("zh"), isChinese("zh-CN"), isChinese("中")]).toEqual([true, true, true, true]);
  // The panel's own suggestion list, which is where the free text usually comes
  // from: `繁體中文` is its second entry and read as English until `localeOf`
  // stopped anchoring the test to the first character.
  expect([isChinese("繁體中文"), isChinese("简体中文"), isChinese("汉语")]).toEqual([true, true, true]);
  expect([isChinese("English"), isChinese("en"), isChinese("日本語"), isChinese(undefined)]).toEqual([
    false,
    false,
    false,
    false,
  ]);
  // And it is the same answer `say` gives, because there is one of it now.
  expect(say("English", "gate.pass", { name: "x" })).toBe(say("fr", "gate.pass", { name: "x" }));
});
