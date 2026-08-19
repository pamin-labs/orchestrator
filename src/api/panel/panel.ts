import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listProjectSkills, relinkSkills } from "../../mech/sandbox/sandbox.ts";
import {
  listSkills,
  projectSkills,
  projectSkillsPending,
  restageSkills,
  setSkillOff,
  skillsOff,
  cacheProjectSkills,
} from "../../mech/skills.ts";
import { z } from "zod";
import type { Handler } from "../../http/handler.ts";
import { bad, json } from "../../http/respond.ts";
import { expandHome } from "./attach.ts";
import { errText } from "../../platform/process/text.ts";
import type { PanelNote } from "../../contracts/notes.ts";
import { grp, note as notes, project } from "../../platform/persistence/schema.ts";

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
 * lesson — docs/project/plan.md §7 calls the lesson list "the only mechanism by which the
 * twentieth group is smarter than the first" — and none of it was reachable from
 * the panel at all. Agents could `orch ctx query` it; the boss could not read it.
 */
/** Exactly the columns the SELECT below names. `unknown` said nothing at all. */
export const NotesQuery = z.object({
  project: z.coerce.number().int().positive().optional(),
  group: z.coerce.number().int().positive().optional(),
  kind: z.string().min(1).max(80).optional(),
});

export const getNotes = (async (ctx, _req, _params, query) => {
  const { project: projectId, group, kind } = query;
  const scope = group
    ? eq(notes.grp_id, group)
    : // Project scope includes the standing notes (onboarding, lessons) that belong
      // to no group, which is exactly where they matter.
      projectId
      ? or(eq(notes.project_id, projectId), eq(grp.project_id, projectId))
      : undefined;
  const rows = await ctx.db
    .select({
      id: notes.id,
      grpId: notes.grp_id,
      kind: notes.kind,
      body: notes.body,
      at: notes.at,
      exportPath: notes.export_path,
      frontmatter: notes.frontmatter_json,
      group: grp.name,
    })
    .from(notes)
    .leftJoin(grp, eq(grp.id, notes.grp_id))
    .where(
      and(
        scope,
        kind ? eq(notes.kind, kind) : undefined,
        // The draft card is a note too, and it already has its own screen.
        // Raw: jsonb containment has no Drizzle operator. `@>` and not `->>` so a
        // row that never had the key is matched by the same expression as one
        // that has it set to something else.
        sql`not (${notes.frontmatter_json} @> '{"draft_card": true}'::jsonb)`,
        // Nor are the index's own rows notes: `pageindex` is a serialised tree and
        // `map` is a rendered directory listing, both stored here because `note` was
        // the table that already existed. Neither is anything the boss reads.
        notInArray(notes.kind, ["pageindex", "map"]),
      ),
    )
    .orderBy(desc(notes.at), desc(notes.id))
    .limit(300);
  // `frontmatter` is a string on the wire and the column is `jsonb`, so it is
  // re-encoded here rather than in `contracts/notes.ts`: the panel parses it with
  // its own schema, and the shape it parses is not this route's to change.
  const notesOut: PanelNote[] = rows.map((r) => ({ ...r, frontmatter: JSON.stringify(r.frontmatter) }));
  return json({ notes: notesOut });
}) satisfies Handler<z.infer<typeof NotesQuery>>;

/**
 * Every skill on this machine, and whether agents can see it.
 *
 * `on` is what the boss ticked: those get staged into the directory every sandbox
 * mounts, so an agent discovers and invokes them itself. Unticked ones are still
 * listed — naming one in a requirement injects it into that single turn — which is
 * why the composer offers all of them and asks before using an unticked one.
 */
/**
 * Optional, because this section is machine-scope: the staged directory is
 * mounted into every group of every project, so the list exists before any
 * project does. A project only adds its own repository's skills on top. This was
 * the one required `project` in the panel API while every sibling query made it
 * optional, so opening 技能 with no project selected answered a Zod error.
 */
export const SkillsQuery = z.object({ project: z.coerce.number().int().positive().optional() });

export const getSkills = (async (ctx, _req, _params, { project: id }) => {
  const [found] = id
    ? await ctx.db.select({ repo_path: project.repo_path }).from(project).where(eq(project.id, id))
    : [];
  const repo = found?.repo_path;
  if (id !== undefined) await projectSkillsPending(ctx, id, repo);
  const off = new Set(await skillsOff(ctx.db));
  const listed = await projectSkills(ctx.db, id);
  return json({
    skills: listSkills(repo, listed).map(({ name, rel, description, scope }) => ({
      name,
      path: rel,
      description,
      scope,
      // A project skill ships with the repository the group is working on, so it
      // is always delivered and there is nothing to tick.
      on: scope === "project" || !off.has(name),
    })),
  });
}) satisfies Handler<z.infer<typeof SkillsQuery>>;

/**
 * Tick or untick one skill, then rebuild the staging directory.
 *
 * Rebuilt now rather than at the next sandbox: the mount is a directory, so what
 * changes here is visible to every running container as soon as the next turn's CLI
 * process starts. No sandbox is rebuilt for a tick box.
 */
/**
 * No name is a rescan; a name plus `on` is a tick box.
 *
 * `project` only matters to a rescan, and only because a repository's own skills
 * are the half of the list this process cannot see for itself — it names whose
 * containers to ask.
 */
export const SkillBody = z.object({
  name: z.string().max(200).optional(),
  on: z.boolean().optional(),
  project: z.number().int().positive().optional(),
});

export const postSkill = (async (ctx, _req, _p, b) => {
  // No name is a rescan: the boss installed or removed a skill outside this
  // process, so both halves of the list are stale — the staged copy of this
  // machine's, and the cached inventory of every checkout's.
  if (b.name) await setSkillOff(ctx.db, b.name, b.on === false);
  const { staged, failed } = await restageSkills(ctx.db, ctx.config.skillsDir);
  // The mount is a staging path now, not either CLI's own directory, so a
  // changed set is not visible until the links are rebuilt. Every live
  // container, because a standing agent's container has no checkout and so no
  // other moment that would ever redo them.
  //
  await relinkSkills();
  // And the other half. `restageSkills` above only ever sees this machine's, so
  // until this the rescan answered for those and left a repository's at whatever
  // some group last said on a checkout probe — a skill deleted from the checkout
  // stayed listed, and the button that exists to correct exactly that was the
  // one thing that could not.
  //
  // Silence is not an empty repository: `cacheProjectSkills` writes an empty
  // list as a real answer, so a project with no container to ask must leave the
  // cache alone rather than clear it.
  if (b.project) {
    const listed = await listProjectSkills(ctx, b.project);
    if (listed !== null) await cacheProjectSkills(ctx.db, b.project, listed);
  }
  return json({ staged: staged.length, failed });
}) satisfies Handler<z.infer<typeof SkillBody>>;

export const DirsQuery = z.object({ path: z.string().max(4000).optional(), files: z.literal("1").optional() });

export const getDirs = (async (ctx, _req, _params, query) => {
  const asked = query.path ?? homedir();
  const path = resolve(expandHome(asked));
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (e) {
    return bad(`${path}: ${errText(e)}`);
  }
  const taken = new Set((await ctx.db.select({ repo_path: project.repo_path }).from(project)).map((r) => r.repo_path));
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const full = join(path, d.name);
      return { name: d.name, path: full, repo: existsSync(join(full, ".git")), taken: taken.has(full) };
    })
    .sort((a, b) => (a.repo === b.repo ? a.name.localeCompare(b.name) : a.repo ? -1 : 1));
  // Files only when someone is picking files. The repo picker asking for them
  // would list a thousand entries in a source directory to choose one folder.
  const files = query.files
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
}) satisfies Handler<z.infer<typeof DirsQuery>>;
