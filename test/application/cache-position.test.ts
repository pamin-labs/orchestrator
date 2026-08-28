import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listSkills, readSkill, referencedSkills } from "../../src/mech/skills.ts";
import { assemble, buildDelta, buildStable, needsRotation, type StableParts } from "../../src/prompt/assemble.ts";
import { tempDir } from "../support/temp.ts";

/**
 * Regression guard for docs/project/plan.md §7 token economics #1.
 *
 * Busting the prompt cache is invisible: the agent still works, tests still
 * pass, and every turn costs 3-5x. These assertions are the only thing that
 * notices.
 */

const parts = (over: Partial<StableParts> = {}): StableParts => ({
  rolePrompt: "You are the Engineer. One writer per group.",
  onboarding: "bun test to run checks. Do not touch package.json.",
  language: "中文",
  model: "sonnet",
  allowedTools: ["Bash(orch *)", "Read", "Edit"],
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
  const a = assemble(stable, { card: "task A", quoted: [{ label: "channel", content: "PM: go" }] });
  const b = assemble(stable, { card: "task B", rejection: "exit 0" });

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
    card: "CARD",
    handoff: "HANDOFF",
    skills: "SKILL",
    quoted: [{ label: "channel", content: "UNREAD" }],
  });
  const at = (s: string) => body.indexOf(s);
  expect(at("HANDOFF")).toBeLessThan(at("CARD"));
  expect(at("CARD")).toBeLessThan(at("SKILL"));
  // Quoted material is last, after every instruction: the turn reads what it is
  // being asked to do before it reads the thing it must not obey.
  expect(at("SKILL")).toBeLessThan(at("UNREAD"));
});

test("empty delta parts are omitted, not rendered as blank headings", () => {
  const body = buildDelta({ card: "only this", rejection: "", quoted: [] });
  expect(body).toBe("## Your current work\n\nonly this");
});

test("changing the stable half forces session rotation, not a silent edit", () => {
  const base = buildStable(parts());

  // Every one of these used to be a tempting "just append it" — each would
  // invalidate the cached prefix for the rest of the session.
  // Keyed by the part that moved, so a failure names it rather than reporting
  // `expected true, received false` against whichever of the six it was.
  const changed = {
    onboarding: buildStable(parts({ onboarding: "different onboarding" })),
    model: buildStable(parts({ model: "opus" })),
    allowedTools: buildStable(parts({ allowedTools: ["Bash(orch *)"] })),
    effort: buildStable(parts({ effort: "high" })),
    addDirs: buildStable(parts({ addDirs: ["/tmp/wt/g2"] })),
  };
  expect(
    Object.entries(changed)
      .filter(([, c]) => c.hash === base.hash)
      .map(([part]) => part),
  ).toEqual([]);
  expect(
    Object.entries(changed)
      .filter(([, c]) => !needsRotation(base.hash, c))
      .map(([part]) => part),
  ).toEqual([]);
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

test("the loaded tool set is the whitelist, plus the one tool skills need", () => {
  const s = buildStable(parts());
  // `Bash(orch *)` needs Bash loaded; nothing else should be paid for — except
  // `Skill`, which is not in any role yaml and is what the whole staged-skill
  // mount hangs on. Measured: without it in `--tools` the CLI loads no catalogue
  // at all and an agent asked to list its skills answers NONE.
  expect(s.tools.sort()).toEqual(["Bash", "Edit", "Read", "Skill"]);
});

test("a skill the boss pointed at lands in the delta, never in the cached prefix", () => {
  // Built here rather than assumed. This read `/tmp/skilltest`, which existed on
  // the machine the test was written on and nowhere else — so it passed locally
  // for as long as nobody ran it anywhere else, and went red the first time CI
  // existed. A test that depends on the author's disk is a test about the author.
  const dir = tempDir("orch-skilltest-");
  mkdirSync(join(dir, ".claude/skills/tidy"), { recursive: true });
  writeFileSync(
    join(dir, ".claude/skills/tidy/SKILL.md"),
    "---\nname: tidy\ndescription: keeps it tidy\n---\n\nguard clause first, then the happy path.\n",
  );
  const all = listSkills(dir);
  const tidy = all.find((s) => s.name === "tidy")!;
  expect(tidy.scope).toBe("project");
  expect(tidy.rel).toBe(".claude/skills/tidy/SKILL.md");

  // The path is how the composer refers to it; a bare /name works too, because that
  // is what gets typed.
  expect(referencedSkills(`按 ${tidy.rel} 来做`, all).map((s) => s.name)).toEqual(["tidy"]);
  expect(referencedSkills("用 /tidy 的做法", all).map((s) => s.name)).toEqual(["tidy"]);
  expect(referencedSkills("nothing here", all)).toEqual([]);

  const body = readSkill(tidy);
  expect(body).toContain("guard clause first");

  // The whole point: skill text is per-turn. In the stable half it would tax every
  // turn of the session for a skill used in one, and it would also rotate the
  // session, throwing away the cached prefix as well.
  const stable = buildStable({
    rolePrompt: "engineer",
    model: "claude-sonnet-5",
    allowedTools: ["Bash(orch *)", "Read"],
    addDirs: ["/tmp/wt"],
  });
  const { prompt } = assemble(stable, { card: "S1", skills: body });
  expect(stable.systemAppend).not.toContain("guard clause");
  expect(prompt).toContain("guard clause first");
  // And after the card, before the quoted material, which stays last.
  const both = assemble(stable, {
    card: "S1",
    skills: body,
    quoted: [{ label: "channel", content: "别忘了 zh" }],
  }).prompt;
  expect(both.indexOf("guard clause")).toBeGreaterThan(both.indexOf("S1"));
  expect(both.indexOf("别忘了 zh")).toBeGreaterThan(both.indexOf("guard clause"));
});

/**
 * A lesson is written by this system, about this project, whenever a retro
 * distils one — and it used to sit in the stable half, read fresh on every turn.
 * So the day one landed, every agent's prefix hash changed and every live
 * session was thrown away: the PM's and the Dispatcher's too, whose context was
 * still true, which is exactly the cost `handToBoss` measured and stopped paying.
 */
test("a new lesson does not throw away every session", () => {
  const before = buildStable(parts());
  const after = buildStable(parts());
  expect(needsRotation(before.hash, after)).toBe(false);

  // It reaches the turn, in the half that is paid for per turn and rotates
  // nothing — and after the work, since a rule is read in the light of the task.
  const t = assemble(before, { card: "S1 do the thing", lessons: "- prefer stdlib over new deps" });
  expect(t.prompt).toContain("prefer stdlib over new deps");
  expect(t.stable.systemAppend).not.toContain("prefer stdlib");
  expect(t.prompt.indexOf("S1 do the thing")).toBeLessThan(t.prompt.indexOf("prefer stdlib"));
});
