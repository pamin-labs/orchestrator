import { desc, eq } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { agent, grp } from "../../platform/persistence/schema.ts";
import type { CostReport } from "../../contracts/cost.ts";
import { jsonOr } from "../../contracts/json.ts";
import { z } from "zod";

/**
 * Where the tokens went.
 *
 * Tokens, not dollars, and every ordering here says so. On a subscription the
 * dollar figure is notional — claude's CLI reports what the turn would have cost at
 * API rates, codex reports nothing — and neither is what the month costs. So
 * ranking by `usd` put every codex role at the bottom with a $0 that reads as free
 * work.
 */
/**
 * Four dimensions, each answering a question the boss actually has: which
 * requirement was expensive, which role is expensive, whether the difficulty tags
 * are honest, and — since the work runs across two accounts — which account is
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
 * Seven queries take the same optional filter, and it used to be assembled as a
 * string per call — two statement texts per query, and seven places a reader had
 * to check what was being pasted into SQL. `?1 IS NULL` says it in the statement,
 * so every query below is a constant prepared and cached once and the id only ever
 * arrives as a parameter.
 */
/**
 * Written out at each site rather than pasted from a constant, because a constant
 * puts these back to being assembled templates — the thing being removed. The OR
 * costs the planner an index on `project_id`; these are per-project aggregates on
 * one boss's database, read when a panel opens.
 */
type ProjectArg = [number | null];

/** How many requirements the ranking offers. Was a literal inside the query. */
const GROUP_LIMIT = 50;

export function costReport(db: DB, projectId?: number): CostReport {
  const of: ProjectArg = [projectId ?? null];

  // The filter is a condition rather than `(?1 IS NULL OR project_id = ?1)`, which
  // is how SQL says "optional" when it has no way to leave a clause out.
  const inProject = <T extends typeof grp.project_id | typeof agent.project_id>(column: T) =>
    projectId === undefined ? undefined : eq(column, projectId);

  const byGroup = orm(db)
    .select({ grpId: grp.id, label: grp.name, tokens: grp.spent_tokens })
    .from(grp)
    .where(inProject(grp.project_id))
    .orderBy(desc(grp.spent_tokens))
    .limit(GROUP_LIMIT)
    .all();

  const agents = orm(db)
    .select({
      id: agent.id,
      grpId: agent.grp_id,
      role: agent.role,
      label: agent.role,
      model: agent.model,
      runtime: agent.runtime,
      tokens: agent.total_tokens,
    })
    .from(agent)
    .where(inProject(agent.project_id))
    .orderBy(desc(agent.total_tokens))
    .all();

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
 * How many of the recent turns started a session instead of resuming one, and which
 * trigger did it.
 *
 * A separate number from the ratio above because a low cache ratio can mean the
 * prompt assembly broke or that nobody is resuming anything, and those have
 * different fixes. Measured on this repo before it existed: 10 of 13 claude jobs
 * opened cold, roughly 17k of prefix rebuilt each time, with no way to tell whether
 * the cause was a moving prefix, the rotation ceiling, or send-backs.
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
