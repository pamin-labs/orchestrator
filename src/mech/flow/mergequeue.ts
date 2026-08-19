import { and, asc, eq, isNotNull, max, sql } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { agent, channel, grp } from "../../platform/persistence/schema.ts";

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
  const existing = orm(db).select({ merge_seq: grp.merge_seq }).from(grp).where(eq(grp.id, grpId)).get();
  if (existing?.merge_seq != null) return existing.merge_seq;

  // Table-wide `max`, not per project: merge order is one line across the whole
  // install, as it was. The `?? 0` covers both an empty table and all-NULL.
  const next =
    (orm(db)
      .select({ m: max(grp.merge_seq) })
      .from(grp)
      .get()?.m ?? 0) + 1;
  orm(db).update(grp).set({ merge_seq: next, merge_seq_at: sql`unixepoch() * 1000` }).where(eq(grp.id, grpId)).run();
  return next;
}

export function queue(db: DB, projectId: number): QueueEntry[] {
  return (
    orm(db)
      .select({ grpId: grp.id, name: grp.name, branch: grp.branch, seq: grp.merge_seq })
      .from(grp)
      .where(and(eq(grp.project_id, projectId), isNotNull(grp.merge_seq), eq(grp.status, "PR_OPEN")))
      .orderBy(asc(grp.merge_seq))
      .all()
      // The `IS NOT NULL` above already guarantees this, but `merge_seq` is a
      // nullable column and the schema says so. Narrowed rather than asserted: the
      // old generic simply declared `seq: number` over the same nullable column.
      .filter((e): e is QueueEntry => e.seq !== null)
  );
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
  const me = orm(db)
    .select({ project_id: grp.project_id, merge_seq: grp.merge_seq })
    .from(grp)
    .where(eq(grp.id, grpId))
    .get();
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
  const me = orm(db).select({ project_id: grp.project_id }).from(grp).where(eq(grp.id, grpId)).get();
  // Read before the write, as it was: this group has to leave the queue before
  // `queue()` below is asked who is still in it.
  orm(db).update(grp).set({ status: "DISSOLVED", merge_seq: null, merge_seq_at: null }).where(eq(grp.id, grpId)).run();

  // Wind the group up: sessions are worthless now, but the channel and every
  // event stay. A later group grepping this history is the only long-term memory
  // the system has, so archiving must never mean deleting.
  orm(db).update(agent).set({ state: "retired", session_id: null, token: null }).where(eq(agent.grp_id, grpId)).run();
  orm(db).update(channel).set({ status: "archived" }).where(eq(channel.grp_id, grpId)).run();

  if (!me) return [];
  return queue(db, me.project_id).map((e) => e.grpId);
}
