import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  MAX_CONTEXT,
  MIN_CONTEXT,
  contextWindowFor,
  loadConfig,
  loadRoles,
  modelFor,
  withAbsoluteDataDir,
} from "../src/config.ts";

test("the shipped roles all parse and declare what the runtime needs", () => {
  const roles = loadRoles("roles");
  for (const name of ["dispatcher", "pm", "engineer", "qa", "auditor"]) {
    const r = roles.get(name);
    expect(r).toBeDefined();
    expect(r!.prompt.length).toBeGreaterThan(50);
    expect(["L1", "L2"]).toContain(r!.clearance);
  }
});

test("dataDir is absolute, because subprocesses run somewhere else", () => {
  // The clearance profile goes to `claude --settings`, and that process runs in
  // the group's worktree. A relative "data/profiles/N-L2.json" resolved there, and
  // every turn inside a worktree died with "Settings file not found" while
  // planning roles (cwd = repo root) went on working.
  expect(isAbsolute(loadConfig().dataDir)).toBe(true);
  expect(isAbsolute(withAbsoluteDataDir({ ...loadConfig(), dataDir: "data" }).dataDir)).toBe(true);
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
  // Outside $HOME, because the sandbox is deny-only — and under /var/tmp rather
  // than /tmp, which macOS empties at boot and sweeps after three days. A
  // worktree holds commits on a branch nobody has pushed.
  expect(cfg.workRoot.startsWith("/var/tmp")).toBe(true);
  expect(cfg.workRoot.startsWith(process.env.HOME ?? "~")).toBe(false);
});

test("the shipped config keeps worktrees outside $HOME", () => {
  const cfg = loadConfig("config/default.yaml");
  // The sandbox is deny-only, so denying $HOME is how writes get confined.
  expect(cfg.workRoot).not.toContain(process.env.HOME ?? "/Users");
});

test("difficulty picks the model, and a role may pin one", () => {
  const cfg = loadConfig("config/default.yaml");
  const eng = { name: "engineer", clearance: "L1" as const, prompt: "x" };
  expect(modelFor(cfg, eng, "trivial")).toBe(cfg.difficultyModel.claude!.trivial!);
  expect(modelFor(cfg, eng, "hard")).toBe(cfg.difficultyModel.claude!.hard!);
  // No tag falls back to normal rather than to the most expensive tier.
  expect(modelFor(cfg, eng, null)).toBe(cfg.difficultyModel.claude!.normal!);

  const dispatcher = loadRoles("roles").get("dispatcher")!;
  expect(modelFor(cfg, dispatcher, "trivial")).toBe(cfg.difficultyModel.claude!.hard!);
});

test("the runtime picks the model table, so codex never gets a claude id", () => {
  const cfg = loadConfig("config/default.yaml");
  const onCodex = { name: "x", clearance: "L1" as const, prompt: "p", runtime: "codex" as const };
  // `codex exec -m claude-sonnet-5` is rejected outright, which is what a
  // runtime: codex role got before the table was split.
  expect(modelFor(cfg, onCodex, "hard")).toBe(cfg.difficultyModel.codex!.hard!);
  expect(modelFor(cfg, onCodex, "trivial")).toBe(cfg.difficultyModel.codex!.trivial!);
  expect(modelFor(cfg, onCodex, "hard")).not.toContain("claude");
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

test("unattended is the default: approved buys a night of work", () => {
  const cfg = loadConfig("config/does-not-exist.yaml");
  // With autoAdvance off a group did exactly one slice and then waited until morning,
  // which defeats the reason the system exists. The slice still waits to be accepted;
  // only the next one stops waiting.
  expect(cfg.autoAdvance).toBe(true);
  // trivial only. Self-review, reconcile, the gate and an independent QA all still run
  // on it — this skips the fifth layer, the boss's own look, on the tier where that
  // look is worth least.
  expect(cfg.autoAcceptTiers).toEqual(["trivial"]);
  expect(cfg.autoAcceptTiers).not.toContain("normal");
  expect(cfg.autoAcceptTiers).not.toContain("hard");
});

test("ctxBudgetChars actually reaches the thing it configures", () => {
  // It was a setting that read back as itself and changed nothing: `orch ctx query`
  // used the module default because nobody passed the config value in. A knob that
  // does nothing is worse than no knob — it reads as tried.
  const cfg = loadConfig("config/does-not-exist.yaml");
  expect(cfg.ctxBudgetChars).toBeGreaterThan(0);
  const wired = readFileSync("src/server.ts", "utf8");
  expect(wired).toContain("ctxBudgetChars: cfg.ctxBudgetChars");
  expect(readFileSync("src/api.ts", "utf8")).toContain("ctx.config.ctxBudgetChars");
});

test("a reviewer does not get the writer's tool budget", () => {
  // Measured over 259 turns: tool results are 90% of everything in a transcript,
  // and every round re-reads all of them. One cap for every role has to be the
  // engineer's, and the reviewers spend it going through the repo — which is the
  // one thing QA is defined not to do.
  const roles = loadRoles();
  expect(roles.get("qa")!.maxTurns).toBe(20);
  expect(roles.get("auditor")!.maxTurns).toBe(20);
  // The Engineer keeps the global cap: a test-fix loop is what rounds are for.
  expect(roles.get("engineer")!.maxTurns).toBeUndefined();
});

test("the rotation denominator is the model's own window, clamped", () => {
  const cfg = loadConfig("config/default.yaml");
  // Read off this repo's own turn logs: haiku-4-5 reports 200k, sonnet-5 and
  // opus-5 report 1M, codex reports 272k for gpt-5.6. The denominator used to be
  // a literal 200_000 for all of them, so the strong models rotated at 12% of
  // their window and threw away a cached prefix each time.
  expect(contextWindowFor(cfg, "claude-opus-5")).toBe(1_000_000);
  expect(contextWindowFor(cfg, "gpt-5.6-sol")).toBe(272_000);
  // A model nobody listed still gets a usable number rather than a crash.
  expect(contextWindowFor(cfg, "some-model-shipped-next-week")).toBe(cfg.contextWindow.default!);

  // What the CLI reported during the turn wins: a table goes stale, the stream
  // does not.
  expect(contextWindowFor(cfg, "claude-opus-5", 250_000)).toBe(250_000);

  // And the clamp holds either side, so a zero or a shape change cannot produce a
  // session that never rotates or one that rotates every turn.
  expect(contextWindowFor(cfg, "claude-opus-5", 0)).toBe(1_000_000);
  expect(contextWindowFor(cfg, "x", 5)).toBe(MIN_CONTEXT);
  expect(contextWindowFor(cfg, "x", 99_000_000)).toBe(MAX_CONTEXT);
});
