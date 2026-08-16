import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { relinkSkills } from "../../mech/sandbox/sandbox.ts";
import { listSkills, projectSkills, projectSkillsPending, restageSkills, setSkillOff, skillsOff } from "../../mech/skills.ts";
import { z } from "zod";
import { bad, json, type Handler } from "../shared.ts";
import { expandHome } from "./attach.ts";

/**
 * Three read-mostly panels: the blackboard, the skill tick boxes, and the
 * directory picker that adds a project.
 *
 * Grouped by who reads them rather than by what they touch, which is the honest
 * description — they are what is left once every subject with a shape of its
 * own has one.
 */

/**
 * The blackboard's static half, readable.
 *
 * `note` holds every journal, decision, retro, risk, handoff, onboarding pack and
 * lesson — PLAN.md §7 calls the lesson list "the only mechanism by which the
 * twentieth group is smarter than the first" — and none of it was reachable from
 * the panel at all. Agents could `orch ctx query` it; the boss could not read it.
 */
export const getNotes: Handler = async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const project = q.get("project");
  const group = q.get("group");
  const kind = q.get("kind");
  const where: string[] = [];
  const args: any[] = [];
  if (group) {
    where.push("n.grp_id = ?");
    args.push(Number(group));
  } else if (project) {
    // Project scope includes the standing notes (onboarding, lessons) that belong
    // to no group, which is exactly where they matter.
    where.push("(n.project_id = ? OR g.project_id = ?)");
    args.push(Number(project), Number(project));
  }
  if (kind) {
    where.push("n.kind = ?");
    args.push(kind);
  }
  // The draft card is a note too, and it already has its own screen.
  where.push("coalesce(json_extract(n.frontmatter_json, '$.draft_card'), 0) != 1");
  // Nor are the index's own rows notes: `pageindex` is a serialised tree and
  // `map` is a rendered directory listing, both stored here because `note` was
  // the table that already existed. Neither is anything the boss reads.
  where.push("n.kind NOT IN ('pageindex', 'map')");

  const rows = ctx.db
    .query<unknown, any[]>(
      `SELECT n.id, n.grp_id AS grpId, n.kind, n.body, n.at, n.export_path AS exportPath,
              n.frontmatter_json AS frontmatter, g.name AS "group"
       FROM note n LEFT JOIN grp g ON g.id = n.grp_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY n.at DESC LIMIT 300`,
    )
    .all(...args);
  return json({ notes: rows });
};

/**
 * Every skill on this machine, and whether agents can see it.
 *
 * `on` is what the boss ticked: those get staged into the directory every sandbox
 * mounts, so an agent discovers and invokes them itself. Unticked ones are still
 * listed — naming one in a requirement injects it into that single turn — which is
 * why the composer offers all of them and asks before using an unticked one.
 */
export const getSkills: Handler = async (ctx, req) => {
  const id = Number(new URL(req.url).searchParams.get("project"));
  const repo = ctx.db
    .query<{ repo_path: string }, [number]>("SELECT repo_path FROM project WHERE id = ?")
    .get(id)?.repo_path;
  projectSkillsPending(ctx, id, repo);
  const off = new Set(skillsOff(ctx.db));
  return json({
    skills: listSkills(repo, projectSkills(ctx.db, id)).map(({ name, rel, description, scope }) => ({
      name,
      path: rel,
      description,
      scope,
      // A project skill ships with the repository the group is working on, so it
      // is always delivered and there is nothing to tick.
      on: scope === "project" || !off.has(name),
    })),
  });
};

/**
 * Tick or untick one skill, then rebuild the staging directory.
 *
 * Rebuilt now rather than at the next sandbox: the mount is a directory, so what
 * changes here is visible to every running container as soon as the next turn's CLI
 * process starts. No sandbox is rebuilt for a tick box.
 */
/** No name is a rescan; a name plus `on` is a tick box. */
export const SkillBody = z.object({ name: z.string().max(200).optional(), on: z.boolean().optional() });

export const postSkill: Handler<z.infer<typeof SkillBody>> = async (ctx, _req, _p, b) => {
  // No name is a rescan: the boss installed or removed a skill outside this
  // process, and the staged copy is the only thing that does not know yet.
  if (b.name) setSkillOff(ctx.db, b.name, b.on === false);
  const { staged, failed } = restageSkills(ctx.db, ctx.config?.skillsDir ?? "/var/tmp/orch-cache/skills");
  // The mount is a staging path now, not either CLI's own directory, so a
  // changed set is not visible until the links are rebuilt. Every live
  // container, because a standing agent's container has no checkout and so no
  // other moment that would ever redo them.
  await relinkSkills();
  return json({ staged: staged.length, failed });
};

export const getDirs: Handler = async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const asked = q.get("path") ?? homedir();
  const path = resolve(expandHome(asked));
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (e) {
    return bad(`${path}: ${(e as Error).message}`);
  }
  const taken = new Set(
    ctx.db.query<{ repo_path: string }, []>("SELECT repo_path FROM project").all().map((r) => r.repo_path),
  );
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const full = join(path, d.name);
      return { name: d.name, path: full, repo: existsSync(join(full, ".git")), taken: taken.has(full) };
    })
    .sort((a, b) => (a.repo === b.repo ? a.name.localeCompare(b.name) : a.repo ? -1 : 1));
  // Files only when someone is picking files. The repo picker asking for them
  // would list a thousand entries in a source directory to choose one folder.
  const files = q.get("files")
    ? entries
        .filter((d) => d.isFile() && !d.name.startsWith("."))
        .map((d) => {
          const full = join(path, d.name);
          let size = 0;
          try {
            size = statSync(full).size;
          } catch {}
          return { name: d.name, path: full, size };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  // A repo can be picked at any level, including the one being listed.
  return json({
    path,
    parent: path === "/" ? null : dirname(path),
    repo: existsSync(join(path, ".git")),
    dirs,
    files,
  });
};
