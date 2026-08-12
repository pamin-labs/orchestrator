import { expect, test } from "bun:test";
import { loadConfig, loadRoles, modelFor } from "../src/config.ts";

test("the shipped roles all parse and declare what the runtime needs", () => {
  const roles = loadRoles("roles");
  for (const name of ["dispatcher", "pm", "engineer", "qa"]) {
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
  const roles = loadRoles("roles");
  const before = roles.size;
  expect(before).toBeGreaterThanOrEqual(4);
  // Nothing in loadRoles enumerates known names — a new yaml just appears.
  expect([...roles.keys()].sort()).toEqual(["dispatcher", "engineer", "pm", "qa"]);
});

test("config falls back to defaults when the file is missing", () => {
  const cfg = loadConfig("config/does-not-exist.yaml");
  expect(cfg.maxGroups).toBe(3);
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
