import type { DB } from "../../platform/persistence/database.ts";
import type { CostReport } from "../../contracts/cost.ts";
import { jsonOr } from "../../contracts/json.ts";
import { z } from "zod";

/**
 * Where the tokens went.
 *
 * Tokens, not dollars, and every ordering here says so. On a subscription the
 * dollar figure is notional — claude's CLI reports what the same turn would have
 * cost at API rates, codex reports nothing at all, and neither is what the month
 * costs. The real currencies are the token count and the quota percentage in the
 * header, so ranking by `usd` put every codex role at the bottom of the table
 * with a $0 that reads as free work.
 *
 * Four dimensions, each answering a question the boss actually has: which
 * requirement was expensive, which role is expensive, whether the difficulty tags
 * are honest, and — since the work now runs across two accounts — which account is
 * being spent.
 */

const CostRowSchema = z.object({ label: z.string(), tokens: z.number() });
type CostRow = z.infer<typeof CostRowSchema>;

/**
 * One agent's spend, with what it was spending it on.
 *
 * Per agent rather than per role, and carrying the model, because that is the
 * pair the boss reads together: "the engineer took 4M" is half a fact until you
 * know which model it took them on. `grpId` NULL means standing — paid for across
 * the project rather than by one requirement.
 */
const HourRowSchema = z.object({
  /** Local hour, `MM-DD HH`. Formatted here so the panel does not re-derive a timezone. */
  hour: z.string(),
  claude: z.number(),
  codex: z.number(),
});
type HourRow = z.infer<typeof HourRowSchema>;

const AgentCostSchema = CostRowSchema.extend({
  id: z.number(),
  grpId: z.number().nullable(),
  role: z.string(),
  model: z.string(),
  runtime: z.string(),
});
type AgentCost = z.infer<typeof AgentCostSchema>;

/** The four counters a turn reports, summed. Written once; the CASE needs it twice. */
/**
 * Which account paid, from the turn event.
 *
 * Recorded on the event since this change; rows written before it fall back to
 * the model name, which is what the whole split used to be. A prefix match is
 * right until someone renames a model, and it was silently deciding a column.
 */
const RUNTIME = `coalesce(json_extract(meta_json, '$.runtime'),
                          CASE WHEN json_extract(meta_json, '$.model') LIKE 'gpt%' THEN 'codex' ELSE 'claude' END)`;

const TOK = `json_extract(meta_json, '$.usage.input') + json_extract(meta_json, '$.usage.output')
           + json_extract(meta_json, '$.usage.cacheRead') + json_extract(meta_json, '$.usage.cacheCreate')`;

/**
 * "This project, or all of them" as a bound parameter instead of a clause.
 *
 * Seven queries here take the same optional filter, and it used to be assembled
 * as a string per call: two different statement texts per query depending on the
 * argument, and seven places where a reader had to check what was being pasted
 * into the SQL. `?1 IS NULL` says the same thing in the statement itself, so
 * every query below is a constant string prepared once and cached once, and the
 * id only ever arrives as a parameter.
 *
 * Written out at each site rather than pasted in from a constant, because a
 * constant would put these back to being assembled templates — the thing being
 * removed. The clause is shorter than the note explaining it.
 *
 * The OR costs the planner an index on `project_id`. These are per-project
 * aggregates on a single boss's database, read when a panel opens.
 */
type ProjectArg = [number | null];

export function costReport(db: DB, projectId?: number): CostReport {
  const of: ProjectArg = [projectId ?? null];

  const byGroup = db
    .query<CostRow & { grpId: number }, ProjectArg>(
      `SELECT id AS grpId, name AS label, spent_tokens AS tokens FROM grp
       WHERE (?1 IS NULL OR project_id = ?1) ORDER BY spent_tokens DESC LIMIT 50`,
    )
    .all(...of);

  const agents = db
    .query<AgentCost, ProjectArg>(
      `SELECT id, grp_id AS grpId, role, role AS label, model, runtime, total_tokens AS tokens
       FROM agent WHERE (?1 IS NULL OR project_id = ?1) ORDER BY tokens DESC`,
    )
    .all(...of);

  const byRole = db
    .query<CostRow, ProjectArg>(
      `SELECT role AS label, sum(total_tokens) AS tokens FROM agent
       WHERE (?1 IS NULL OR project_id = ?1) GROUP BY role ORDER BY tokens DESC`,
    )
    .all(...of);

  // The project filter was missing here, so one project's cost panel showed every
  // project's difficulty mix — and the difficulty tag is the cost knob the whole
  // panel exists to inform.
  const byDifficulty = db
    .query<CostRow, ProjectArg>(
      `SELECT s.difficulty AS label, sum(s.spent_tokens) AS tokens
       FROM slice s JOIN grp g ON g.id = s.grp_id
       WHERE (?1 IS NULL OR g.project_id = ?1)
       GROUP BY s.difficulty ORDER BY tokens DESC`,
    )
    .all(...of);

  const byRuntime = db
    .query<CostRow, ProjectArg>(
      `SELECT runtime AS label, sum(total_tokens) AS tokens FROM agent
       WHERE (?1 IS NULL OR project_id = ?1) GROUP BY runtime ORDER BY tokens DESC`,
    )
    .all(...of);

  // From the turn events rather than a new table: recordCost already emits one per
  // turn with the usage and the model, and the model prefix is what says which
  // account paid — the event row has no agent to join back to.
  const byHour = db
    .query<HourRow, number[]>(
      `SELECT strftime('%m-%d %H', at / 1000, 'unixepoch', 'localtime') AS hour,
              coalesce(sum(CASE WHEN ${RUNTIME} = 'codex' THEN 0 ELSE ${TOK} END), 0) AS claude,
              coalesce(sum(CASE WHEN ${RUNTIME} = 'codex' THEN ${TOK} ELSE 0 END), 0) AS codex
       FROM event
       WHERE kind = 'tool_summary' AND meta_json LIKE '%usage%'
         AND at > (unixepoch() - 24 * 3600) * 1000
       GROUP BY hour ORDER BY hour`,
    )
    .all();

  const total = db
    .query<CostRow, ProjectArg>(
      `SELECT 'total' AS label, coalesce(sum(spent_tokens), 0) AS tokens FROM grp WHERE (?1 IS NULL OR project_id = ?1)`,
    )
    .get(...of)!;

  // What a finished requirement costs is the number to compare against doing it by
  // hand — docs/project/plan.md §13 risk ② turns on exactly this ratio.
  const delivered = db
    .query<{ count: number; tokens: number }, ProjectArg>(
      `SELECT count(*) AS count, coalesce(sum(spent_tokens), 0) AS tokens FROM grp
       WHERE status = 'DISSOLVED' AND (?1 IS NULL OR project_id = ?1)`,
    )
    .get(...of)!;

  return {
    delivered,
    byGroup,
    agents,
    byRole,
    byDifficulty,
    byRuntime,
    byHour,
    total,
    cacheRatio: recentCacheRatio(db),
    rotations: recentRotations(db),
  };
}

/**
 * Averaged over recent turns. A sudden drop means someone broke the prompt
 * assembly — which is invisible in every other way: the agents still work, the
 * tests still pass, and each turn quietly costs several times more.
 */
export function recentCacheRatio(db: DB, limit = 50): number | null {
  const rows = db
    .query<{ meta_json: string }, [number]>(
      `SELECT meta_json FROM event WHERE kind = 'tool_summary' AND meta_json LIKE '%cacheRatio%'
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(limit);
  const vals: number[] = [];
  for (const r of rows) {
    const v = jsonOr(r.meta_json, z.object({ cacheRatio: z.number().optional() }), {}).cacheRatio;
    if (v !== undefined) vals.push(v);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * How many of the recent turns started a session instead of resuming one, and
 * which trigger did it.
 *
 * The companion to the ratio above, and the reason it is a separate number: a
 * low cache ratio can mean the prompt assembly broke or it can mean nobody is
 * resuming anything, and those have different fixes. Measured on this repo's own
 * logs before it existed, 10 of 13 claude jobs opened cold — roughly 17k tokens
 * of prefix rebuilt each time — and there was no way to tell whether the cause
 * was a moving prefix, the rotation ceiling, or send-backs asking for it.
 */
function recentRotations(db: DB, limit = 50): { turns: number; byReason: Record<string, number> } {
  const rows = db
    .query<{ why: string | null }, [number]>(
      `SELECT json_extract(meta_json, '$.rotate') AS why FROM event
       WHERE kind = 'tool_summary' AND meta_json LIKE '%cacheRatio%'
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(limit);
  const byReason: Record<string, number> = {};
  for (const r of rows) if (r.why) byReason[r.why] = (byReason[r.why] ?? 0) + 1;
  return { turns: rows.length, byReason };
}
