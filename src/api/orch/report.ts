import { dirname, join } from "node:path";
import { validateJournal } from "../../mech/util/validate.ts";
import { execIn, putFile, WORK } from "../../mech/sandbox/sandbox.ts";
import { shq } from "../../mech/util/shq.ts";
import { z } from "zod";
import { bad, text, type AgentHandler } from "../shared.ts";
import { Prose } from "../valid.ts";
import type { Ctx } from "../../ctx.ts";

/**
 * What an agent says about itself: the one-line status, and the journal.
 *
 * The journal is the only thing an agent writes that outlives its session, so
 * everything expensive about it is here — the line cap, the export path, and
 * the eviction that keeps a project's lessons to a number that fits in a cached
 * prefix without pushing the prefix around.
 */

/** One line of what this agent is doing. Empty is allowed: it clears the line. */
export const StatusBody = z.object({ text: z.string().max(200).default("") });

export const postStatus: AgentHandler<z.infer<typeof StatusBody>> = async (ctx, _req, a, _p, b) => {
  ctx.db.run("UPDATE agent SET activity = ? WHERE id = ?", [b.text, a.id]);
  ctx.bus.live({ grpId: a.grp_id, agentId: a.id, role: a.role, kind: "status", body: b.text });
  return text("ok");
};

/**
 * `kind` is not an enum here on purpose.
 *
 * `validateJournal` owns the closed set and the line cap, it is the same
 * function the DRAFT card and the self-review go through, and its refusals are
 * written to teach an agent what to write instead. Duplicating the list in a
 * schema would give two answers to "what kinds are there", and the schema's
 * would be the one nobody updated.
 */
export const JournalBody = z.object({
  kind: z.string().min(1),
  body: Prose(),
  files: z.array(z.string()).max(200).optional(),
  slice_id: z.number().int().positive().optional(),
});

export const postJournal: AgentHandler<z.infer<typeof JournalBody>> = async (ctx, _req, a, _p, b) => {
  const v = validateJournal({ kind: b.kind, body: b.body, files: b.files });
  if (!v.ok) return bad(v.error);

  const grp = a.grp_id
    ? ctx.db
        .query<{ name: string; project_id: number }, [number]>(
          "SELECT name, project_id FROM grp WHERE id = ?",
        )
        .get(a.grp_id)
    : null;

  const frontmatter = {
    group: grp?.name ?? null,
    role: a.role,
    slice: b.slice_id ?? null,
    kind: v.kind,
    files: b.files ?? [],
  };

  // journal/retro live in the repo so they merge with the PR and the next group
  // can grep them; the rest stay on the blackboard only.
  let exportPath: string | null = null;
  if ((v.kind === "journal" || v.kind === "retro" || v.kind === "decision") && a.grp_id) {
    const seq = ctx.db
      .query<{ c: number }, [number]>("SELECT count(*) AS c FROM note WHERE grp_id = ?")
      .get(a.grp_id!)!.c;
    exportPath = join("docs", "journal", grp!.name, `${String(seq + 1).padStart(3, "0")}-${v.kind}.md`);
    const fm = Object.entries(frontmatter)
      .map(([k, val]) => `${k}: ${Array.isArray(val) ? `[${val.join(", ")}]` : val}`)
      .join("\n");
    // Into the sandbox's checkout, so it merges with the PR like any other file.
    // Quoted: the path carries `grp.name`, and a group can name its own children
    // (`orch split`). Unquoted this was one `;` away from being a command.
    await execIn(ctx, { grp: a.grp_id }, `mkdir -p ${shq(`${WORK}/${dirname(exportPath)}`)}`);
    await putFile(ctx, { grp: a.grp_id }, `${WORK}/${exportPath}`, `---\n${fm}\n---\n${v.body}\n`);
  }

  ctx.db.run(
    `INSERT INTO note (project_id, grp_id, slice_id, kind, lang, body, frontmatter_json, export_path, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      grp?.project_id ?? null,
      a.grp_id,
      b.slice_id ?? null,
      v.kind,
      ctx.config.language,
      v.body,
      JSON.stringify(frontmatter),
      exportPath,
      Date.now(),
    ],
  );
  // The lessons list is capped where it is written, not where it is read: an
  // ever-growing list becomes the very context cost it exists to prevent.
  if (v.kind === "lesson") evictOldestLessons(ctx, grp?.project_id ?? null);

  // A retro is what PR-level review was waiting for. Without this the flow
  // dead-ends: the PM writes the retro nobody asked for again, and the branch sits
  // finished and unreviewed until someone nudges it by hand.
  if (v.kind === "retro" && a.grp_id) {
    const open = ctx.db
      .query<{ c: number }, [number]>(
        "SELECT count(*) AS c FROM slice WHERE grp_id = ? AND status != 'accepted'",
      )
      .get(a.grp_id)!.c;
    if (open === 0) {
      ctx.sched.enqueue("reconcile", { grp_id: a.grp_id, priority: 5 });
      ctx.sched.tick();
    }
  }

  ctx.bus.emit({
    grpId: a.grp_id,
    author: a.role,
    kind: "note",
    intent: v.kind === "decision" ? "decision" : "note",
    body: v.body,
    meta: { kind: v.kind, exportPath },
  });
  return text(exportPath ? `ok ${exportPath}` : "ok");
};

export const LESSON_CAP = 20;

/** Keep only the newest LESSON_CAP lessons for a project. */
export function evictOldestLessons(ctx: Ctx, projectId: number | null): number {
  const r = ctx.db.run(
    `DELETE FROM note WHERE kind = 'lesson' AND (project_id IS ? OR (? IS NULL AND project_id IS NULL))
       AND id NOT IN (
         SELECT id FROM note WHERE kind = 'lesson' AND (project_id IS ? OR (? IS NULL AND project_id IS NULL))
         ORDER BY at DESC, id DESC LIMIT ?
       )`,
    [projectId, projectId, projectId, projectId, LESSON_CAP],
  );
  return r.changes;
}
