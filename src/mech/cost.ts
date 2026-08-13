import type { DB } from "../db.ts";

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
  usd: number;
}

/** A role's spend, and which requirement it was spent inside. NULL = standing. */
export interface RoleCost extends CostRow {
  grpId: number | null;
}

export interface CostReport {
  /** Requirements that finished, for a per-requirement average worth quoting. */
  delivered: { count: number; tokens: number; usd: number };
  byGroup: (CostRow & { grpId: number })[];
  /**
   * Every role's spend with its group, so the panel can nest what is nested.
   * A slice belongs to a requirement and a role is either standing (Architect,
   * Dispatcher, CoS, Librarian — `grp_id` NULL, paid for across the project) or
   * hired into one group (PM, Engineer, QA). Four flat tables said all of that was
   * the same shape, which is a lie about the data model.
   */
  roles: RoleCost[];
  byRole: CostRow[];
  byDifficulty: CostRow[];
  /** Which subscription paid. The axis that appeared the day roles split across two. */
  byRuntime: CostRow[];
  total: CostRow;
  /** Cache hit ratio across recorded turns; the only visible sign caching works. */
  cacheRatio: number | null;
}

export function costReport(db: DB, projectId?: number): CostReport {
  const where = projectId ? "WHERE project_id = ?" : "";
  const args = projectId ? [projectId] : [];

  const byGroup = db
    .query<CostRow & { grpId: number }, any[]>(
      `SELECT id AS grpId, name AS label, spent_tokens AS tokens, spent_usd AS usd FROM grp
       ${where} ORDER BY spent_tokens DESC LIMIT 50`,
    )
    .all(...args);

  const roles = db
    .query<RoleCost, any[]>(
      `SELECT grp_id AS grpId, role AS label, sum(total_tokens) AS tokens, sum(total_usd) AS usd
       FROM agent ${where} GROUP BY grp_id, role ORDER BY tokens DESC`,
    )
    .all(...args);

  const byRole = db
    .query<CostRow, any[]>(
      `SELECT role AS label, sum(total_tokens) AS tokens, sum(total_usd) AS usd FROM agent
       ${where} GROUP BY role ORDER BY tokens DESC`,
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
       GROUP BY s.difficulty ORDER BY tokens DESC`,
    )
    .all(...args);

  const byRuntime = db
    .query<CostRow, any[]>(
      `SELECT runtime AS label, sum(total_tokens) AS tokens, sum(total_usd) AS usd FROM agent
       ${where} GROUP BY runtime ORDER BY tokens DESC`,
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
    .query<{ count: number; tokens: number; usd: number }, any[]>(
      `SELECT count(*) AS count, coalesce(sum(spent_tokens), 0) AS tokens,
              coalesce(sum(spent_usd), 0) AS usd FROM grp
       WHERE status = 'DISSOLVED' ${projectId ? "AND project_id = ?" : ""}`,
    )
    .get(...args)!;

  return { delivered, byGroup, roles, byRole, byDifficulty, byRuntime, total, cacheRatio: recentCacheRatio(db) };
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
