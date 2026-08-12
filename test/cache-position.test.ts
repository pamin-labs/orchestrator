import { expect, test } from "bun:test";
import {
  assemble,
  buildDelta,
  buildStable,
  needsRotation,
  type StableParts,
} from "../src/prompt/assemble.ts";

/**
 * Regression guard for PLAN.md §7 token economics #1.
 *
 * Busting the prompt cache is invisible: the agent still works, tests still
 * pass, and every turn costs 3-5x. These assertions are the only thing that
 * notices.
 */

const parts = (over: Partial<StableParts> = {}): StableParts => ({
  rolePrompt: "You are the Engineer. One writer per group.",
  onboarding: "bun test to run checks. Do not touch package.json.",
  lessons: ["Prefer stdlib over new deps", "Always run gate before task done"],
  language: "中文",
  model: "sonnet",
  allowedTools: ["Bash(orch *)", "Read", "Edit"],
  settingsPath: "profiles/L1.json",
  addDirs: ["/tmp/wt/g1"],
  ...over,
});

test("the delta lands only in prompt, never in the stable half", () => {
  const stable = buildStable(parts());
  const t = assemble(stable, { card: "S1 move token check into middleware" });

  expect(t.prompt).toContain("S1 move token check into middleware");
  expect(t.stable.systemAppend).not.toContain("S1 move token check into middleware");
});

test("two turns with different deltas share a byte-identical stable half", () => {
  const stable = buildStable(parts());
  const a = assemble(stable, { card: "task A", unread: "PM: go" });
  const b = assemble(stable, { card: "task B", leaseResult: "exit 0" });

  expect(a.stable.systemAppend).toBe(b.stable.systemAppend);
  expect(a.stable.hash).toBe(b.stable.hash);
  expect(a.prompt).not.toBe(b.prompt);
});

test("buildStable is deterministic for identical inputs", () => {
  expect(buildStable(parts()).hash).toBe(buildStable(parts()).hash);
});

test("nothing turn-varying leaks into the stable half", () => {
  const stable = buildStable(parts()).systemAppend;
  // No timestamps, no turn counters, no ids — any of these would make the
  // prefix unique per turn and defeat caching entirely.
  expect(stable).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(stable).not.toMatch(/\bturn\s*\d+/i);
  expect(stable).not.toMatch(/session[_-]?id/i);
});

test("delta sections are ordered with the newest information last", () => {
  const body = buildDelta({
    bossSay: "BOSS",
    card: "CARD",
    handoff: "HANDOFF",
    unread: "UNREAD",
  });
  const at = (s: string) => body.indexOf(s);
  expect(at("HANDOFF")).toBeLessThan(at("CARD"));
  expect(at("CARD")).toBeLessThan(at("UNREAD"));
  expect(at("UNREAD")).toBeLessThan(at("BOSS"));
});

test("empty delta parts are omitted, not rendered as blank headings", () => {
  const body = buildDelta({ card: "only this", unread: "", handoff: undefined });
  expect(body).toBe("## Your current work\n\nonly this");
});

test("changing the stable half forces session rotation, not a silent edit", () => {
  const base = buildStable(parts());

  // Every one of these used to be a tempting "just append it" — each would
  // invalidate the cached prefix for the rest of the session.
  const changed = [
    buildStable(parts({ lessons: ["a brand new lesson"] })),
    buildStable(parts({ onboarding: "different onboarding" })),
    buildStable(parts({ model: "opus" })),
    buildStable(parts({ allowedTools: ["Bash(orch *)"] })),
    buildStable(parts({ settingsPath: "profiles/L2.json" })),
    buildStable(parts({ addDirs: ["/tmp/wt/g2"] })),
  ];
  for (const c of changed) {
    expect(c.hash).not.toBe(base.hash);
    expect(needsRotation(base.hash, c)).toBe(true);
  }
  expect(needsRotation(base.hash, buildStable(parts()))).toBe(false);
});

test("a fresh session (no recorded hash) does not count as rotation", () => {
  expect(needsRotation(null, buildStable(parts()))).toBe(false);
});

test("the orch contract is in the stable half — it is identical every turn", () => {
  const stable = buildStable(parts()).systemAppend;
  expect(stable).toContain("orch ask-boss");
  expect(stable).toContain("orch lease");
  expect(stable).toContain("orch journal add");
});

test("changing the loaded tool set rotates the session", () => {
  const base = buildStable(parts());
  // `--tools` decides which definitions enter the prompt prefix, so it is part
  // of the cached half — unlike allowedTools, which only gates permission.
  const fewer = buildStable({ ...parts(), tools: ["Bash"] });
  expect(fewer.hash).not.toBe(base.hash);
  expect(needsRotation(base.hash, fewer)).toBe(true);
});

test("the loaded tool set defaults to exactly what the whitelist implies", () => {
  const s = buildStable(parts());
  // `Bash(orch *)` needs Bash loaded; nothing else should be paid for.
  expect(s.tools.sort()).toEqual(["Bash", "Edit", "Read"]);
});
