import type { Ctx } from "../../api.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { CODEX_HOME, hostClaudeHome, hostCodexHome } from "../sandbox/auth.ts";
import { dirname, join } from "node:path";
import type { DB } from "../../db.ts";

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

/**
 * `relBase` is separate from `base` because the two answer different questions:
 * `base` is where to look under `root`, `relBase` is the conventional path that
 * goes into `rel` and is matched against older message text (migration 026). A
 * user who moved `~/.claude` with `$CLAUDE_CONFIG_DIR` changes the first and must
 * not change the second.
 */
function scan(
  root: string,
  base: string,
  scope: SkillRef["scope"],
  out: SkillRef[],
  relBase = base,
): void {
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
export function listSkills(repoPath?: string | null): SkillRef[] {
  const out: SkillRef[] = [];
  // A host path, or nothing. `repo_path` is `owner/name` since 007 §2 and the
  // checkout only exists inside containers, so this scan silently found nothing
  // and a project that ships its own skills simply stopped having them — the
  // failure `scan` was already noted for, one level up. Spelled out rather than
  // left as an accident, and reported by the caller that has a bus
  // (`projectSkillsUnreachable`). Reading them out of the group's container is
  // 007 step 6.
  if (repoPath?.startsWith("/")) {
    scan(repoPath, ".claude/skills", "project", out);
    scan(repoPath, ".agents/skills", "project", out);
  }
  // Wherever each CLI actually keeps its state: `$CLAUDE_CONFIG_DIR` and
  // `$CODEX_HOME` both move it, and a boss who set either would have seen every
  // ticked skill stage zero files with nothing said — `scan` skips a directory
  // that is not there, which is the right behaviour and the wrong answer.
  scan(hostClaudeHome(), "skills", "user", out, ".claude/skills");
  // The other CLI keeps its own, and the boss has no reason to care which
  // directory a skill lives in — the text is inlined into the turn either way, so
  // a codex skill works on a claude role and the reverse. Second, so a same-named
  // skill resolves to the .claude one (the dedupe above is first-wins).
  scan(hostCodexHome(), "skills", "user", out, ".codex/skills");
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
    const bySlash = new RegExp(`(?:^|\\s)/${s.name}(?![\\w-])`).test(text);
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
  return ref.scope === "project" ? ref.rel : `/root/.claude/skills/${ref.name}/SKILL.md`;
}

/** The skill's own text, capped, with its path so the agent can read the rest. */
export function readSkill(ref: SkillRef): string {
  const where = pathInSandbox(ref);
  let body = "";
  try {
    body = readFileSync(ref.file, "utf8");
  } catch {
    return `(${where} could not be read)`;
  }
  const cut = body.length > SKILL_CAP;
  return (
    `### ${ref.name}  (${where})\n\n${body.slice(0, SKILL_CAP)}` +
    (cut ? `\n\n(truncated — the rest is in ${where}, open it with Read if you need it)` : "")
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
export function restageSkills(db: DB, dir: string): ReturnType<typeof stageSkills> {
  const off = new Set(skillsOff(db));
  return stageSkills(dir, listSkills().filter((s) => !off.has(s.name)));
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
export function stageSkills(dir: string, want: SkillRef[]): { dir: string; staged: string[]; failed: string[] } {
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
 * Say once that a project's own skills cannot be reached from here.
 *
 * `listSkills` is a pure function with no bus, so the report lives with the
 * caller that has one. Once per project: this is a standing condition until 007
 * step 6 moves the read into the container, and a standing condition repeated
 * every poll is a feed nobody reads.
 */
/** codex's own search path inside the container; claude uses the checkout. */
const CODEX_SKILLS = `${CODEX_HOME}/skills`;

const skillsWarned = new Set<number>();
export function projectSkillsUnreachable(ctx: Ctx, projectId: number, repoPath?: string | null): void {
  if (!repoPath || repoPath.startsWith("/") || skillsWarned.has(projectId)) return;
  skillsWarned.add(projectId);
  ctx.bus.emit({
    author: "orchestrator",
    kind: "state_change",
    // What is unreachable is the *listing*, not the skills. Said precisely,
    // because the old wording ("读不到") read as "the agents do not get them" and
    // sent someone looking for a mechanism that is not needed: a project skill
    // lives in the checkout the CLI already runs in, which is what `getSkills`
    // means by "always visible and nothing to tick".
    body:
      `${repoPath} 自带的技能（.claude/skills）在设置页里列不出来 —— 代码只在容器里，这台机器上没有那个目录。` +
      `agent 那边不受影响：技能就在它的工作目录里，CLI 自己会发现；影响的只是你在输入框里 /名字 点名它。`,
  });
}

/**
 * Put the project's own skills where codex looks, inside the container.
 *
 * claude discovers `.claude/skills` relative to its working directory, and the
 * agent's working directory *is* the checkout — so a repository that ships
 * skills already hands them to a claude turn with nothing from us. This
 * repository relies on exactly that for its own `git-commit`.
 *
 * codex does not: its search path is `$CODEX_HOME/skills`, which is why the
 * boss's ticked skills are mounted at both. So a repo's skills reached claude
 * agents and not codex ones — the same asymmetry `LINK_AGENTS_MD` exists for,
 * fixed the same way and for the same reason: one link, in the container, rather
 * than a mechanism on the host.
 *
 * `-sfn` so a rebuilt container and a re-entered group both land the same way.
 */
export const LINK_PROJECT_SKILLS =
  `mkdir -p ${CODEX_SKILLS} && for d in .claude/skills/*/ .agents/skills/*/; do ` +
  `[ -d "$d" ] && ln -sfn "$PWD/$d" ${CODEX_SKILLS}/"$(basename "$d")"; done; true`;
