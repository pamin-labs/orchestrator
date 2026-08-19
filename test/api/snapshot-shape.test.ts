import { expect, test } from "bun:test";
import { z } from "zod";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { snapshot } from "../../src/api/panel/snapshot.ts";
import * as S from "../../src/contracts/panel.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import * as fx from "../support/factories.ts";

/**
 * The panel payload is what the SQL actually produced.
 *
 * `db.query<Row>` is an unchecked cast: SQLite returns whatever the SELECT named and
 * TypeScript believes the annotation. So a migration that renames a column, or a
 * SELECT that drops one, produces `undefined` on the browser's side of the wire and
 * nothing errors — the type still says `string`, the page renders "undefined", and
 * the first person to notice is the boss.
 */
/**
 * This runs the real query against a real database and parses the result. A test
 * rather than a check inside the route because this is our own payload: validating
 * it on every poll would cost real time on a page that re-reads it on every state
 * change, and would catch nothing this does not.
 */
test("every row the panel is sent matches the shape it is declared as", () => {
  const db = openMemory();
  seedAuth(db);
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    waiters: new Map(),
    config: loadConfig(),
  };

  // One of everything the payload can carry, so no list is empty — an empty
  // array parses against any element schema and would make this vacuous.
  const p = fx.project.insert(db, { name: "p", repo_path: "o/p", remote: "g", base_branch: "main" });
  const g = fx.runningGrp.insert(db, {
    project_id: p.id,
    name: "g1",
    branch: "orch/g1",
    budget_tokens: 100,
  });
  fx.grp.insert(db, { project_id: p.id, name: "g2", status: "DISSOLVED" });
  const first = fx.slice.insert(db, { grp_id: g.id, seq: 1, title: "S1", status: "gate" });
  fx.task.insert(db, { grp_id: g.id, slice_id: first.id, title: "t", status: "pending" });
  fx.agent.insert(db, { project_id: p.id, grp_id: g.id, state: "idle" });
  fx.channel.insert(db, { project_id: p.id, grp_id: g.id });
  fx.escalation.insert(db, {
    grp_id: g.id,
    severity: "blocker",
    brief: "b",
    kind: "spec",
    chain_state: "boss",
  });

  const s = snapshot(ctx);
  const Snapshot = z.object({
    ready: z.boolean(),
    projects: z.array(S.Project),
    groups: z.array(S.Group),
    slices: z.array(S.Slice),
    tasks: z.array(S.Task),
    agents: z.array(S.Agent),
    channels: z.array(S.Channel),
    escalations: z.array(S.Escalation),
    draftCards: z.array(S.DraftCard),
    archived: z.array(S.Archived),
    lastSeq: z.number(),
  });

  const r = Snapshot.safeParse(s);
  // The message names the field and the row, which is what makes a red run here
  // worth anything at 2am.
  expect(r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);

  // And the fixture is doing its job: a payload of empty arrays parses against
  // anything, so an assertion over one proves nothing.
  expect(s.projects.length).toBeGreaterThan(0);
  expect(s.groups.length).toBeGreaterThan(0);
  expect(s.slices.length).toBeGreaterThan(0);
  expect(s.agents.length).toBeGreaterThan(0);
  expect(s.escalations.length).toBeGreaterThan(0);
});
