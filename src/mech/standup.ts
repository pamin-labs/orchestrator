import type { DB } from "../db.ts";
import { overlaps, parseOwns } from "./ownership.ts";

/**
 * What a standup is actually for.
 *
 * Not the round of status updates — those are already on the blackboard. The
 * value is noticing duplicated effort and work that has quietly stopped, which
 * nobody in the room reports because nobody can see across the whole room.
 * Deterministic, so it costs nothing to run often.
 */

export interface StandupItem {
  kind: "duplicate_effort" | "stalled" | "repeat_failure";
  body: string;
  grpIds: number[];
}

export const STALL_MS = 60 * 60_000;

export function runStandup(db: DB, now = Date.now()): StandupItem[] {
  const items: StandupItem[] = [];

  // Two groups whose declared paths overlap while both are live. `canStart`
  // prevents this at start, but boundaries get widened afterwards.
  const live = db
    .query<{ id: number; name: string; owns_json: string; project_id: number }, []>(
      "SELECT id, name, owns_json, project_id FROM grp WHERE status IN ('RUNNING','PAUSING','PAUSED')",
    )
    .all();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.project_id !== b.project_id) continue;
      const hit = parseOwns(a.owns_json).find((x) =>
        parseOwns(b.owns_json).some((y) => overlaps(x, y)),
      );
      if (hit) {
        items.push({
          kind: "duplicate_effort",
          grpIds: [a.id, b.id],
          body: `${a.name} and ${b.name} both hold paths matching ${hit} — one of them widened its boundary after starting`,
        });
      }
    }
  }

  // Work that stopped without anybody saying so. A blocked group is fine: it is
  // waiting on an answer and somebody knows. Silence is the problem.
  const stalled = db
    .query<{ id: number; name: string; last: number | null }, [number]>(
      `SELECT g.id, g.name, (SELECT max(at) FROM event WHERE grp_id = g.id) AS last
       FROM grp g WHERE g.status = 'RUNNING'
         AND (SELECT count(*) FROM escalation e
              WHERE e.grp_id = g.id AND e.chain_state NOT IN ('answered','revoked')) = 0
         AND coalesce((SELECT max(at) FROM event WHERE grp_id = g.id), 0) < ?`,
    )
    .all(now - STALL_MS);
  for (const g of stalled) {
    const mins = g.last ? Math.round((now - g.last) / 60000) : null;
    items.push({
      kind: "stalled",
      grpIds: [g.id],
      body: `${g.name} has been running with nothing happening for ${mins ?? "?"} min and nobody is waiting on an answer`,
    });
  }

  // The same gate failing across several groups is a project problem, not three
  // separate coding problems.
  // Only the latest attempt per (resource, group) counts. Counting every failed
  // row ever recorded made a gate that had since gone green keep reporting
  // itself broken in four groups, with nothing that could ever clear it.
  const repeats = db
    .query<{ resource: string; n: number }, []>(
      `SELECT l.resource AS resource, count(*) AS n
       FROM (SELECT resource, grp_id, max(id) AS last_id FROM lease
             WHERE grp_id IS NOT NULL GROUP BY resource, grp_id) g
       JOIN lease l ON l.id = g.last_id
       WHERE l.state = 'failed' GROUP BY l.resource HAVING n >= 2`,
    )
    .all();
  for (const r of repeats) {
    items.push({
      kind: "repeat_failure",
      grpIds: [],
      body: `${r.resource} is failing in ${r.n} different groups — likely the project, not the groups`,
    });
  }

  return items;
}
