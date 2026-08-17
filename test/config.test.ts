import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  contextWindowFor,
  DEFAULTS_FOR_CHECK,
  loadConfig,
  loadRoles,
  MAX_CONTEXT,
  MIN_CONTEXT,
  modelFor,
  withAbsoluteDataDir,
} from "../src/platform/config/load.ts";
import { ConfigSchema } from "../src/contracts/config.ts";
import { routeSource } from "./route-source.ts";

test("the shipped roles all parse and declare what the runtime needs", () => {
  const roles = loadRoles("roles");
  for (const name of ["dispatcher", "pm", "engineer", "qa", "auditor"]) {
    const r = roles.get(name);
    expect(r).toBeDefined();
    expect(r!.prompt.length).toBeGreaterThan(50);
    expect(r!.allowedTools!.length).toBeGreaterThan(0);
  }
});

test("dataDir is absolute, because the things that read it run elsewhere", () => {
  // Turn logs, gate logs and attachments are all written by paths built off this
  // while the work itself happens in a sandbox. A relative one resolved against
  // whatever the cwd happened to be, which was never the same twice.
  expect(isAbsolute(loadConfig().dataDir)).toBe(true);
  expect(isAbsolute(withAbsoluteDataDir({ ...loadConfig(), dataDir: "data" }).dataDir)).toBe(true);
});

test("only the engineer is allowed to be a writer", () => {
  const roles = loadRoles("roles");
  // One writer per group is what makes the scheduler's per-group serialisation
  // equivalent to "no write conflicts". The sandbox cannot enforce it — it knows
  // nothing about roles — so the tool list is where it is said.
  expect(roles.get("engineer")!.allowedTools).toContain("Write");
  for (const other of ["qa", "auditor", "pm", "architect", "cos", "dispatcher", "librarian"]) {
    expect(roles.get(other)!.allowedTools).not.toContain("Write");
  }
  expect(roles.get("qa")!.prompt).toContain("Do NOT read the Engineer's self-review");
});

test("adding a role is a file, not a code change", () => {
  // Assert the property, not the current roster: nothing in the loader
  // enumerates known names, so an unfamiliar yaml simply appears.
  const dir = mkdtempSync(join(tmpdir(), "orch-roles-"));
  writeFileSync(join(dir, "composer.yaml"), "name: composer\ntier: hard\nprompt: |\n  You write music.\n");
  const roles = loadRoles(dir);
  expect([...roles.keys()]).toEqual(["composer"]);
  expect(roles.get("composer")!.tier).toBe("hard");

  // And the shipped roster is whatever is on disk, not a hardcoded list.
  expect(loadRoles("roles").size).toBeGreaterThanOrEqual(5);
});

test("config falls back to defaults when the file is missing", () => {
  const cfg = loadConfig("config/does-not-exist.yaml");
  expect(cfg.maxGroups).toBe(10);
  // `workRoot` used to be asserted here: a host directory for the worktrees
  // groups were checked out into. Since 005 the checkout is a clone inside the
  // container, nothing read the setting, and `refreshIndex` took it as a
  // parameter it named `_workRoot` and ignored.
});

test("difficulty picks the model, and a role may pin one", () => {
  const cfg = loadConfig("config/default.yaml");
  const eng = { name: "engineer", prompt: "x" };
  expect(modelFor(cfg, eng, "trivial")).toBe(cfg.difficultyModel.claude!.trivial!);
  expect(modelFor(cfg, eng, "hard")).toBe(cfg.difficultyModel.claude!.hard!);
  // No tag falls back to normal rather than to the most expensive tier.
  expect(modelFor(cfg, eng, null)).toBe(cfg.difficultyModel.claude!.normal!);

  const dispatcher = loadRoles("roles").get("dispatcher")!;
  expect(modelFor(cfg, dispatcher, "trivial")).toBe(cfg.difficultyModel.claude!.hard!);
});

test("the runtime picks the model table, so codex never gets a claude id", () => {
  const cfg = loadConfig("config/default.yaml");
  const onCodex = { name: "x", prompt: "p", runtime: "codex" as const };
  // `codex exec -m claude-sonnet-5` is rejected outright, which is what a
  // runtime: codex role got before the table was split.
  expect(modelFor(cfg, onCodex, "hard")).toBe(cfg.difficultyModel.codex!.hard!);
  expect(modelFor(cfg, onCodex, "trivial")).toBe(cfg.difficultyModel.codex!.trivial!);
  expect(modelFor(cfg, onCodex, "hard")).not.toContain("claude");
});

test("a role may name a concrete model id and it is used verbatim", () => {
  const cfg = loadConfig("config/default.yaml");
  const pinned = { name: "x", prompt: "p", model: "claude-haiku-4-5-20251001" };
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
  // trivial and normal. Self-review, reconcile, the gate and an independent QA all
  // still run on both — this skips the fifth layer, the boss's own look.
  //
  // This assertion used to say trivial only, and it was reading the code default
  // while every install read the shipped yaml, which said trivial and normal. Two
  // files disagreeing in comments about which one was the careful answer, and a
  // test pinning the one nobody ran. The yaml won because it is what has been
  // running; hard is the line that matters and it still waits.
  expect(cfg.autoAcceptTiers).toEqual(["trivial", "normal"]);
  expect(cfg.autoAcceptTiers).not.toContain("hard");
});

test("ctxBudgetChars actually reaches the thing it configures", () => {
  // It was a setting that read back as itself and changed nothing: `orch ctx query`
  // used the module default because nobody passed the config value in. A knob that
  // does nothing is worse than no knob — it reads as tried.
  const cfg = loadConfig("config/does-not-exist.yaml");
  expect(cfg.ctxBudgetChars).toBeGreaterThan(0);
  // No hand-copied literal to check any more — `ctx.config` is the config
  // object, so a key reaches the handlers by existing. What is still worth
  // asserting is the other half, the one that was actually broken: that the
  // route reads the setting instead of the module default.
  //
  // The whole route layer, not one file: `api.ts` was split into `src/api/*` and
  // pinning this to whichever module holds the reader today would put the guard
  // back where the next move breaks it.
  expect(readFileSync("src/composition/server.ts", "utf8")).toContain("config: cfg,");
  expect(routeSource()).toContain("ctx.config.ctxBudgetChars");
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

test("the shipped yaml never disagrees with the code default", () => {
  // They drifted three ways at once: `turnTimeoutMs` 10 minutes against 20,
  // `leaseSlots` one pool of 2 against a browser pool of 1, and
  // `autoAcceptTiers` trivial against trivial-and-normal — each with a comment
  // under it explaining why its own answer was the careful one. Nothing could
  // see it, because the file simply wins and the default is only read when a key
  // is absent.
  //
  // Now that the operating knobs live in the settings table, the yaml keeps only
  // what a startup needs. Anything still in it must say what the code says, or
  // it is a second answer nobody knows about.
  const JsonObject = z.record(z.string(), z.json());
  const yaml = JsonObject.parse(Bun.YAML.parse(readFileSync("config/default.yaml", "utf8")));
  const defaults = JsonObject.parse(DEFAULTS_FOR_CHECK);
  for (const [key, value] of Object.entries(yaml)) {
    const codeDefault = defaults[key];
    if (codeDefault === undefined) throw new Error(`yaml has no code default for ${key}`);
    expect(value, key).toEqual(codeDefault);
  }
});

test("the config type and the config schema are one declaration", () => {
  // They were two: a hand-written `type Config = {...}` of twenty-six fields
  // beside a `ConfigSchema` of the same twenty-six, kept in step by whoever
  // remembered. Nothing checked they agreed, and the two doors that matter — the
  // settings panel and the boot check — both read the schema, so a field added
  // to the type alone is a setting the panel cannot show and checkconfig will
  // not police, with the compiler saying everything is fine.
  //
  // `Config` is `z.infer<typeof ConfigSchema>` now, so this can only assert the
  // half a type cannot: that the shipped defaults are a legal config, and that
  // every key in one is a key in the other.
  const parsed = ConfigSchema.safeParse(DEFAULTS_FOR_CHECK);
  expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  expect(Object.keys(ConfigSchema.shape).sort()).toEqual(Object.keys(DEFAULTS_FOR_CHECK).sort());

  // And the file on disk, which is the thing that actually boots.
  const live = ConfigSchema.safeParse(loadConfig());
  expect(live.success ? [] : live.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
});
