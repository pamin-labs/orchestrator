import { dirname, join } from "node:path";
import { addNote } from "../../mech/util/rows.ts";
import { z } from "zod";
import type { Ctx } from "../../mech/ctx.ts";
import type { Caller } from "../../http/agent-auth.ts";
import type { AgentHandler } from "../../http/handler.ts";
import { bad, message } from "../../http/respond.ts";
import { evictOldestLessons } from "../../mech/knowledge/lessons.ts";
import { execIn, putFile, WORK } from "../../mech/sandbox/sandbox.ts";
import { shq } from "../../platform/process/shell.ts";
import type { JournalKind } from "../../mech/util/validate.ts";
import { validateJournal } from "../../mech/util/validate.ts";
import { Id, Prose } from "../../contracts/fields.ts";

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

export const postStatus = (async (ctx, _req, a, _p, b) => {
  ctx.db.run("UPDATE agent SET activity = ? WHERE id = ?", [b.text, a.id]);
  ctx.bus.live({ grpId: a.grp_id, agentId: a.id, role: a.role, kind: "status", body: b.text });
  return message("ok");
}) satisfies AgentHandler<z.infer<typeof StatusBody>>;

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
  slice_id: Id.optional(),
  /**
   * The decision this one overturns, if it overturns one.
   *
   * An id rather than prose, because the point is that retrieval can act on it: a
   * sentence saying "this replaces the earlier gate order" is invisible to the
   * index, and the earlier one keeps being answered with.
   */
  supersedes: Id.optional(),
});

type JournalGroup = { name: string; project_id: number };
export type Frontmatter = {
  group: string | null;
  role: string;
  slice: number | null;
  kind: JournalKind;
  files: string[];
};

/**
 * The journal file's frontmatter, serialised by the runtime rather than by hand.
 *
 * Concatenation had no escaping: a group named `auth: the sequel` produced
 * `group: auth: the sequel`, which is not YAML, and a file named `a,b.ts` became
 * two entries because the list was joined on commas. `files` is agent-supplied
 * and unconstrained. The `2` is what makes this block style rather than one flow
 * line — these files are committed and read by people.
 */
export function frontmatterBlock(frontmatter: Frontmatter): string {
  return Bun.YAML.stringify(frontmatter, null, 2);
}

async function exportJournal(
  ctx: Ctx,
  caller: Caller,
  group: JournalGroup | null,
  kind: JournalKind,
  body: string,
  frontmatter: Frontmatter,
): Promise<string | null> {
  if (!caller.grp_id || !group || !["journal", "retro", "decision"].includes(kind)) return null;

  const count = ctx.db
    .query<{ c: number }, [number]>("SELECT count(*) AS c FROM note WHERE grp_id = ?")
    .get(caller.grp_id)!.c;
  const path = join("docs", "journal", group.name, `${String(count + 1).padStart(3, "0")}-${kind}.md`);
  const yaml = frontmatterBlock(frontmatter);
  await execIn(ctx, { grp: caller.grp_id }, `mkdir -p ${shq(`${WORK}/${dirname(path)}`)}`);
  await putFile(ctx, { grp: caller.grp_id }, `${WORK}/${path}`, `---\n${yaml}\n---\n${body}\n`);
  return path;
}

function queueCompletedRetro(ctx: Ctx, groupId: number | null, kind: JournalKind): void {
  if (kind !== "retro" || !groupId) return;
  const open = ctx.db
    .query<{ c: number }, [number]>("SELECT count(*) AS c FROM slice WHERE grp_id = ? AND status != 'accepted'")
    .get(groupId)!.c;
  if (open !== 0) return;
  ctx.sched.enqueue("reconcile", { grp_id: groupId, priority: 5 });
  ctx.sched.tick();
}

export const postJournal = (async (ctx, _req, a, _p, b) => {
  const v = validateJournal({ kind: b.kind, body: b.body, ...(b.files ? { files: b.files } : {}) });
  if (!v.ok) return bad(v.error);

  const grp = a.grp_id
    ? ctx.db
        .query<{ name: string; project_id: number }, [number]>("SELECT name, project_id FROM grp WHERE id = ?")
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
  const exportPath = await exportJournal(ctx, a, grp, v.kind, v.body, frontmatter);

  addNote(ctx.db, {
    projectId: grp?.project_id ?? null,
    grpId: a.grp_id,
    sliceId: b.slice_id ?? null,
    kind: v.kind,
    lang: ctx.config.language,
    body: v.body,
    frontmatterJson: JSON.stringify(frontmatter),
    exportPath,
    ...(b.supersedes === undefined ? {} : { supersedes: b.supersedes }),
  });
  // The lessons list is capped where it is written, not where it is read: an
  // ever-growing list becomes the very context cost it exists to prevent.
  if (v.kind === "lesson") evictOldestLessons(ctx.db, grp?.project_id ?? null);

  // A retro is what PR-level review was waiting for. Without this the flow
  // dead-ends: the PM writes the retro nobody asked for again, and the branch sits
  // finished and unreviewed until someone nudges it by hand.
  queueCompletedRetro(ctx, a.grp_id, v.kind);

  ctx.bus.emit({
    grpId: a.grp_id,
    author: a.role,
    kind: "note",
    intent: v.kind === "decision" ? "decision" : "note",
    body: v.body,
    meta: { kind: v.kind, exportPath },
  });
  return message(exportPath ? `ok ${exportPath}` : "ok");
}) satisfies AgentHandler<z.infer<typeof JournalBody>>;
