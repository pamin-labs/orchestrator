import { describe, expect, test } from "bun:test";
import { needsCredentials, needsGates, needsHostAttention } from "../../web/src/features/settings/view.tsx";
import { RUNTIMES } from "../../web/src/features/settings/credentials.tsx";
import type { AuthRow, HostCheck } from "../../web/src/features/settings/auth.tsx";

/**
 * The rail's dots are the only thing that tells the boss a setting is waiting on
 * them — a dot that cries wolf, or one missing when a gate is empty, is a
 * settings page nobody trusts.
 */

const rowFor = (runtime: string): AuthRow => ({ runtime, mode: "api_key", hint: "…x", updatedAt: 1 });
const check = (name: string, ok: boolean): HostCheck => ({ name, ok, detail: "" });

/**
 * Which input lit the dot is the missing half of `expected false, received true`,
 * so every case states it in its own name.
 */
describe("the account dot is on only while some runtime has no credential", () => {
  test.each([
    ["every runtime configured leaves it dark", RUNTIMES.map((r) => rowFor(r.key)), false],
    ["one runtime missing lights it", RUNTIMES.slice(1).map((r) => rowFor(r.key)), true],
    ["nothing stored at all lights it", [], true],
  ])("%s", (_case, rows, lit) => {
    expect(needsCredentials(rows)).toBe(lit);
  });
});

describe("the host dot ignores credential rows — those belong to the account dot", () => {
  test.each([
    ["a failing credential check is not the host's", check("credential:claude", false), false],
    ["a failing host check lights it", check("sandbox-server", false), true],
    ["a passing host check leaves it dark", check("sandbox-server", true), false],
  ])("%s", (_case, row, lit) => {
    expect(needsHostAttention([row])).toBe(lit);
  });
});

describe("the gates dot is on only for a project with no gates configured", () => {
  test.each([
    ["no project selected", null, false],
    ["a project with no gates", { config: {} }, true],
    ["a project with gates", { config: { gates: ["build"] } }, false],
  ])("%s", (_case, project, lit) => {
    expect(needsGates(project)).toBe(lit);
  });
});
