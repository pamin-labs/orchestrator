import type { Ctx } from "../mech/ctx.ts";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { hostClaudeHome, hostCodexHome } from "./sandbox/auth.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DB } from "../platform/persistence/database.ts";
import { jsonOr } from "../contracts/json.ts";
import { z } from "zod";

/**
 * Skills reach an agent two ways, and both are needed.
 *
 * **Discovered.** `stageSkills` builds one directory out of what the boss ticked;
 * the sandbox mounts it read-only at `STAGED_SKILLS` and `SKILL_SYNC` links every
 * entry into both CLIs' own skill directories, so the agent finds and invokes a
 * skill by itself. The same pass links whatever the *repository* ships
 * (`PROJECT_SKILL_DIRS`) into the same two places — which is the only way a repo
 * skill reaches codex at all, since codex has no project-local skills directory.
 *
 * This half is prefix: every skill in there costs name + description on EVERY
 * turn of EVERY agent (measured: the boss's whole ~180-skill set plus slash
 * commands was ~46k cached tokens). That is the bill the tick boxes control, and
 * why the settings page states it out loud. A repository's own are not tickable —
 * shipping one is the decision.
 *
 * **Injected.** The boss naming a skill in a requirement appends that SKILL.md to
 * that one turn's delta (`executor.ts`, via `readSkillIn`). A user skill is read
 * here; a project skill is read out of the container, because that is the only
 * copy. Narrower than the catalogue and free: one turn pays for one skill, and it
 * works for a skill that was never ticked.
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

const SkillRefSchema = z.object({
  name: z.string(),
  file: z.string(),
  rel: z.string(),
  description: z.string(),
  scope: z.enum(["project", "user"]),
});
const SkillFrontmatter = z.object({ description: z.string().optional() });

/**
 * Where a repository can ship its own skills. See `listSkills` for the counts
 * behind this list and which CLI actually reads each one.
 */
const PROJECT_SKILL_DIRS = [".claude/skills", ".codex/skills", ".agents/skills"] as const;

/** Skill text is instructions, not a library. Past this it is being used wrong. */
const SKILL_CAP = 12_000;

/**
 * The `description:` from a skill's frontmatter, including the block-scalar form.
 *
 * `Bun.YAML.parse` rather than a regex and a hand-rolled indentation walk.
 * Real skills are written `description: |` with the text on the following
 * indented lines; the one-line regex this started as returned "|", which is
 * what the picker showed. The replacement for that was 20 lines that folded
 * `>-` the way `|` folds and could match a `description:` in the body text
 * below the frontmatter — and the parser was already in use three files over.
 *
 * The head may be a truncated read (`slice(0, 4000)`), so a parse failure is
 * normal rather than exceptional: fall back to the first line, do not throw.
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
  // operation — the repository's own skills arrive through `project`, which
  // `projectSkills` reads from what `SKILL_SYNC` enumerated in the container.
  //
  // **Which directories, and why these.** `.claude/skills` is not a universal
  // convention — it is claude's. Counted as exact strings in each CLI's own
  // binary (`codex-cli 0.147.0`, `claude 2.1.232`, in `orch/agent:1`):
  //
  //   claude   .claude/skills 93   .codex/skills 0   .agents/skills 0
  //   codex    .codex/skills  3    .claude/skills 0  .agents/skills 0
  //
  // and codex's three are one sentence about `$CODEX_HOME/skills`. So codex has
  // **no project-local skills directory**, and claude's is read from its working
  // directory. `.agents/skills` is the wider ecosystem's (`npx skills add
  // --agent` writes there) and neither CLI reads it.
  //
  // Which is why delivery is `SKILL_SYNC`'s symlink farm rather than anything
  // here: all three conventions are listed, and all three are linked into both
  // CLIs' own directories inside the container.
  if (repoPath?.startsWith("/")) {
    for (const dir of PROJECT_SKILL_DIRS) scan(repoPath, dir, "project", out);
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
  // The ecosystem's shared home. `npx skills add --agent <name>` installs here
  // and links into each CLI's directory — measured on this machine, every one of
  // `~/.claude/skills`'s 93 entries is a symlink into `~/.agents/skills`, so
  // scanning it adds **nothing here**. That is exactly why it is worth scanning:
  // the case it covers is the machine where those links were never made (one CLI
  // installed, or `--agent` pointed somewhere else), and there the skills are
  // present, invisible, and there is nothing to notice. Last, so a CLI's own copy
  // still wins the name.
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
    // Escaped: a skill name is a directory name off disk, and it went into the
    // pattern raw. `c++` is a legal directory and an illegal regex, so one such
    // skill made every message throw on its way to being read; a name with a `.`
    // silently matched the wrong skill and injected it into the turn.
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
 * A user skill is on this machine and is read here — it is the same file the
 * mount carries, and reading it locally costs nothing. A project skill exists
 * *only* in the container, so it is fetched over the files API (1-5ms, not the
 * ~1s an exec costs). Naming one in a requirement has to work for both, or the
 * repository's own skills are listed in the panel and inert when pointed at.
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
 * `owner/name` and the checkout lives inside a sandbox — so the listing that the
 * settings page and `/name` need has to be carried back and kept. `SKILL_SYNC`
 * prints it on the exec that already probes the checkout; this is where it
 * lands.
 *
 * A `setting` row rather than a `note`: it is a cache of something the container
 * owns, not something anybody decided. Stale between a push that adds a skill
 * and the next group's first turn, which is the honest ceiling of caching a
 * remote directory and is why the cache is rewritten on every turn's probe.
 */
const PROJECT_KEY = (id: number) => `skills.project.${id}`;

export function projectSkills(db: DB, projectId: number | null | undefined): SkillRef[] {
  if (!projectId) return [];
  const row = db.query<{ v: string }, [string]>("SELECT v FROM setting WHERE k = ?").get(PROJECT_KEY(projectId));
  return jsonOr(row?.v, z.array(SkillRefSchema), []);
}

/**
 * Read `SKILL_SYNC`'s inventory lines out of an exec's stdout and store them.
 *
 * Returns what it stored so a caller can report it. Absence of any line is a
 * real answer — a repository with no skills — so it writes the empty list too;
 * treating "none" as "do not touch the cache" is how a removed skill stays
 * listed forever.
 *
 * The one case it will not write is a container that never got as far as running
 * the script, which the caller distinguishes because the exec itself failed.
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
  db.run("INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [
    PROJECT_KEY(projectId),
    JSON.stringify(out),
  ]);
  return out;
}

/** A removed project should not leave its skills behind in `setting`. */
export function forgetProjectSkills(db: DB, projectId: number): void {
  db.run("DELETE FROM setting WHERE k = ?", [PROJECT_KEY(projectId)]);
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
  return jsonOr(row?.v, z.array(z.string()), []);
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
  return stageSkills(
    dir,
    listSkills().filter((s) => !off.has(s.name)),
  );
}

/**
 * The one directory every sandbox mounts, built from the skills still ticked.
 *
 * Mounted at `STAGED_SKILLS`, not at either CLI's own path: `SKILL_SYNC` links
 * out of here into both, which is what leaves those directories writable enough
 * for a repository's own skills to join them.
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
 * repository's own never come through here: they exist only inside the container
 * that cloned them, and `SKILL_SYNC` links them in there.
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
 * Say once that a project's own skills have not been enumerated yet.
 *
 * Not the same thing as "unreachable", which is what this used to say and what
 * was true before `SKILL_SYNC` existed. The listing now arrives from the first
 * container that clones the repository, so before that container there is
 * nothing to list — and after it there is, without anyone doing anything.
 *
 * `listSkills` is a pure function with no bus, so the report lives with the
 * caller that has one. Once per project: a standing condition repeated every
 * poll is a feed nobody reads.
 */
const skillsWarned = new Set<number>();
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
