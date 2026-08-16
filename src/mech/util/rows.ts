import type { DB } from "../../db.ts";

/**
 * The three row questions this codebase asks over and over.
 */

/**
 * Which project a group belongs to.
 *
 * Eighteen sites wrote this out, most as the same three-line ternary. It is the
 * lookup that turns a group-scoped thing into a project-scoped one — the scope a
 * standing agent works at — so it appears wherever those two meet.
 */
export const projectOfGrp = (db: DB, grpId: number | null | undefined): number | null =>
  grpId == null
    ? null
    : (db.query<{ project_id: number | null }, [number]>("SELECT project_id FROM grp WHERE id = ?").get(grpId)
        ?.project_id ?? null);

/** Which project an agent belongs to. A standing agent has one and no group. */
export const projectOfAgent = (db: DB, agentId: number | null | undefined): number | null =>
  agentId == null
    ? null
    : (db.query<{ project_id: number | null }, [number]>("SELECT project_id FROM agent WHERE id = ?").get(agentId)
        ?.project_id ?? null);

/**
 * A note of which a project keeps exactly one: the repo map, the page index.
 *
 * Newest-wins with the old row deleted, rather than an upsert, because `note` has
 * no unique key to conflict on — kind is not unique per project for any other
 * kind, and adding one for these two would constrain the table for the sake of
 * two writers.
 *
 * Returns whether anything changed. Both callers use that: an unchanged map must
 * not bump the row's `at`, or every consumer that watches "when did this last
 * move" sees movement on every tick.
 */
export function saveSingletonNote(db: DB, projectId: number, kind: string, body: string): boolean {
  const prev = db
    .query<{ id: number; body: string }, [number, string]>(
      "SELECT id, body FROM note WHERE project_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
    )
    .get(projectId, kind);
  if (prev?.body === body) return false;
  if (prev) db.run("DELETE FROM note WHERE id = ?", [prev.id]);
  db.run("INSERT INTO note (project_id, kind, body, at) VALUES (?, ?, ?, unixepoch() * 1000)", [
    projectId,
    kind,
    body,
  ]);
  return true;
}

/** The body of that note, or null. */
export const singletonNote = (db: DB, projectId: number | null, kind: string): string | null =>
  projectId == null
    ? null
    : (db
        .query<{ body: string }, [number, string]>(
          "SELECT body FROM note WHERE project_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
        )
        .get(projectId, kind)?.body ?? null);
