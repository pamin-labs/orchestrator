import { count, eq, gte, inArray, isNotNull, max } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { orm } from "../../platform/persistence/orm.ts";
import { grp, lease } from "../../platform/persistence/schema.ts";
import { overlaps, parseOwns } from "./ownership.ts";
import { ESCALATION_TERMINAL_STATES, stateParam } from "../../contracts/states.ts";

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
  const live = orm(db)
    .select({ id: grp.id, name: grp.name, owns_json: grp.owns_json, project_id: grp.project_id })
    .from(grp)
    .where(inArray(grp.status, ["RUNNING", "PAUSING", "PAUSED"]))
    .all();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.project_id !== b.project_id) continue;
      const hit = parseOwns(a.owns_json).find((x) => parseOwns(b.owns_json).some((y) => overlaps(x, y)));
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
  // Raw: `json_each(?)` binds the terminal-state subset the way every such
  // predicate here does, and the two `max(at)` reads are correlated subqueries
  // against the outer row, which Drizzle's builder has no form for.
  const stalled = db
    .query<{ id: number; name: string; last: number | null }, [string, number]>(
      `SELECT g.id, g.name, (SELECT max(at) FROM event WHERE grp_id = g.id) AS last
       FROM grp g WHERE g.status = 'RUNNING'
         AND (SELECT count(*) FROM escalation e WHERE e.grp_id = g.id
              AND e.chain_state NOT IN (SELECT value FROM json_each(?))) = 0
         AND coalesce((SELECT max(at) FROM event WHERE grp_id = g.id), 0) < ?`,
    )
    .all(stateParam(ESCALATION_TERMINAL_STATES), now - STALL_MS);
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
  const lastPerResourceAndGroup = orm(db)
    .select({ last_id: max(lease.id).as("last_id") })
    .from(lease)
    .where(isNotNull(lease.grp_id))
    .groupBy(lease.resource, lease.grp_id)
    .as("g");
  const repeats = orm(db)
    .select({ resource: lease.resource, n: count() })
    .from(lastPerResourceAndGroup)
    .innerJoin(lease, eq(lease.id, lastPerResourceAndGroup.last_id))
    .where(eq(lease.state, "failed"))
    .groupBy(lease.resource)
    .having(gte(count(), 2))
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
