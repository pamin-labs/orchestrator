import type { Ctx } from "../mech/ctx.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { hostClaudeHome, hostCodexHome } from "./sandbox/auth.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readSetting, writeSetting, type DB } from "../platform/persistence/database.ts";
import { jsonOr } from "../contracts/json.ts";
import { z } from "zod";

/**
 * Skills reach an agent two ways, and both are needed.
 *
 * **Discovered** is prefix: `stageSkills` stages what the boss ticked, and
 * `SKILL_SYNC` links it and the repository's own into both CLIs' directories,
 * costing name + description on every turn of every agent. **Injected** is one
 * turn's delta — naming a skill in a requirement, ticked or not, and free.
 */

export interface SkillRef {
  name: string;
  /** Absolute on disk. Relative form is what goes into the message text. */
  file: string;
  rel: string;
  description: string;
  scope: "project" | "user";
}

const SkillRefSchema = z.object({
  name: z.string(),
  file: z.string(),
  rel: z.string(),
  description: z.string(),
  scope: z.enum(["project", "user"]),
});
const SkillFrontmatter = z.object({ description: z.string().optional() });

/** Where a repository can ship its own skills; `listSkills` says which CLI reads each. */
const PROJECT_SKILL_DIRS = [".claude/skills", ".codex/skills", ".agents/skills"] as const;

/** Skill text is instructions, not a library. Past this it is being used wrong. */
const SKILL_CAP = 12_000;

/**
 * The `description:` from a skill's frontmatter, including the block-scalar form.
 *
 * `Bun.YAML.parse` rather than a regex: real skills are written `description: |`
 * with the text on following indented lines, and the one-line regex this started
 * as returned "|", which is what the picker showed. The head may be a truncated
 * read, so a parse failure is normal — fall back to the first line, do not throw.
 */
export function frontmatterDescription(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.trimStart());
  if (m) {
    try {
      const parsed = SkillFrontmatter.safeParse(Bun.YAML.parse(m[1]!));
      if (parsed.success && parsed.data.description) {
        return parsed.data.description.trim().replace(/\s+/g, " ").slice(0, 140);
      }
    } catch {}
  }
  const one = /^description:[ \t]*(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  return /^[|>][-+]?$/.test(one) ? "" : one.replace(/^["']|["']$/g, "").slice(0, 140);
}

/**
 * `relBase` is separate from `base` because the two answer different questions:
 * `base` is where to look under `root`, `relBase` is the conventional path that
 * goes into `rel` and is matched against older message text (migration 026). A
 * user who moved `~/.claude` with `$CLAUDE_CONFIG_DIR` changes the first and must
 * not change the second.
 */
function scan(root: string, base: string, scope: SkillRef["scope"], out: SkillRef[], relBase = base): void {
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
    out.push({ name: d.name, file, rel: join(relBase, d.name, "SKILL.md"), description, scope });
  }
}

/**
 * Every skill the boss could point an agent at.
 *
 * The project's own come first and shadow a same-named user skill: a repo that ships
 * a skill means that version.
 */
export function listSkills(repoPath?: string | null, project: SkillRef[] = []): SkillRef[] {
  const out: SkillRef[] = [...project];
  // A host path only. `repo_path` is `owner/name` since 007 §2 and the checkout
  // exists only inside containers, so this branch finds nothing in normal
  // operation — the repository's own arrive through `project`. All three
  // conventions are listed because none is universal: `.claude/skills` is
  // claude's, read from its working directory; codex has **no project-local
  // skills directory** at all; `.agents/skills` is the wider ecosystem's and
  // neither CLI reads it. Hence delivery by `SKILL_SYNC`'s symlink farm.
  if (repoPath?.startsWith("/")) {
    for (const dir of PROJECT_SKILL_DIRS) scan(repoPath, dir, "project", out);
  }
  // Wherever each CLI actually keeps its state: `$CLAUDE_CONFIG_DIR` and
  // `$CODEX_HOME` both move it, and a boss who set either would have seen every
  // ticked skill stage zero files with nothing said — `scan` skips a directory
  // that is not there, which is the right behaviour and the wrong answer.
  scan(hostClaudeHome(), "skills", "user", out, ".claude/skills");
  // The other CLI's own. The text is inlined into the turn either way, so a
  // codex skill works on a claude role and the reverse. Second, so a same-named
  // skill resolves to the .claude one (the dedupe above is first-wins).
  scan(hostCodexHome(), "skills", "user", out, ".codex/skills");
  // The ecosystem's shared home, where `npx skills add --agent` installs and
  // links into each CLI's directory. Where those links were made this adds
  // nothing, which is exactly why it is worth scanning: on a machine where they
  // were not, the skills are present, invisible, and there is nothing to notice.
  // Last, so a CLI's own copy still wins the name.
  scan(join(homedir(), ".agents"), "skills", "user", out, ".agents/skills");
  return out.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "project" ? -1 : 1));
}

/**
 * Which skills a message points at.
 *
 * `/name` is what the composer inserts and what a boss types from muscle memory.
 * The paths are still matched because older messages carry them — see migration
 * 026, which rewrites the ones that pointed at this machine.
 */
export function referencedSkills(text: string, all: SkillRef[]): SkillRef[] {
  if (!text) return [];
  const hit: SkillRef[] = [];
  for (const s of all) {
    const byPath = text.includes(s.rel) || text.includes(s.file);
    // Escaped: a skill name is a directory name off disk. `c++` is a legal
    // directory and an illegal regex, so one such skill made every message throw
    // on its way to being read; a name with a `.` matched the wrong skill.
    // fallow-ignore-next-line security-sink -- `s.name` is a directory name off disk and it goes through `RegExp.escape`, so it can only ever contribute literal characters; the message text is the `test` argument.
    const bySlash = new RegExp(`(?:^|\\s)/${RegExp.escape(s.name)}(?![\\w-])`).test(text);
    if (byPath || bySlash) hit.push(s);
  }
  return hit.slice(0, 3);
}

/**
 * Where this skill sits **inside the sandbox**.
 *
 * Not `ref.file`, which is a path on the boss's machine, and not `ref.rel` for a
 * user skill, which is relative to the boss's home. A project skill travels in the
 * checkout the turn runs in; a user skill is on the read-only mount.
 */
export function pathInSandbox(ref: SkillRef): string {
  // Absolute for both. A turn's working directory is `/work`, so the relative
  // form resolved — until a gate or a lease ran the same instruction from
  // somewhere else, and then it did not, silently.
  return ref.scope === "project" ? `/work/${ref.rel}` : `/root/.claude/skills/${ref.name}/SKILL.md`;
}

const wrap = (ref: SkillRef, where: string, body: string): string => {
  const cut = body.length > SKILL_CAP;
  return (
    `### ${ref.name}  (${where})\n\n${body.slice(0, SKILL_CAP)}` +
    (cut ? `\n\n(truncated — the rest is in ${where}, open it with Read if you need it)` : "")
  );
};

/** The skill's own text, capped, with its path so the agent can read the rest. */
export function readSkill(ref: SkillRef): string {
  const where = pathInSandbox(ref);
  try {
    return wrap(ref, where, readFileSync(ref.file, "utf8"));
  } catch {
    return `(${where} could not be read)`;
  }
}

/**
 * The same, for a skill that may live inside the container rather than here.
 *
 * A user skill is on this machine and is read here. A project skill exists
 * *only* in the container, so it is fetched over the files API rather than an
 * exec. Naming one in a requirement has to work for both, or a repository's own
 * skills are listed in the panel and inert when pointed at.
 */
export async function readSkillIn(get: (path: string) => Promise<string | null>, ref: SkillRef): Promise<string> {
  if (ref.scope !== "project") return readSkill(ref);
  const where = pathInSandbox(ref);
  const body = await get(where).catch(() => null);
  return body === null ? `(${where} could not be read)` : wrap(ref, where, body);
}

/** Names to carry on a job payload; the text is read at turn time, not stored. */
export function skillNames(text: string, repoPath?: string | null, project: SkillRef[] = []): string[] {
  return referencedSkills(text, listSkills(repoPath, project)).map((s) => s.name);
}

/**
 * A repository's own skills, as the container last enumerated them.
 *
 * The container is the only place that can see them — `repo_path` is
 * `owner/name` and the checkout lives inside a sandbox — so the listing is
 * carried back and cached in a `setting` rather than a `note`. Rewritten on
 * every turn's probe, or a push that adds a skill stays invisible until later.
 */
const PROJECT_KEY = (id: number) => `skills.project.${id}`;

export function projectSkills(db: DB, projectId: number | null | undefined): SkillRef[] {
  if (!projectId) return [];
  return jsonOr(readSetting(db, PROJECT_KEY(projectId)), z.array(SkillRefSchema), []);
}

/**
 * Read `SKILL_SYNC`'s inventory lines out of an exec's stdout and store them.
 *
 * Absence of any line is a real answer — a repository with no skills — so the
 * empty list is written too; treating "none" as "do not touch the cache" is how
 * a removed skill stays listed forever. The one case it will not write is a
 * container that never ran the script, which the caller sees as a failed exec.
 */
export function cacheProjectSkills(db: DB, projectId: number | null | undefined, stdout: string): SkillRef[] {
  if (!projectId) return [];
  const out: SkillRef[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^ORCHSKILL (\S+) (\S*)$/.exec(line.trim());
    if (!m) continue;
    const rel = m[1]!;
    const name = rel.split("/").at(-2) ?? "";
    if (!name || out.some((s) => s.name === name)) continue;
    let head = "";
    try {
      head = Buffer.from(m[2]!, "base64").toString("utf8");
    } catch {}
    // `file` is the container path, not a host one. Nothing on this machine may
    // open it, and `readSkillIn` is the only reader — it goes back to the
    // container. Kept in the same field so a project skill and a user skill are
    // the same shape everywhere else.
    out.push({ name, file: `/work/${rel}`, rel, description: frontmatterDescription(head), scope: "project" });
  }
  writeSetting(db, PROJECT_KEY(projectId), JSON.stringify(out));
  return out;
}

/** A removed project should not leave its skills behind in `setting`. */
export function forgetProjectSkills(db: DB, projectId: number): void {
  writeSetting(db, PROJECT_KEY(projectId), null);
}

const OFF_KEY = "skills.off";

/**
 * Which skills the boss unticked.
 *
 * The off-list, not the on-list: a skill installed tomorrow is available tomorrow
 * without anyone going back to tick it.
 */
export function skillsOff(db: DB): string[] {
  return jsonOr(readSetting(db, OFF_KEY), z.array(z.string()), []);
}

export function setSkillOff(db: DB, name: string, off: boolean): string[] {
  const next = skillsOff(db).filter((n) => n !== name);
  if (off) next.push(name);
  writeSetting(db, OFF_KEY, JSON.stringify(next));
  return next;
}

/** Stage what is ticked. Called at boot and after every tick. */
export function restageSkills(db: DB, dir: string): ReturnType<typeof stageSkills> {
  const off = new Set(skillsOff(db));
  return stageSkills(
    dir,
    listSkills().filter((s) => !off.has(s.name)),
  );
}

/**
 * The one directory every sandbox mounts, built from the skills still ticked.
 *
 * Mounted at `STAGED_SKILLS`, not either CLI's own path, so `SKILL_SYNC` links
 * out of here into both and leaves those writable for a repository's own. Copied
 * with `dereference`: both are symlink farms on a real machine, and a link whose
 * target was never mounted dangles. Updated in place, or a rename strands them.
 */
export function stageSkills(dir: string, want: SkillRef[]): { dir: string; staged: string[]; failed: string[] } {
  // User scope only. A repository's own never come through here: they exist just
  // inside the container that cloned them, where `SKILL_SYNC` links them.
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

/**
 * Say once that a project's own skills have not been enumerated yet.
 *
 * Not "unreachable", which is what this said before `SKILL_SYNC` existed: the
 * listing arrives from the first container that clones the repository, so before
 * that there is nothing to list and after it there is. Once per project — a
 * standing condition repeated every poll is a feed nobody reads.
 */
const skillsWarned = new Set<number>();

/**
 * Tests, and only tests. The fifth module-level hold, and the one that was not
 * reset between them: `bun test --rerun-each` runs a test again in the same
 * process, the set still remembers the first run, and the second emits nothing.
 * Reset from `test/support/setup.ts` beside the other four, because a rule every
 * caller has to remember is one the twentieth caller forgets.
 */
export function resetSkillsWarned(): void {
  skillsWarned.clear();
}
export function projectSkillsPending(ctx: Ctx, projectId: number, repoPath?: string | null): void {
  if (!repoPath || repoPath.startsWith("/") || skillsWarned.has(projectId)) return;
  if (projectSkills(ctx.db, projectId).length) return;
  skillsWarned.add(projectId);
  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    body:
      `${repoPath} 自带的技能还没列出来 —— 代码只在容器里，得等第一个组克隆完才数得清（找的是 ${PROJECT_SKILL_DIRS.join("、")}）。` +
      `那之后它们会自动出现在这里，也能在输入框里 /名字 点名。技能放在这几个目录之外的话，两边都看不到。`,
  });
}
