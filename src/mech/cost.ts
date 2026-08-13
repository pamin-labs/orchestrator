import type { DB } from "../db.ts";

/**
 * Where the money went.
 *
 * Three dimensions, because each answers a different question the boss actually
 * has: which requirement was expensive, which role is expensive, and whether the
 * difficulty tags are honest. The last one matters most — the tags are the cost
 * knob, and a knob nobody measures gets turned at random.
 */

export interface CostRow {
  label: string;
  tokens: number;
  usd: number;
}

export interface CostReport {
  /** Requirements that finished, for a per-requirement average worth quoting. */
  delivered: { count: number; usd: number };
  byGroup: CostRow[];
  byRole: CostRow[];
  byDifficulty: CostRow[];
  total: CostRow;
  /** Cache hit ratio across recorded turns; the only visible sign caching works. */
  cacheRatio: number | null;
}

export function costReport(db: DB, projectId?: number): CostReport {
  const where = projectId ? "WHERE project_id = ?" : "";
  const args = projectId ? [projectId] : [];

  const byGroup = db
    .query<CostRow, any[]>(
      `SELECT name AS label, spent_tokens AS tokens, spent_usd AS usd FROM grp
       ${where} ORDER BY spent_usd DESC LIMIT 20`,
    )
    .all(...args);

  const byRole = db
    .query<CostRow, any[]>(
      `SELECT role AS label, sum(total_tokens) AS tokens, sum(total_usd) AS usd FROM agent
       ${where} GROUP BY role ORDER BY usd DESC`,
    )
    .all(...args);

  // The project filter was missing here, so one project's cost panel showed every
  // project's difficulty mix — and the difficulty tag is the cost knob the whole
  // panel exists to inform.
  const byDifficulty = db
    .query<CostRow, any[]>(
      `SELECT s.difficulty AS label, sum(s.spent_tokens) AS tokens, sum(s.spent_usd) AS usd
       FROM slice s JOIN grp g ON g.id = s.grp_id
       ${projectId ? "WHERE g.project_id = ?" : ""}
       GROUP BY s.difficulty ORDER BY usd DESC`,
    )
    .all(...args);

  const total = db
    .query<CostRow, any[]>(
      `SELECT 'total' AS label, coalesce(sum(spent_tokens), 0) AS tokens,
              coalesce(sum(spent_usd), 0) AS usd FROM grp ${where}`,
    )
    .get(...args)!;

  // What a finished requirement costs is the number to compare against doing it by
  // hand — PLAN.md §13 risk ② turns on exactly this ratio.
  const delivered = db
    .query<{ count: number; usd: number }, any[]>(
      `SELECT count(*) AS count, coalesce(sum(spent_usd), 0) AS usd FROM grp
       WHERE status = 'DISSOLVED' ${projectId ? "AND project_id = ?" : ""}`,
    )
    .get(...args)!;

  return { delivered, byGroup, byRole, byDifficulty, total, cacheRatio: recentCacheRatio(db) };
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
    try {
      const v = JSON.parse(r.meta_json)?.cacheRatio;
      if (typeof v === "number") vals.push(v);
    } catch {}
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
