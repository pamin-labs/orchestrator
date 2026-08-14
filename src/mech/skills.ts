import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DB } from "../db.ts";

/**
 * Skills reach an agent two ways, and both are needed.
 *
 * **Mounted.** `stageSkills` builds one directory of the skills the boss ticked
 * and the sandbox mounts it read-only at both CLIs' skill paths, so the agent
 * discovers and invokes them itself. This is prefix: every skill in there costs
 * name + description on EVERY turn of EVERY agent (measured: the boss's whole
 * ~180-skill set plus slash commands was ~46k cached tokens). That is the bill the
 * tick boxes control, and why the settings page states it out loud.
 *
 * **Injected.** The boss naming a skill in a requirement still makes the
 * orchestrator read that SKILL.md on the host and append it to that one turn's
 * delta (`executor.ts`). Narrower than the catalogue and free: one turn pays for
 * one skill, and it works for a skill that was never ticked.
 *
 * `--setting-sources project,local` stays on regardless — that flag governs
 * settings, not skill discovery, and inheriting the boss's user-level setup
 * measured ~195k cached tokens on a trivial haiku turn.
 */

export interface SkillRef {
  name: string;
  /** Absolute on disk. Relative form is what goes into the message text. */
  file: string;
  rel: string;
  description: string;
  scope: "project" | "user";
}

/** Skill text is instructions, not a library. Past this it is being used wrong. */
export const SKILL_CAP = 12_000;

/**
 * The `description:` from a skill's frontmatter, including the block-scalar form.
 *
 * Real skills are written `description: |` with the text on the following indented
 * lines, and a one-line regex returns "|" — which is what the picker was showing.
 */
export function frontmatterDescription(text: string): string {
  const m = /^description:[ \t]*(.*)$/m.exec(text);
  if (!m) return "";
  const first = m[1]!.trim();
  if (first && first !== "|" && first !== ">" && first !== "|-" && first !== ">-") {
    return first.replace(/^["']|["']$/g, "").slice(0, 140);
  }
  // Block scalar: take the indented run that follows.
  const rest = text.slice(m.index + m[0]!.length).split("\n").slice(1);
  const out: string[] = [];
  for (const line of rest) {
    if (!line.trim()) {
      if (out.length) break;
      continue;
    }
    if (!/^\s/.test(line)) break;
    out.push(line.trim());
    if (out.join(" ").length > 140) break;
  }
  return out.join(" ").slice(0, 140);
}

function scan(root: string, base: string, scope: SkillRef["scope"], out: SkillRef[]): void {
  const dir = join(root, base);
  if (!existsSync(dir)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    // Not `d.isDirectory()`: a skill directory is very often a symlink into a
    // plugin or a shared `.agents/skills`, and the dirent for a symlink says
    // "symlink", not "directory" — which silently hid most of a real machine's
    // skills. Ask the filesystem where it points instead.
    const here = join(dir, d.name);
    try {
      if (!statSync(here).isDirectory()) continue;
    } catch {
      continue;
    }
    const file = join(here, "SKILL.md");
    if (!existsSync(file)) continue;
    let description = "";
    try {
      description = frontmatterDescription(readFileSync(file, "utf8").slice(0, 4000));
    } catch {}
    if (out.some((s) => s.name === d.name)) continue; // project wins over user
    out.push({ name: d.name, file, rel: join(base, d.name, "SKILL.md"), description, scope });
  }
}

/**
 * Every skill the boss could point an agent at.
 *
 * The project's own come first and shadow a same-named user skill: a repo that ships
 * a skill means that version.
 */
export function listSkills(repoPath?: string | null): SkillRef[] {
  const out: SkillRef[] = [];
  if (repoPath) {
    scan(repoPath, ".claude/skills", "project", out);
    scan(repoPath, ".agents/skills", "project", out);
  }
  const home = homedir();
  scan(home, ".claude/skills", "user", out);
  // The other CLI keeps its own, and the boss has no reason to care which
  // directory a skill lives in — the text is inlined into the turn either way, so
  // a codex skill works on a claude role and the reverse. Second, so a same-named
  // skill resolves to the .claude one (the dedupe above is first-wins).
  scan(home, ".codex/skills", "user", out);
  return out.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "project" ? -1 : 1));
}

/**
 * Which skills a message points at.
 *
 * The composer inserts the path, so the path is what is matched; a bare `/name` is
 * accepted too, because that is what a boss types from muscle memory.
 */
export function referencedSkills(text: string, all: SkillRef[]): SkillRef[] {
  if (!text) return [];
  const hit: SkillRef[] = [];
  for (const s of all) {
    const byPath = text.includes(s.rel) || text.includes(s.file);
    const bySlash = new RegExp(`(?:^|\\s)/${s.name}(?![\\w-])`).test(text);
    if (byPath || bySlash) hit.push(s);
  }
  return hit.slice(0, 3);
}

/** The skill's own text, capped, with its path so the agent can read the rest. */
export function readSkill(ref: SkillRef): string {
  let body = "";
  try {
    body = readFileSync(ref.file, "utf8");
  } catch {
    return `(${ref.rel} could not be read)`;
  }
  const cut = body.length > SKILL_CAP;
  return (
    `### ${ref.name}  (${ref.rel})\n\n${body.slice(0, SKILL_CAP)}` +
    (cut ? `\n\n(truncated — the rest is in ${ref.rel}, open it with Read if you need it)` : "")
  );
}

/** Names to carry on a job payload; the text is read at turn time, not stored. */
export function skillNames(text: string, repoPath?: string | null): string[] {
  return referencedSkills(text, listSkills(repoPath)).map((s) => s.name);
}

const OFF_KEY = "skills.off";

/**
 * Which skills the boss unticked.
 *
 * The off-list, not the on-list: a skill installed tomorrow is available tomorrow
 * without anyone going back to tick it.
 */
export function skillsOff(db: DB): string[] {
  const row = db.query<{ v: string }, [string]>("SELECT v FROM setting WHERE k = ?").get(OFF_KEY);
  try {
    return JSON.parse(row?.v ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function setSkillOff(db: DB, name: string, off: boolean): string[] {
  const next = skillsOff(db).filter((n) => n !== name);
  if (off) next.push(name);
  db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [
    OFF_KEY,
    JSON.stringify(next),
  ]);
  return next;
}

/** Stage what is ticked. Called at boot and after every tick. */
export function restageSkills(db: DB, dataDir: string): ReturnType<typeof stageSkills> {
  const off = new Set(skillsOff(db));
  return stageSkills(dataDir, listSkills().filter((s) => !off.has(s.name)));
}

/**
 * The one directory every sandbox mounts, built from the skills still ticked.
 *
 * Copied, not symlinked, and copied with `dereference` — both skill directories on
 * a real machine are symlink farms (`~/.claude/skills/impeccable ->
 * ../../.agents/skills/impeccable`, codex's point into its plugin cache), and a
 * symlink whose target was never mounted is a dangling link inside the container.
 *
 * Updated in place rather than rebuilt beside and renamed: the container mounted
 * this directory, so a rename leaves every running sandbox looking at the old one.
 *
 * Callers pass `listSkills()` minus what the boss unticked — user scope only. A
 * project's own `.claude/skills` is inside the checkout the CLI already runs in,
 * and mounting a second copy over it is how two versions of one skill start
 * disagreeing.
 */
export function stageSkills(dataDir: string, want: SkillRef[]): { dir: string; staged: string[]; failed: string[] } {
  const dir = join(dataDir, "skills");
  mkdirSync(dir, { recursive: true });
  const keep = new Set(want.map((s) => s.name));

  for (const name of readdirSync(dir)) {
    if (!keep.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  }

  const staged: string[] = [];
  const failed: string[] = [];
  for (const s of want) {
    const dst = join(dir, s.name);
    try {
      // ponytail: SKILL.md's mtime stands for the whole skill. A touched
      // reference/*.md alone is missed until the skill is re-ticked; re-copying
      // 2.7MB of plugin skills on every boot to catch that is the worse trade.
      const src = statSync(s.file).mtimeMs;
      if (existsSync(join(dst, "SKILL.md")) && statSync(join(dst, "SKILL.md")).mtimeMs >= src) {
        staged.push(s.name);
        continue;
      }
      rmSync(dst, { recursive: true, force: true });
      cpSync(dirname(s.file), dst, { recursive: true, dereference: true });
      staged.push(s.name);
    } catch {
      // A dangling symlink, or a skill uninstalled mid-scan. Skipping one skill
      // beats failing the mount every other skill depends on.
      rmSync(dst, { recursive: true, force: true });
      failed.push(s.name);
    }
  }
  return { dir, staged, failed };
}
