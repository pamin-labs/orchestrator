import { expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { openMemory, resetIdentities } from "../../src/platform/persistence/database.ts";
import { agent } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";

/**
 * The nightly's `agent_pkey` duplicate, from its mechanism.
 *
 * A test that leaves work in flight commits after the reset's delete has taken
 * its snapshot. The row stays; a blind `setval(seq, 1, false)` winds the sequence
 * back behind it; the next ordinary insert asks for an id that is already there.
 * Two of 16490 on the 2026-08-31 nightly, one on 2026-08-26.
 */
test("the identity reset does not wind a sequence back behind a row that survived", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  const project = await f.project.create({ name: "p", remote: "https://github.com/o/p.git" });

  await f.agent.create({ project_id: project.id, token: "a" });
  await f.agent.create({ project_id: project.id, token: "b" });
  const survivor = await f.agent.create({ project_id: project.id, token: "c" });
  expect(survivor.id).toBe(3);

  // The reset, with the rows still there — which is what a raced delete leaves.
  await resetIdentities(db);

  const next = await f.agent.create({ project_id: project.id, token: "d" });
  expect(next.id).toBeGreaterThan(survivor.id);
  const ids = (await db.select({ id: agent.id }).from(agent).orderBy(asc(agent.id))).map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
});

/**
 * The other half, and the reason the reset exists: hundreds of assertions name
 * row 1, so an emptied namespace still has to start there.
 */
test("an emptied namespace still hands out id 1", async () => {
  const db = await openMemory();
  const f = fx.on(db);
  await f.project.create({ name: "p", remote: "https://github.com/o/p.git" });
  const again = await openMemory();
  const project = await fx.on(again).project.create({ name: "q", remote: "https://github.com/o/q.git" });
  expect(project.id).toBe(1);
  expect((await fx.on(again).agent.create({ project_id: project.id, token: "a" })).id).toBe(1);
});
