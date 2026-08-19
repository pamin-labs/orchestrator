import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * A config key nobody copies into `Ctx` is a key that does nothing.
 *
 * The whole failure was that the type system was satisfied: `Ctx["config"]`
 * declared its fields optional, so leaving one out of a hand-written literal
 * typechecked, and the settings page answered `configured: false` over a perfectly
 * good client id in the yaml — advising the boss to register an app that already
 * existed. Six more keys were missing the same way, each falling through to a
 * default that looked like a decision.
 */
/**
 * There is no literal now: `ctx.config` **is** the config object. The check is one
 * line, and the class of bug is gone rather than guarded against.
 */
test("ctx.config is the config object, not a copy of the parts someone listed", () => {
  const src = readFileSync(new URL("../../src/composition/server.ts", import.meta.url).pathname, "utf8");
  expect(src).toContain("config: cfg,");
  // The shape that caused it: a literal listing the fields by hand.
  expect(/\n\s*config: \{\n/.test(src)).toBe(false);
});
