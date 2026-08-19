import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { projectOfGrp } from "../util/rows.ts";
import { agent, channel, grp } from "../../platform/persistence/schema.ts";

/**
 * Strictly serial merge order.
 *
 * One branch lands, main goes green, the next one is offered. Optimistic
 * parallel merging is faster right up to the morning the boss has to work out
 * which of three groups turned main red overnight — and the boss is the only
 * person here, so that cost lands on the one person the system exists to spare.
 */

/** One line for the whole install, so one lock name for it. */
const QUEUE_LOCK = "orch:merge_queue";

export interface QueueEntry {
  grpId: number;
  name: string;
  branch: string | null;
  seq: number;
}

/** Called when a branch passes its audit: it takes the next slot in line. */
export async function joinQueue(db: DB, grpId: number): Promise<number | null> {
  // Reading the max and writing it back is two statements, and Postgres runs them
  // for two groups at once — both read the same max and both take slot 4, which is
  // the "which of three turned main red" morning this module exists to prevent.
  // SQLite made it atomic by being synchronous; here the lock has to be asked for.
  // Table-wide, because merge order is one line across the install, and the same
  // `pg_advisory_xact_lock` idiom `escalate.ts` files a question under.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${QUEUE_LOCK}))`);
    // Already in line keeps its own slot, whichever call put it there.
    const [existing] = await tx.select({ merge_seq: grp.merge_seq }).from(grp).where(eq(grp.id, grpId));
    if (existing?.merge_seq != null) return existing.merge_seq;
    const [taken] = await tx
      .update(grp)
      .set({
        // Aliased, and the column named through `sql.identifier`: an unaliased
        // `${grp.merge_seq}` renders as `grp.merge_seq`, which binds to the row
        // being updated rather than to the subquery — an aggregate in an UPDATE,
        // which Postgres refuses outright.
        merge_seq: sql`(SELECT coalesce(max(q.${sql.identifier(grp.merge_seq.name)}), 0) + 1 FROM ${grp} q)`,
        merge_seq_at: Date.now(),
      })
      .where(and(eq(grp.id, grpId), isNull(grp.merge_seq)))
      .returning({ merge_seq: grp.merge_seq });
    return taken?.merge_seq ?? null;
  });
}

export async function queue(db: DB, projectId: number): Promise<QueueEntry[]> {
  const rows = await db
    .select({
      grpId: grp.id,
      name: grp.name,
      branch: grp.branch,
      seq: grp.merge_seq,
    })
    .from(grp)
    .where(and(eq(grp.project_id, projectId), isNotNull(grp.merge_seq), eq(grp.status, "PR_OPEN")))
    .orderBy(asc(grp.merge_seq));
  // The `IS NOT NULL` above already guarantees this, but `merge_seq` is a
  // nullable column and the schema says so. Narrowed rather than asserted: the
  // old generic simply declared `seq: number` over the same nullable column.
  return rows.filter((e): e is QueueEntry => e.seq !== null);
}

/**
 * The one branch the boss is asked to merge right now.
 *
 * Everything behind it stays queued rather than being presented, because three
 * "ready to merge" cards is an invitation to merge them in the wrong order.
 */
export async function head(db: DB, projectId: number): Promise<QueueEntry | null> {
  return (await queue(db, projectId))[0] ?? null;
}

export async function position(db: DB, grpId: number): Promise<{ position: number; total: number } | null> {
  const [me] = await db
    .select({ project_id: grp.project_id, merge_seq: grp.merge_seq })
    .from(grp)
    .where(eq(grp.id, grpId));
  if (!me || me.merge_seq == null) return null;
  const q = await queue(db, me.project_id);
  const idx = q.findIndex((e) => e.grpId === grpId);
  return idx === -1 ? null : { position: idx + 1, total: q.length };
}

/**
 * A branch landed. It leaves the queue, and everyone still queued has to rebase:
 * their branch point is now stale, and a stale base is what turns a clean merge
 * into a conflict later.
 */
export async function landed(db: DB, grpId: number): Promise<number[]> {
  // Read before the write, as it was: this group has to leave the queue before
  // `queue()` below is asked who is still in it.
  const projectId = await projectOfGrp(db, grpId);
  await db.update(grp).set({ status: "DISSOLVED", merge_seq: null, merge_seq_at: null }).where(eq(grp.id, grpId));

  // Wind the group up: sessions are worthless now, but the channel and every
  // event stay. A later group grepping this history is the only long-term memory
  // the system has, so archiving must never mean deleting.
  await db.update(agent).set({ state: "retired", session_id: null, token: null }).where(eq(agent.grp_id, grpId));
  await db.update(channel).set({ status: "archived" }).where(eq(channel.grp_id, grpId));

  if (projectId === null) return [];
  return (await queue(db, projectId)).map((e) => e.grpId);
}
