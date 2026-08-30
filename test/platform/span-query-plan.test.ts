import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { openMemory } from "../../src/platform/persistence/database.ts";

/**
 * The system scope reaches its rows by index, not by reading the table.
 *
 * `docs/project/archive/2026-08.md` records indexes being tried and rejected — on
 * SQLite, where `span_scope (grp_id, slice_id, started_at)` trapped the planner
 * behind an unconstrained middle column and the cost turned out to be sorting.
 * PostgreSQL plans it the other way and that finding does not transfer, so this
 * asserts the plan rather than trusting either engine's reputation.
 */

const ROWS = 20_000;
const DAY = 86_400_000;

/** The predicate `traceList` and `stageStats` share: no project, no group, in window. */
const SYSTEM_SCOPE = (since: number) =>
  `SELECT * FROM "span" WHERE project_id IS NULL AND grp_id IS NULL AND started_at >= ${since} ` +
  // any-order: nothing reads these rows. The statement exists to be handed to
  // EXPLAIN, and the sort is here because it is what makes the planner choose
  // between span_age and a sequential scan — which is the subject.
  `ORDER BY started_at DESC LIMIT 20`;

test("a system-scope read is an index scan, on a table too big to sequentially scan", async () => {
  const db = await openMemory();
  const now = Date.now();
  // 94% unscoped, which is the real skew rather than a convenient one: the
  // watchdog writes most of this table and its spans belong to no project, and
  // that skew is exactly what makes the system scope the expensive read.
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const scoped = i % 100 < 6 ? "1" : "null";
    return `('t${i}','s${i}',null,'watchdog.tick','internal',${now - i * 1000},12.5,'unset','{}'::jsonb,${scoped},${scoped},null,null)`;
  });
  for (let i = 0; i < rows.length; i += 2_000) {
    await db.execute(
      sql.raw(
        `INSERT INTO "span" (trace_id,span_id,parent_span_id,name,kind,started_at,duration_ms,status,attributes_json,project_id,grp_id,slice_id,status_message) VALUES ${rows.slice(i, i + 2_000).join(",")}`,
      ),
    );
  }
  // Without statistics the planner guesses, and a guess is not a plan worth
  // asserting. This is what the server's own autovacuum does on its schedule.
  await db.execute(sql`ANALYZE "span"`);

  const explained = await db.execute(sql.raw(`EXPLAIN ${SYSTEM_SCOPE(now - DAY)}`));
  const plan = JSON.stringify(explained);

  expect(plan).toContain("Index Scan");
  // The one that matters: `span_age (started_at)`. `span_scope` leads with
  // `grp_id`, which this predicate only knows to be NULL, so choosing it would be
  // the SQLite trap arriving on a different engine.
  expect(plan).toContain("span_age");
  expect(plan).not.toContain("Seq Scan");
}, 60_000);
