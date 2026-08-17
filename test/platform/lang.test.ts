import { expect, test } from "bun:test";
import { SAY_KEYS, say } from "../../src/platform/text/lang.ts";

/**
 * The two tables and the keys callers may name.
 *
 * `EN` used to be annotated `Record<string, string>`, which made
 * `keyof typeof EN` mean `string` — so `say`'s `key` parameter checked nothing,
 * in any caller, ever. That matters because `say` answers an unknown key with
 * `String(key)`: it does not throw and does not log, it puts the literal
 * `wd.stalledd` into the boss's feed where the sentence explaining why a group
 * stopped was supposed to be. The annotation is gone and the union is real, so
 * a typo is a compile error — this file covers what a type cannot.
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
