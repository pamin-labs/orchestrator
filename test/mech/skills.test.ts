import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheProjectSkills,
  frontmatterDescription,
  pathInSandbox,
  projectSkills,
  projectSkillsPending,
  referencedSkills,
  setSkillOff,
  skillsOff,
  stageSkills,
  type SkillRef,
} from "../../src/mech/skills.ts";
import { openMemory, rewriteSkillPaths, type DB } from "../../src/platform/persistence/database.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

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
  const data = join(mkdtempSync(join(tmpdir(), "orch-data-")), "skills");
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
  const data = join(mkdtempSync(join(tmpdir(), "orch-data-")), "skills");
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
  const data = join(mkdtempSync(join(tmpdir(), "orch-data-")), "skills");
  const alpha = f.ref("alpha");

  stageSkills(data, [alpha]);
  const copied = join(data, "alpha", "SKILL.md");
  // Mark the copy. A re-copy would overwrite it; a skip leaves it alone.
  writeFileSync(copied, "marked");
  // Newer than the source *by construction*, not by asking the clock. `new
  // Date()` failed on CI: the runner's filesystem stores a coarser mtime than
  // the value it is handed, so "now" could land at or before a source written
  // milliseconds earlier — a red build on a rule that was working, on whichever
  // pull request happened to be open.
  const src = statSync(alpha.file).mtimeMs;
  const newer = new Date(src + 2000);
  utimesSync(copied, newer, newer);

  stageSkills(data, [alpha]);
  expect(readFileSync(copied, "utf8")).toBe("marked");
});

test("a dangling skill is skipped, not fatal", () => {
  const f = farm();
  const data = join(mkdtempSync(join(tmpdir(), "orch-data-")), "skills");
  const alpha = f.ref("alpha");
  const gone: SkillRef = { ...alpha, name: "gone", file: join(f.home, "skills", "gone", "SKILL.md") };

  const { staged, failed } = stageSkills(data, [gone, alpha]);
  expect(failed).toEqual(["gone"]);
  expect(staged).toEqual(["alpha"]);
  expect(existsSync(join(data, "gone"))).toBe(false);
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

test("a skill's path is where the agent can actually read it", () => {
  // `ref.file` is a path on the boss's machine and `ref.rel` is relative to the
  // boss's home. A turn runs in a container: a project skill travels in the
  // checkout, a user skill is linked into the CLI's own directory, and neither
  // is either of those two.
  //
  // Absolute in both cases. A turn's working directory is `/work`, so the
  // relative form resolved for a turn and not for a gate or a lease, which run
  // the same instruction from somewhere else.
  const base = { file: "/Users/boss/.claude/skills/impeccable/SKILL.md", description: "d", name: "impeccable" };
  expect(pathInSandbox({ ...base, rel: ".claude/skills/impeccable/SKILL.md", scope: "user" })).toBe(
    "/root/.claude/skills/impeccable/SKILL.md",
  );
  expect(pathInSandbox({ ...base, rel: ".claude/skills/impeccable/SKILL.md", scope: "project" })).toBe(
    "/work/.claude/skills/impeccable/SKILL.md",
  );
});

test("old messages stop pointing at a machine the agent cannot see", () => {
  // The stored bodies are re-injected into later turns, so a path that resolved
  // on the host is an instruction to read a file that is not there.
  const db = openMemory();
  const p = fx.project.insert(db, { name: "p" });
  fx.note.insert(db, {
    project_id: p.id,
    body: "按 .claude/skills/impeccable/SKILL.md 来做，再看 .agents/skills/ponytail/SKILL.md",
  });
  fx.event.insert(db, { author: "boss", kind: "boss_say", body: "用 .claude/skills/tdd/SKILL.md" });
  rewriteSkillPaths(db);
  expect(db.query<{ body: string }, []>("SELECT body FROM note").get()!.body).toBe(
    "按 /impeccable 来做，再看 /ponytail",
  );
  expect(db.query<{ body: string }, []>("SELECT body FROM event").get()!.body).toBe("用 /tdd");
});

test("a skill's description survives every shape real skills are written in", () => {
  // The picker shows this string. A regex returned "|" for the block-scalar form,
  // which is what it displayed; the hand-rolled walk that replaced it folded `>-`
  // the way `|` folds and could match a `description:` in the body below the
  // frontmatter. `Bun.YAML.parse` was already in use three files over.
  const fm = (b: string) => frontmatterDescription(`---\nname: a\n${b}\n---\nbody\n`);
  expect(fm("description: one line here")).toBe("one line here");
  expect(fm("description: |\n  first line\n  second line")).toBe("first line second line");
  expect(fm("description: >-\n  folded one\n  folded two")).toBe("folded one folded two");
  expect(fm('description: "quoted"')).toBe("quoted");

  // No frontmatter description: the word appearing in the body is not one.
  expect(frontmatterDescription("---\nname: a\n---\nbody says description: not this\n")).toBe("");
  expect(frontmatterDescription("no frontmatter at all")).toBe("");

  // The caller reads a truncated head, so an unterminated document is normal and
  // must not throw — one line is better than nothing at all.
  expect(frontmatterDescription("---\nname: a\ndescription: trunc")).toBe("trunc");
});

test("a skill whose name is not a regex is still matched by its name", () => {
  // The name went into the pattern raw. Skill names are directory names off
  // disk: `c++` is legal there and illegal in a regex, so one installed skill
  // threw a SyntaxError on the way to reading *any* message — and a `.` in a
  // name quietly matched a different skill and shipped it into the turn.
  const ref = (name: string): SkillRef => ({
    name,
    file: `/s/${name}/SKILL.md`,
    rel: `.claude/skills/${name}/SKILL.md`,
    description: "d",
    scope: "user",
  });
  const all = [ref("c++"), ref("a.b"), ref("ponytail")];
  expect(referencedSkills("走 /c++ 这条", all).map((s) => s.name)).toEqual(["c++"]);
  expect(referencedSkills("走 /axb 这条", all)).toEqual([]);
  expect(referencedSkills("走 /a.b 这条", all).map((s) => s.name)).toEqual(["a.b"]);
});

/**
 * A repository's own skills exist before anything can list them.
 *
 * The code lives only in a container now, so between "project created" and
 * "first group cloned it" there is nothing on this machine to count. That window
 * used to be reported as *unreachable*, which is a different thing and sends the
 * boss to check a path that was never going to be there.
 */
function pendingCtx(projectId: number, repoPath: string) {
  const db = openMemory();
  const ctx = testContext({ db });
  return { db, ctx, repoPath, projectId };
}

const said = (db: DB): string[] =>
  db
    .query<{ body: string }, []>("SELECT body FROM event WHERE kind = 'state_change'")
    .all()
    .map((r) => r.body);

test("a repo whose skills have not been listed yet is explained once, not every poll", () => {
  const t = pendingCtx(101, "me/x");

  projectSkillsPending(t.ctx, t.projectId, t.repoPath);
  projectSkillsPending(t.ctx, t.projectId, t.repoPath);

  const bodies = said(t.db);
  expect(bodies.length).toBe(1);
  // Says the directories it looks in, so a boss who keeps skills elsewhere finds
  // out here rather than by them never appearing.
  expect(bodies[0]).toContain(".claude/skills");
  expect(bodies[0]).toContain(".agents/skills");
});

test("a local checkout has nothing to wait for and is not reported", () => {
  // `repo_path` still holds a host directory for older projects, and those are
  // scanned directly — there is no container the listing has to arrive from.
  const t = pendingCtx(102, "/Users/me/code/x");

  projectSkillsPending(t.ctx, t.projectId, t.repoPath);

  expect(said(t.db)).toEqual([]);
});

test("a project with no remote recorded says nothing at all", () => {
  const t = pendingCtx(103, "me/x");

  projectSkillsPending(t.ctx, 103, null);
  projectSkillsPending(t.ctx, 103, "");

  expect(said(t.db)).toEqual([]);
});

test("once the listing has arrived the pending note is not emitted", () => {
  const t = pendingCtx(104, "me/x");
  cacheProjectSkills(t.db, t.projectId, "ORCHSKILL .claude/skills/deploy/SKILL.md ZA==");
  expect(projectSkills(t.db, t.projectId).length).toBe(1);

  projectSkillsPending(t.ctx, t.projectId, t.repoPath);

  expect(said(t.db)).toEqual([]);
});
