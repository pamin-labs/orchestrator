import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadRoles } from "../src/platform/config/load.ts";
import { checkConfig, checkRoles } from "../src/mech/ops/checkconfig.ts";

const yaml = (body: string): string => {
  const f = join(mkdtempSync(join(tmpdir(), "orch-cfg-")), "default.yaml");
  writeFileSync(f, body);
  return f;
};

test("a partial nested block keeps the rest of its defaults", () => {
  // The bug this exists for: `{ ...DEFAULTS, ...parsed }` replaces the whole
  // sandbox block, so naming one field blanks the other seven and the symptom is
  // a container that will not start.
  const cfg = loadConfig(yaml("sandbox:\n  memory: 16Gi\n"));
  expect(cfg.sandbox.memory).toBe("16Gi");
  expect(cfg.sandbox.image).toBe("ghcr.io/pamin-labs/orch-agent:latest");
  expect(cfg.sandbox.ttlSeconds).toBeGreaterThan(0);
});

test("a misspelled key is reported with the one it looks like", () => {
  const { findings } = checkConfig(yaml("maxGroup: 4\n"));
  expect(findings).toHaveLength(1);
  expect(findings[0]!.level).toBe("warn");
  expect(findings[0]!.says).toContain("maxGroups");
});

test("a wrong type refuses the boot rather than travelling", () => {
  const { findings } = checkConfig(yaml('maxGroups: "4"\n'));
  expect(findings[0]!.level).toBe("fatal");
  // A nested one is found too — the walk goes down every block the defaults
  // enumerate.
  expect(checkConfig(yaml("sandbox:\n  ttlSeconds: forever\n")).findings[0]!.level).toBe("fatal");
});

test("zero or negative where only a positive number works is fatal", () => {
  expect(checkConfig(yaml("port: 0\n")).findings[0]!.level).toBe("fatal");
});

test("a key whose type is a union takes either form", () => {
  // leaseSlots is one number for the pool or one per resource tag, and the
  // committed yaml uses the second — the checker called this repo's own config
  // fatal until it knew that.
  expect(checkConfig(yaml("leaseSlots: 2\n")).findings).toEqual([]);
  expect(checkConfig(yaml("leaseSlots:\n  default: 2\n  browser: 1\n")).findings).toEqual([]);
});

test("the committed config passes its own checker", () => {
  expect(checkConfig("config/default.yaml").findings).toEqual([]);
});

test("a role's schema rejects invalid enums before they reach a CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-roles-"));
  writeFileSync(join(dir, "engineer.yaml"), "name: engineer\nprompt: x\neffort: highest\n");
  expect(() => loadRoles(dir)).toThrow("engineer.yaml: invalid role");

  const roles = new Map([["qa", { name: "qa", prompt: "x", runtime: "gemini" }]]);
  const out = checkRoles(roles, ["claude", "codex"]);
  expect(out.map((f) => f.key)).toEqual(["qa.runtime"]);
});
