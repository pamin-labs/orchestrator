import { expect, test } from "bun:test";
import { needsCredentials, needsGates, needsHostAttention } from "../../web/src/views/settings.tsx";
import { RUNTIMES } from "../../web/src/views/settings/credentials.tsx";
import type { AuthRow, HostCheck } from "../../web/src/views/settings/shared.tsx";

/**
 * The rail's dots are the only thing that tells the boss a setting is waiting on
 * them — a dot that cries wolf, or one missing when a gate is empty, is a
 * settings page nobody trusts.
 */

const rowFor = (runtime: string): AuthRow => ({ runtime, mode: "api_key", hint: "…x", updatedAt: 1 });
const check = (name: string, ok: boolean): HostCheck => ({ name, ok, detail: "" });

test("the account dot is on only while some runtime has no credential", () => {
  expect(needsCredentials(RUNTIMES.map((r) => rowFor(r.key)))).toBe(false);
  expect(needsCredentials(RUNTIMES.slice(1).map((r) => rowFor(r.key)))).toBe(true);
  expect(needsCredentials([])).toBe(true);
});

test("the host dot ignores credential rows — those belong to the account dot", () => {
  expect(needsHostAttention([check("credential:claude", false)])).toBe(false);
  expect(needsHostAttention([check("sandbox-server", false)])).toBe(true);
  expect(needsHostAttention([check("sandbox-server", true)])).toBe(false);
});

test("the gates dot is on only for a project with no gates configured", () => {
  expect(needsGates(null)).toBe(false);
  expect(needsGates({ config: {} })).toBe(true);
  expect(needsGates({ config: { gates: ["build"] } })).toBe(false);
});
