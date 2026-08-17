import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * A config key nobody copies into `Ctx` is a key that does nothing.
 *
 * This used to read `server.ts` as text and compare a hand-written `config: {}`
 * literal against the loaded config, key by key. That was the only thing that
 * could see the bug, because the whole failure was that the type system was
 * satisfied: `Ctx["config"]` declared its fields optional, so leaving one out of
 * the literal typechecked, and the settings page answered `configured: false`
 * with a perfectly good client id sitting in the yaml. The panel's advice was to
 * go register an app that already existed. Six more keys were missing the same
 * way — `maxTurnsPerJob`, `turnTimeoutMs`, `sessionRotateFraction`,
 * `gateRetries`, `difficultyModel`, `contextWindow` — each reading back as
 * undefined and falling through to a default that looked like a decision.
 *
 * There is no literal now: `ctx.config` **is** the config object. The check is
 * one line, and the class of bug is gone rather than guarded against.
 */
test("ctx.config is the config object, not a copy of the parts someone listed", () => {
  const src = readFileSync(new URL("../../src/composition/server.ts", import.meta.url).pathname, "utf8");
  expect(src).toContain("config: cfg,");
  // The shape that caused it: a literal listing the fields by hand.
  expect(/\n\s*config: \{\n/.test(src)).toBe(false);
});
