import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { openMemory } from "../../src/platform/persistence/database.ts";

/**
 * The reads the panel and the heartbeat make reach their rows by index.
 *
 * `span-query-plan.test.ts` next door asserts one plan for one index and says why
 * a plan is worth asserting rather than reasoning about; this is the same for the
 * five that were added after it. Each statement below is a real one — the file and
 * line it comes from is named — written out with literals because that is what
 * EXPLAIN takes, and each seeds the skew that makes the planner's choice real
 * rather than a guess over an empty table.
 */

const DAY = 86_400_000;

/** Enough rows that a sequential scan is the wrong answer, few enough to insert fast. */
const ROWS = 20_000;

const chunked = async (db: Awaited<ReturnType<typeof openMemory>>, table: string, cols: string, rows: string[]) => {
  for (let i = 0; i < rows.length; i += 2_000) {
    await db.execute(sql.raw(`INSERT INTO "${table}" (${cols}) VALUES ${rows.slice(i, i + 2_000).join(",")}`));
  }
  await db.execute(sql.raw(`ANALYZE "${table}"`));
};

const plan = async (db: Awaited<ReturnType<typeof openMemory>>, statement: string) =>
  JSON.stringify(await db.execute(sql.raw(`EXPLAIN ${statement}`)));

/**
 * The rows the foreign keys need, so the seeds below can be about their own table.
 *
 * Identities restart at 1 on every `openMemory`, so the ids these produce are
 * 1..n in insert order and the seeds can name them directly.
 */
async function seedParents(db: Awaited<ReturnType<typeof openMemory>>, groups: number): Promise<void> {
  await db.execute(sql.raw(`INSERT INTO "project" (name,repo_path,created_at) VALUES ('bench','acme/bench',0)`));
  await chunked(
    db,
    "grp",
    "project_id,name,status,created_at",
    Array.from({ length: groups }, (_, i) => `(1,'g${i}','RUNNING',0)`),
  );
}

/**
 * `state_change` is the kind by volume and no reader wants it, which is the whole
 * reason a kind prefix pays. Seeded at that ratio rather than a convenient one.
 */
async function seedEvents(db: Awaited<ReturnType<typeof openMemory>>, now: number): Promise<void> {
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const kind = i % 100 === 0 ? "tool_summary" : i % 50 === 0 ? "say" : "state_change";
    // A hundred rows past retention, which is what a steady-state trim finds: the
    // scan is worth indexing precisely because it almost never deletes anything.
    const at = i < 100 ? now - 30 * DAY : now - (i % DAY);
    const meta = kind === "tool_summary" ? `'{"usage":{"input":1}}'::jsonb` : `'{}'::jsonb`;
    return `(null,null,'engineer','${kind}','body',${meta},${at})`;
  });
  await chunked(db, "event", "channel_id,grp_id,author,kind,body,meta_json,at", rows);
}

test("the cost histogram reaches its turns by kind, not by reading the log", async () => {
  const db = await openMemory();
  const now = Date.now();
  await seedEvents(db, now);

  // `byHour`, src/mech/ops/cost.ts — the 24-hour bars, redrawn on every panel
  // refresh, which is up to four times a second while a fleet is moving.
  const explained = await plan(
    db,
    `SELECT at, meta_json FROM "event" ` +
      `WHERE kind = 'tool_summary' AND jsonb_exists(meta_json, 'usage') AND at > ${now - DAY}`,
  );
  expect(explained).toContain("event_kind");
  expect(explained).not.toContain("Seq Scan");
}, 60_000);

test("event retention finds the rows past the cutoff by index", async () => {
  const db = await openMemory();
  const now = Date.now();
  await seedEvents(db, now);

  // `trimEvents`, src/platform/persistence/event-bus.ts, on the thirty-second
  // heartbeat. The kinds are the `KEPT_FOREVER` list written out: EXPLAIN takes
  // literals, and a bind parameter is exactly what stops a partial index from
  // being matched — which is why this one is not partial.
  //
  // The index name is what makes this go red, not the `Seq Scan` line: without
  // `event_age` the planner falls back to a *full* scan of `event_kind` with
  // `at` as a non-boundary condition, because the negation leaves the leading
  // column unbounded. Measured on these 20,000 rows: 56.77 against 179.83, and
  // the gap widens with the table because one is the matching rows and the other
  // is every index entry.
  const explained = await plan(
    db,
    `DELETE FROM "event" WHERE at < ${now - 7 * DAY} AND kind NOT IN ('say','boss_say','note','escalation')`,
  );
  expect(explained).toContain("event_age");
  expect(explained).not.toContain("Seq Scan");
}, 60_000);

test("the card a group filed is found by group, not by reading every note", async () => {
  const db = await openMemory();
  const now = Date.now();
  await seedParents(db, 500);
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const card = i % 200 === 0 ? `'{"draft_card":true}'::jsonb` : `'{}'::jsonb`;
    return `(${(i % 500) + 1},'card','body',${card},${now - i})`;
  });
  await chunked(db, "note", "grp_id,kind,body,frontmatter_json,at", rows);

  // `cardFiledAt` in src/api/panel/snapshot.ts is this correlated on the event's
  // own group, so it runs once per candidate row; src/api/panel/group.ts asks it
  // again on every approve.
  const explained = await plan(
    db,
    `SELECT body FROM "note" WHERE grp_id = 7 AND frontmatter_json @> '{"draft_card": true}'::jsonb ` +
      `ORDER BY at DESC, id DESC LIMIT 1`,
  );
  expect(explained).toContain("note_grp");
  expect(explained).not.toContain("Seq Scan");
}, 60_000);

test("an agent's newest job is found by agent, on a table nothing prunes", async () => {
  const db = await openMemory();
  await seedParents(db, 50);
  await chunked(
    db,
    "agent",
    "project_id,grp_id,role,model,created_at",
    Array.from({ length: 500 }, (_, i) => `(1,${(i % 50) + 1},'engineer','model',0)`),
  );
  await chunked(
    db,
    "slice",
    "grp_id,seq,title,accept_spec,created_at",
    Array.from({ length: 50 }, (_, i) => `(${i + 1},1,'slice','passes',0)`),
  );
  const rows = Array.from({ length: ROWS }, (_, i) => `('agent_turn',${(i % 500) + 1},${(i % 50) + 1},'done',${i})`);
  await chunked(db, "job", "kind,agent_id,slice_id,state,enqueued_at", rows);

  // `agentSlice` in src/api/panel/snapshot.ts, correlated on the agent row being
  // selected — one per agent, on every panel refresh.
  const explained = await plan(
    db,
    `SELECT slice_id FROM "job" WHERE agent_id = 7 AND slice_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
  );
  expect(explained).toContain("job_agent");
  expect(explained).not.toContain("Seq Scan");
}, 60_000);

test("the span row-cap probe is answered by the index, without touching a row", async () => {
  const db = await openMemory();
  const now = Date.now();
  const rows = Array.from(
    { length: ROWS },
    (_, i) => `('t${i}','s${i}','watchdog.tick','internal',${now - i * 1000},12.5,'unset','{}'::jsonb,null,null,null)`,
  );
  await chunked(
    db,
    "span",
    "trace_id,span_id,name,kind,started_at,duration_ms,status,attributes_json,project_id,grp_id,slice_id",
    rows,
  );

  // `trimSpans`, src/platform/observability/span-store.ts, on the thirty-second
  // heartbeat. The delete it guards has two sort keys and selects `trace_id`,
  // which no index carries, so the planner sorts the table for it — measured here
  // at 3137 against a sequential scan, and it ran twice a minute to delete
  // nothing. This is the question asked for one column instead, which `span_age`
  // answers without reading a heap page.
  // Vacuumed, not only analysed: an index-only scan is costed against the
  // visibility map, which a fresh insert leaves empty and only a vacuum fills.
  // The 2026-09-03 nightly saw the first two of ten runs answer Seq Scan + Sort
  // and the rest the index — the table as autovacuum had or had not yet left it.
  await db.execute(sql.raw(`VACUUM ANALYZE "span"`));
  // A tiebreak would name a column `span_age` does not carry, and carrying none is
  // what makes this index-only.
  // any-order: existence, not identity — whether a row sits at the offset depends
  // on how many rows there are, never on which same-millisecond write came first.
  const probe = `SELECT started_at FROM "span" ORDER BY started_at DESC OFFSET ${ROWS / 2} LIMIT 1`;
  const explained = await plan(db, probe);
  expect(explained).toContain("Index Only Scan");
  expect(explained).toContain("span_age");
  expect(explained).not.toContain("Sort");
}, 60_000);
