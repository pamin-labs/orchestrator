import { expect, test } from "bun:test";
import { ROOT } from "../src/config.ts";

/**
 * `typecheck` is one of the project's gates, and nothing here ran it.
 *
 * `bun test` does not typecheck, so main carried thirty type errors — including
 * two real ones — while every check was green. Every group's gate went red on
 * them, three times each, and each group read that as its own failure and rewrote
 * its own code. A gate the boss's own loop never runs is a gate that only ever
 * fails other people.
 */
test("the project typechecks, because the gate says so", async () => {
  const r = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", "."], { cwd: ROOT });
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  expect(out.split("\n").filter((l) => l.includes("error TS")).slice(0, 20).join("\n")).toBe("");
}, 120_000);
