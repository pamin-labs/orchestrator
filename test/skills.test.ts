import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSkillOff, skillsOff, stageSkills, type SkillRef } from "../src/mech/skills.ts";
import { openMemory } from "../src/db.ts";

/**
 * The staging directory the sandbox mounts.
 *
 * Both skill directories on a real machine are symlink farms into `.agents/skills`
 * or a plugin cache, so the thing that actually breaks is a copy that preserves the
 * link: inside the container the target was never mounted and every skill is a
 * dangling pointer. That, and the in-place update — a rebuilt-and-renamed directory
 * leaves every running sandbox mounted on the old inode.
 */

function farm(): { home: string; ref: (name: string) => SkillRef } {
  const home = mkdtempSync(join(tmpdir(), "orch-sk-"));
  mkdirSync(join(home, "real"), { recursive: true });
  mkdirSync(join(home, "skills"), { recursive: true });
  return {
    home,
    ref(name: string) {
      const real = join(home, "real", name);
      mkdirSync(join(real, "reference"), { recursive: true });
      writeFileSync(join(real, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`);
      writeFileSync(join(real, "reference", "more.md"), "more");
      // What a real machine looks like: the discovered directory is a symlink.
      symlinkSync(real, join(home, "skills", name));
      return {
        name,
        file: join(home, "skills", name, "SKILL.md"),
        rel: `.claude/skills/${name}/SKILL.md`,
        description: "d",
        scope: "user" as const,
      };
    },
  };
}

test("staged skills are dereferenced, not symlinked", () => {
  const f = farm();
  const data = mkdtempSync(join(tmpdir(), "orch-data-"));
  const { dir, staged, failed } = stageSkills(data, [f.ref("alpha")]);

  expect(staged).toEqual(["alpha"]);
  expect(failed).toEqual([]);
  expect(lstatSync(join(dir, "alpha")).isSymbolicLink()).toBe(false);
  expect(lstatSync(join(dir, "alpha", "SKILL.md")).isSymbolicLink()).toBe(false);
  // The rest of the skill travels too, or half its instructions are missing.
  expect(readFileSync(join(dir, "alpha", "reference", "more.md"), "utf8")).toBe("more");
});

test("unticked skills leave, and the directory itself is never replaced", () => {
  const f = farm();
  const data = mkdtempSync(join(tmpdir(), "orch-data-"));
  const alpha = f.ref("alpha");
  const beta = f.ref("beta");

  const first = stageSkills(data, [alpha, beta]);
  const inode = lstatSync(first.dir).ino;
  expect(existsSync(join(first.dir, "beta"))).toBe(true);

  const second = stageSkills(data, [alpha]);
  expect(existsSync(join(second.dir, "beta"))).toBe(false);
  expect(existsSync(join(second.dir, "alpha"))).toBe(true);
  expect(lstatSync(second.dir).ino).toBe(inode);
});

test("an unchanged skill is not copied again", () => {
  const f = farm();
  const data = mkdtempSync(join(tmpdir(), "orch-data-"));
  const alpha = f.ref("alpha");

  stageSkills(data, [alpha]);
  const copied = join(data, "skills", "alpha", "SKILL.md");
  // Mark the copy. A re-copy would overwrite it; a skip leaves it alone.
  writeFileSync(copied, "marked");
  utimesSync(copied, new Date(), new Date());

  stageSkills(data, [alpha]);
  expect(readFileSync(copied, "utf8")).toBe("marked");
});

test("a dangling skill is skipped, not fatal", () => {
  const f = farm();
  const data = mkdtempSync(join(tmpdir(), "orch-data-"));
  const alpha = f.ref("alpha");
  const gone: SkillRef = { ...alpha, name: "gone", file: join(f.home, "skills", "gone", "SKILL.md") };

  const { staged, failed } = stageSkills(data, [gone, alpha]);
  expect(failed).toEqual(["gone"]);
  expect(staged).toEqual(["alpha"]);
  expect(existsSync(join(data, "skills", "gone"))).toBe(false);
});

test("what is stored is the off list, so a skill installed tomorrow is on tomorrow", () => {
  // Storing the on list instead would mean every new skill arrives invisible to
  // every agent until someone goes back to the settings page and ticks it.
  const db = openMemory();
  expect(skillsOff(db)).toEqual([]);
  setSkillOff(db, "impeccable", true);
  expect(skillsOff(db)).toEqual(["impeccable"]);
  setSkillOff(db, "impeccable", true);
  expect(skillsOff(db)).toEqual(["impeccable"]);
  setSkillOff(db, "impeccable", false);
  expect(skillsOff(db)).toEqual([]);
});
