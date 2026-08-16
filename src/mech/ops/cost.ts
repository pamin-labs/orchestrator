import type { DB } from "../../db.ts";
import { jsonOr } from "../util/text.ts";
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

export interface CostRow {
  label: string;
  tokens: number;
}

/**
 * One agent's spend, with what it was spending it on.
 *
 * Per agent rather than per role, and carrying the model, because that is the
 * pair the boss reads together: "the engineer took 4M" is half a fact until you
 * know which model it took them on. `grpId` NULL means standing — paid for across
 * the project rather than by one requirement.
 */
export interface HourRow {
  /** Local hour, `MM-DD HH`. Formatted here so the panel does not re-derive a timezone. */
  hour: string;
  claude: number;
  codex: number;
}

export interface AgentCost extends CostRow {
  id: number;
  grpId: number | null;
  role: string;
  model: string;
  runtime: string;
}

export interface CostReport {
  /** Requirements that finished, for a per-requirement average worth quoting. */
  delivered: { count: number; tokens: number };
  byGroup: (CostRow & { grpId: number })[];
  /**
   * Every agent's spend with its group, so the panel can nest what is nested:
   * project, then requirement, then the people in it. An agent is either standing
   * (`grp_id` NULL, paid for across the project) or hired into one group. Four flat
   * tables said all of that was the same shape, which is a lie about the data
   * model.
   */
  agents: AgentCost[];
  byRole: CostRow[];
  byDifficulty: CostRow[];
  /** Which subscription paid. The axis that appeared the day roles split across two. */
  byRuntime: CostRow[];
  /**
   * The last 24 hours, per hour, split by provider.
   *
   * The only question on this page that a number cannot answer: how fast is it
   * burning right now, and which of the two accounts is carrying it. Hourly
   * because that is the resolution the work has — 300 to 700 turns an hour on a
   * busy night. 48 hours was two screens of chart to answer a question about now.
   */
  byHour: HourRow[];
  total: CostRow;
  /** Cache hit ratio across recorded turns; the only visible sign caching works. */
  cacheRatio: number | null;
  /** Of those same turns, how many opened a cold session, and what triggered it. */
  rotations: { turns: number; byReason: Record<string, number> };
}

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

export function costReport(db: DB, projectId?: number): CostReport {
  const where = projectId ? "WHERE project_id = ?" : "";
  const args = projectId ? [projectId] : [];

  const byGroup = db
    .query<CostRow & { grpId: number }, number[]>(
      `SELECT id AS grpId, name AS label, spent_tokens AS tokens FROM grp
       ${where} ORDER BY spent_tokens DESC LIMIT 50`,
    )
    .all(...args);

  const agents = db
    .query<AgentCost, number[]>(
      `SELECT id, grp_id AS grpId, role, role AS label, model, runtime, total_tokens AS tokens
       FROM agent ${where} ORDER BY tokens DESC`,
    )
    .all(...args);

  const byRole = db
    .query<CostRow, number[]>(
      `SELECT role AS label, sum(total_tokens) AS tokens FROM agent
       ${where} GROUP BY role ORDER BY tokens DESC`,
    )
    .all(...args);

  // The project filter was missing here, so one project's cost panel showed every
  // project's difficulty mix — and the difficulty tag is the cost knob the whole
  // panel exists to inform.
  const byDifficulty = db
    .query<CostRow, number[]>(
      `SELECT s.difficulty AS label, sum(s.spent_tokens) AS tokens
       FROM slice s JOIN grp g ON g.id = s.grp_id
       ${projectId ? "WHERE g.project_id = ?" : ""}
       GROUP BY s.difficulty ORDER BY tokens DESC`,
    )
    .all(...args);

  const byRuntime = db
    .query<CostRow, number[]>(
      `SELECT runtime AS label, sum(total_tokens) AS tokens FROM agent
       ${where} GROUP BY runtime ORDER BY tokens DESC`,
    )
    .all(...args);

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
    .query<CostRow, number[]>(`SELECT 'total' AS label, coalesce(sum(spent_tokens), 0) AS tokens FROM grp ${where}`)
    .get(...args)!;

  // What a finished requirement costs is the number to compare against doing it by
  // hand — PLAN.md §13 risk ② turns on exactly this ratio.
  const delivered = db
    .query<{ count: number; tokens: number }, number[]>(
      `SELECT count(*) AS count, coalesce(sum(spent_tokens), 0) AS tokens FROM grp
       WHERE status = 'DISSOLVED' ${projectId ? "AND project_id = ?" : ""}`,
    )
    .get(...args)!;

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
