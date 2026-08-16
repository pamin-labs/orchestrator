import { expect, test } from "bun:test";
import { z } from "zod";
import { Bus } from "../src/bus.ts";
import { openMemory } from "../src/db.ts";
import { Scheduler } from "../src/scheduler.ts";
import { snapshot } from "../src/api/panel/snapshot.ts";
import * as S from "../src/api/panel/shapes.ts";
import type { Ctx } from "../src/ctx.ts";
import { seedAuth } from "./seed-auth.ts";

/**
 * The panel payload is what the SQL actually produced.
 *
 * `db.query<Row>` is an unchecked cast: SQLite returns whatever the SELECT
 * named and TypeScript believes the annotation. So a migration that renames a
 * column, or a SELECT that drops one, produces `undefined` on the browser's side
 * of the wire and nothing anywhere errors — the type still says `string`, the
 * page renders "undefined", and the first person to notice is the boss.
 *
 * This runs the real query against a real database and parses the result. It is
 * a test rather than a check inside the route because this is our own payload:
 * validating it on every poll would cost real time on a page that re-reads it on
 * every state change, and would catch nothing this does not.
 */
test("every row the panel is sent matches the shape it is declared as", () => {
  const db = openMemory();
  seedAuth(db);
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    waiters: new Map(),
    config: { language: "中文" },
  };

  // One of everything the payload can carry, so no list is empty — an empty
  // array parses against any element schema and would make this vacuous.
  db.run("INSERT INTO project (name, repo_path, remote, base_branch, created_at) VALUES ('p','o/p','g','main',0)");
  db.run(
    "INSERT INTO grp (project_id, name, status, branch, budget_tokens, created_at) VALUES (1,'g1','RUNNING','orch/g1',100,0)",
  );
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1,'g2','DISSOLVED',0)");
  db.run(
    "INSERT INTO slice (grp_id, seq, title, accept_spec, difficulty, status, created_at) VALUES (1,1,'S1','x','normal','gate',0)",
  );
  db.run("INSERT INTO task (grp_id, slice_id, title, status, created_at) VALUES (1,1,'t','open',0)");
  db.run("INSERT INTO agent (project_id, grp_id, role, model, state, created_at) VALUES (1,1,'engineer','m','idle',0)");
  db.run("INSERT INTO channel (project_id, grp_id, kind, created_at) VALUES (1,1,'group',0)");
  db.run(
    "INSERT INTO escalation (grp_id, severity, question, brief, kind, chain_state, created_at) VALUES (1,'blocker','q','b','spec','boss',0)",
  );

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
