import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadRoles, modelFor } from "../src/config.ts";

test("the shipped roles all parse and declare what the runtime needs", () => {
  const roles = loadRoles("roles");
  for (const name of ["dispatcher", "pm", "engineer", "qa", "auditor"]) {
    const r = roles.get(name);
    expect(r).toBeDefined();
    expect(r!.prompt.length).toBeGreaterThan(50);
    expect(["L1", "L2"]).toContain(r!.clearance);
  }
});

test("only the engineer is allowed to be a writer", () => {
  const roles = loadRoles("roles");
  // One writer per group is what makes the scheduler's per-group serialisation
  // equivalent to "no write conflicts".
  expect(roles.get("engineer")!.clearance).toBe("L1");
  expect(roles.get("qa")!.prompt).toContain("Do NOT read the Engineer's self-review");
});

test("adding a role is a file, not a code change", () => {
  // Assert the property, not the current roster: nothing in the loader
  // enumerates known names, so an unfamiliar yaml simply appears.
  const dir = mkdtempSync(join(tmpdir(), "orch-roles-"));
  writeFileSync(
    join(dir, "composer.yaml"),
    "name: composer\nclearance: L1\ntier: hard\nprompt: |\n  You write music.\n",
  );
  const roles = loadRoles(dir);
  expect([...roles.keys()]).toEqual(["composer"]);
  expect(roles.get("composer")!.tier).toBe("hard");

  // And the shipped roster is whatever is on disk, not a hardcoded list.
  expect(loadRoles("roles").size).toBeGreaterThanOrEqual(5);
});

test("config falls back to defaults when the file is missing", () => {
  const cfg = loadConfig("config/does-not-exist.yaml");
  expect(cfg.maxGroups).toBe(10);
  expect(cfg.workRoot.startsWith("/tmp")).toBe(true);
});

test("the shipped config keeps worktrees outside $HOME", () => {
  const cfg = loadConfig("config/default.yaml");
  // The sandbox is deny-only, so denying $HOME is how writes get confined.
  expect(cfg.workRoot).not.toContain(process.env.HOME ?? "/Users");
});

test("difficulty picks the model, and a role may pin one", () => {
  const cfg = loadConfig("config/default.yaml");
  const eng = { name: "engineer", clearance: "L1" as const, prompt: "x" };
  expect(modelFor(cfg, eng, "trivial")).toBe(cfg.difficultyModel.trivial);
  expect(modelFor(cfg, eng, "hard")).toBe(cfg.difficultyModel.hard);
  // No tag falls back to normal rather than to the most expensive tier.
  expect(modelFor(cfg, eng, null)).toBe(cfg.difficultyModel.normal);

  const dispatcher = loadRoles("roles").get("dispatcher")!;
  expect(modelFor(cfg, dispatcher, "trivial")).toBe(cfg.difficultyModel.hard);
});

test("a role may name a concrete model id and it is used verbatim", () => {
  const cfg = loadConfig("config/default.yaml");
  const pinned = { name: "x", clearance: "L1" as const, prompt: "p", model: "claude-haiku-4-5-20251001" };
  // A pinned id wins over both tier and difficulty — no accidental promotion.
  expect(modelFor(cfg, pinned, "hard")).toBe("claude-haiku-4-5-20251001");
  expect(modelFor(cfg, { ...pinned, tier: "hard" }, "trivial")).toBe("claude-haiku-4-5-20251001");
});

test("the Dispatcher prompt carries the concrete bad-split example", () => {
  const d = loadRoles("roles").get("dispatcher")!.prompt;
  // Abstract advice ("slices must be independent") produced three steps of one
  // change on a real run. The anti-example is the part that teaches.
  expect(d).toContain("切片 : 补充测试用例");
  expect(d).toContain("ONE");
  expect(d).toContain("Padding to three is worse");
});
