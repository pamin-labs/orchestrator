import { expect, test } from "bun:test";
import { z } from "zod";
import { snapshot } from "../../src/api/panel/snapshot.ts";
import * as S from "../../src/contracts/panel.ts";
import { seedAuth } from "../support/seed-auth.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

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
test("every row the panel is sent matches the shape it is declared as", async () => {
  const ctx = await testContext();
  const db = ctx.db;
  await seedAuth(db);
  const f = fx.on(db);

  // One of everything the payload can carry, so no list is empty — an empty
  // array parses against any element schema and would make this vacuous.
  const p = await f.project.create({ name: "p", repo_path: "o/p", remote: "g", base_branch: "main" });
  const g = await f.runningGrp.create({
    project_id: p.id,
    name: "g1",
    branch: "orch/g1",
    budget_tokens: 100,
  });
  await f.grp.create({ project_id: p.id, name: "g2", status: "DISSOLVED" });
  const first = await f.slice.create({ grp_id: g.id, seq: 1, title: "S1", status: "gate" });
  await f.task.create({ grp_id: g.id, slice_id: first.id, title: "t", status: "pending" });
  await f.agent.create({ project_id: p.id, grp_id: g.id, state: "idle" });
  await f.channel.create({ project_id: p.id, grp_id: g.id });
  await f.escalation.create({
    grp_id: g.id,
    severity: "blocker",
    brief: "b",
    kind: "spec",
    chain_state: "boss",
  });

  const s = await snapshot(ctx);
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

test("an answered question with no group and no answer text parses", async () => {
  // `Answered` declared `grp_id` and `answer` non-null, and the query promises
  // neither: a standing agent's question belongs to no group, and `answered` is
  // also reached by `revoked` and by the chain running out, neither of which
  // writes an answer. `db.query<Answered>` is a cast, so both NULLs crossed the
  // wire typed as values — the browser's `answeredFor` filters on `grp_id` and
  // simply never matched, which is a row the boss cannot take back.
  const ctx = await testContext();
  await seedAuth(ctx.db);
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  await f.escalation.create({
    grp_id: null,
    question: "a standing agent asked this",
    chain_state: "answered",
    answered_by: "cos",
  });

  const answered = (await snapshot(ctx)).answered;
  const row = z.array(S.Answered).safeParse(answered);
  expect(row.success ? [] : row.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  expect(answered).toHaveLength(1);
  expect(p.id).toBeGreaterThan(0);
});
