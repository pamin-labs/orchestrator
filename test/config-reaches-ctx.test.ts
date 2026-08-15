import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";

/**
 * A config key nobody copies into `Ctx` is a key that does nothing.
 *
 * `ctx.config` is a hand-written literal in `server.ts`, not the config object —
 * deliberately, so a handler cannot reach for whatever it likes. The cost is that
 * adding a key is two edits, and the second one is invisible when it is missed:
 * `Ctx["config"]` declared `github?` as optional, so leaving it out of the
 * literal typechecked, and the settings page answered `configured: false` with a
 * perfectly good client id sitting in the yaml. The panel's advice was to go
 * register an app that already existed.
 *
 * Reading `server.ts` as text is crude and it is the only thing that can see this
 * — the whole failure is that the type system is satisfied.
 */
test("every config key a handler can read is one the server copies in", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url).pathname, "utf8");
  // The literal, from `config: {` to the line that closes it.
  const block = /\n    config: \{\n([\s\S]*?)\n    \},/.exec(src)?.[1];
  expect(block).toBeTruthy();
  const copied = new Set([...block!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!));

  // Keys that exist to configure something other than a request handler, so they
  // are legitimately absent. Anything else in the config is either reachable or a
  // key that silently does nothing.
  const notForHandlers = new Set([
    "workRoot", "indexModel", "turnTimeoutMs", "parkAfterPausedMs", "digestEveryMs",
    "notify", "gates", "roles", "output", "budget", "review", "watchdog", "prompt",
  ]);

  const missing = Object.keys(loadConfig()).filter((k) => !copied.has(k) && !notForHandlers.has(k));
  // Not an equality assertion: this file should not have to be edited every time
  // a key is added for the scheduler or the watchdog. It fails only when a key is
  // added to the config and to `Ctx`, and then not wired.
  // `config?.` as well as `config.`, and that is not a detail: every handler
  // reaching into an optional field writes the optional chain, so matching only
  // the dotted form made this guard blind to precisely the code it exists to
  // watch. It missed `leaseTimeoutMs` — read as `ctx.config?.leaseTimeoutMs`,
  // never copied in, silently falling back to a three-hour default on the one
  // deadline that stops an agent waiting forever.
  expect(missing.filter((k) => new RegExp(`config\\??\\.${k}\\b`).test(readFileSync(
    new URL("../src/api.ts", import.meta.url).pathname, "utf8",
  )))).toEqual([]);
});
