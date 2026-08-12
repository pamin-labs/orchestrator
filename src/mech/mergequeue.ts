import type { DB } from "../db.ts";

/**
 * Strictly serial merge order.
 *
 * One branch lands, main goes green, the next one is offered. Optimistic
 * parallel merging is faster right up to the morning the boss has to work out
 * which of three groups turned main red overnight — and the boss is the only
 * person here, so that cost lands on the one person the system exists to spare.
 */

export interface QueueEntry {
  grpId: number;
  name: string;
  branch: string | null;
  seq: number;
}

/** Called when a branch passes its audit: it takes the next slot in line. */
export function joinQueue(db: DB, grpId: number): number {
  const existing = db
    .query<{ merge_seq: number | null }, [number]>("SELECT merge_seq FROM grp WHERE id = ?")
    .get(grpId);
  if (existing?.merge_seq != null) return existing.merge_seq;

  const next =
    (db.query<{ m: number | null }, []>("SELECT max(merge_seq) AS m FROM grp").get()?.m ?? 0) + 1;
  db.run("UPDATE grp SET merge_seq = ? WHERE id = ?", [next, grpId]);
  return next;
}

export function queue(db: DB, projectId: number): QueueEntry[] {
  return db
    .query<QueueEntry, [number]>(
      `SELECT id AS grpId, name, branch, merge_seq AS seq FROM grp
       WHERE project_id = ? AND merge_seq IS NOT NULL AND status = 'PR_OPEN'
       ORDER BY merge_seq`,
    )
    .all(projectId);
}

/**
 * The one branch the boss is asked to merge right now.
 *
 * Everything behind it stays queued rather than being presented, because three
 * "ready to merge" cards is an invitation to merge them in the wrong order.
 */
export function head(db: DB, projectId: number): QueueEntry | null {
  return queue(db, projectId)[0] ?? null;
}

export function position(db: DB, grpId: number): { position: number; total: number } | null {
  const me = db
    .query<{ project_id: number; merge_seq: number | null }, [number]>(
      "SELECT project_id, merge_seq FROM grp WHERE id = ?",
    )
    .get(grpId);
  if (!me || me.merge_seq == null) return null;
  const q = queue(db, me.project_id);
  const idx = q.findIndex((e) => e.grpId === grpId);
  return idx === -1 ? null : { position: idx + 1, total: q.length };
}

/**
 * A branch landed. It leaves the queue, and everyone still queued has to rebase:
 * their branch point is now stale, and a stale base is what turns a clean merge
 * into a conflict later.
 */
export function landed(db: DB, grpId: number): number[] {
  const me = db
    .query<{ project_id: number }, [number]>("SELECT project_id FROM grp WHERE id = ?")
    .get(grpId);
  db.run("UPDATE grp SET status = 'DISSOLVED', merge_seq = NULL WHERE id = ?", [grpId]);
  if (!me) return [];
  return queue(db, me.project_id).map((e) => e.grpId);
}
