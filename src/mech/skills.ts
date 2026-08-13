import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Skills, materialised into the turn instead of loaded as a catalogue.
 *
 * Agents run with `--disable-slash-commands` and `--setting-sources project,local`,
 * both measured: the skill catalogue plus slash commands is ~46k cached tokens of
 * prefix on EVERY turn, and inheriting the boss's user-level setup pushed a trivial
 * haiku turn to ~195k. So "/impeccable" typed at an agent does nothing, and turning
 * the catalogue back on would tax every turn for a skill used in one.
 *
 * What the boss actually wants is narrower than a catalogue: *this* skill, on *this*
 * requirement. So the orchestrator reads the SKILL.md itself — on the host, where it
 * has the whole filesystem, including `~/.claude/skills` that the agent deliberately
 * cannot see — and appends the text to that turn's delta. One turn pays for one
 * skill, the cache prefix is untouched, and a user-level skill reaches an agent that
 * was never given access to it.
 *
 * The path travels with the message too, so anything the skill references (its
 * reference/*.md, its scripts) is one `Read` away for a role that has Read.
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
