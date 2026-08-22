import { msg, plural } from "@lingui/core/macro";
import { and, count, eq, gte, inArray, isNotNull, max, notInArray } from "drizzle-orm";
import type { DB } from "../../platform/persistence/database.ts";
import { maxMs, escalation, event, grp, lease } from "../../platform/persistence/schema.ts";
import { overlaps, parseOwns } from "./ownership.ts";
import { ESCALATION_TERMINAL_STATES } from "../../contracts/states.ts";
import type { Said } from "../../contracts/said.ts";

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
  /**
   * Named, not written — the same field and the same reason as `Finding.say` in
   * `mech/ops/watchdog.ts`, and this struct was the one without it. Three
   * sentences were composed here in English and handed to `bus.emit` as
   * `body: item.body`, which is an identifier at the emit site, so
   * `an-event-names-its-sentence` saw data passing through and the panel drew
   * English in all ten locales.
   */
  say: Said;
  grpIds: number[];
}

export const STALL_MS = 60 * 60_000;

/**
 * Work that stopped without anybody saying so.
 *
 * A blocked group is fine — it is waiting on an answer and somebody knows.
 * Silence is the problem. Three queries and a join in JS, where this was one
 * statement with two correlated subqueries: Drizzle has no builder for those and
 * the alternative is raw SQL no column rename would break loudly. A standup runs
 * on a handful of running groups.
 */
async function stalled(db: DB, now: number): Promise<StandupItem[]> {
  const running = await db.select({ id: grp.id, name: grp.name }).from(grp).where(eq(grp.status, "RUNNING"));
  const ids = running.map((g) => g.id);
  if (ids.length === 0) return [];

  const heard = await db
    .select({ grp_id: event.grp_id, last: maxMs(event.at) })
    .from(event)
    .where(inArray(event.grp_id, ids))
    .groupBy(event.grp_id);
  const lastEvent = new Map(heard.flatMap((r) => (r.grp_id === null || r.last === null ? [] : [[r.grp_id, r.last]])));

  const open = await db
    .select({ grp_id: escalation.grp_id })
    .from(escalation)
    .where(and(inArray(escalation.grp_id, ids), notInArray(escalation.chain_state, [...ESCALATION_TERMINAL_STATES])));
  const asking = new Set(open.flatMap((r) => (r.grp_id === null ? [] : [r.grp_id])));

  return running.flatMap((g) => {
    const last = lastEvent.get(g.id) ?? null;
    if (asking.has(g.id) || (last ?? 0) >= now - STALL_MS) return [];
    const mins = last ? Math.round((now - last) / 60000) : null;
    return [
      {
        kind: "stalled" as const,
        grpIds: [g.id],
        say: msg`${{ name: g.name }} has been running with nothing happening for ${plural({ n: mins ?? 0 }, { one: "# minute", other: "# minutes" })} and nobody is waiting on an answer`,
      },
    ];
  });
}

export async function runStandup(db: DB, now = Date.now()): Promise<StandupItem[]> {
  const items: StandupItem[] = [];

  // Two groups whose declared paths overlap while both are live. `canStart`
  // prevents this at start, but boundaries get widened afterwards.
  const live = await db
    .select({ id: grp.id, name: grp.name, owns_json: grp.owns_json, project_id: grp.project_id })
    .from(grp)
    .where(inArray(grp.status, ["RUNNING", "PAUSING", "PAUSED"]));
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
          say: msg`${{ a: a.name }} and ${{ b: b.name }} both hold paths matching ${{ hit }} — one of them widened its boundary after starting`,
        });
      }
    }
  }

  items.push(...(await stalled(db, now)));

  // The same gate failing across several groups is a project problem, not three
  // separate coding problems.
  // Only the latest attempt per (resource, group) counts. Counting every failed
  // row ever recorded made a gate that had since gone green keep reporting
  // itself broken in four groups, with nothing that could ever clear it.
  const lastPerResourceAndGroup = db
    .select({ last_id: max(lease.id).as("last_id") })
    .from(lease)
    .where(isNotNull(lease.grp_id))
    .groupBy(lease.resource, lease.grp_id)
    .as("g");
  const repeats = await db
    .select({ resource: lease.resource, n: count() })
    .from(lastPerResourceAndGroup)
    .innerJoin(lease, eq(lease.id, lastPerResourceAndGroup.last_id))
    .where(eq(lease.state, "failed"))
    .groupBy(lease.resource)
    .having(gte(count(), 2));
  for (const r of repeats) {
    items.push({
      kind: "repeat_failure",
      grpIds: [],
      say: msg`${{ resource: r.resource }} is failing in ${plural({ n: r.n }, { one: "# group", other: "# different groups" })} — likely the project, not the groups`,
    });
  }

  return items;
}
