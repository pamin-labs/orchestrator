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

/**
 * A settable key nothing names is worse than a literal.
 *
 * A literal is honest — somebody has to edit code to change it. A knob the
 * settings page offers while no source mentions it is a control the boss turns
 * while nothing happens and nothing reports it.
 *
 * It checks the name is *reached*, not that a particular call site passes it: the
 * second is what a reviewer does, and a test that tried would be a list of call
 * sites drifting out of date one wire at a time.
 */
test("every timeout and interval the settings page offers reaches a call site", () => {
  const defaults = readFileSync(new URL("../../src/platform/config/load.ts", import.meta.url).pathname, "utf8");
  // The whole of `src`, not a list of files: a list is a second thing to maintain,
  // and the first key it forgets reads as unwired when it is merely elsewhere —
  // which this check did on its first run, against a key `sandbox.ts` reads.
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "src"], { stdout: "pipe" });
  expect(listed.exitCode).toBe(0);
  const wiring = listed.stdout
    .toString()
    .split("\0")
    .filter((path) => path.endsWith(".ts") && !path.includes("/config/") && !path.includes("/contracts/"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

  // The keys, from the defaults rather than a list here: a block that grows gets
  // covered by existing, which is the only way this stays true.
  const block = (name: string): string[] => {
    const start = defaults.indexOf(`  ${name}: {`);
    if (start < 0) throw new Error(`no ${name} block in DEFAULTS`);
    const end = defaults.indexOf("\n  },", start);
    return [...defaults.slice(start, end).matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]!);
  };

  const unread = [...block("timeouts"), ...block("intervals")].filter((key) => !wiring.includes(key));
  expect(unread).toEqual([]);
});
