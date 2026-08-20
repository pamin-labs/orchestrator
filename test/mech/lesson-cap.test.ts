import { expect, test } from "bun:test";
import { and, asc, count as countRows, eq } from "drizzle-orm";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { note } from "../../src/platform/persistence/schema.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { evictOldestLessons, LESSON_CAP, lessonsFor } from "../../src/mech/knowledge/lessons.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import * as fx from "../support/factories.ts";

/**
 * docs/project/plan.md §7: the lesson list is injected into every later group's prompt, so an
 * unbounded one is "the cure becoming the disease" — a fixed tax on every turn that
 * grows forever. The cap was implemented and never checked.
 */
async function harness() {
  const db = await openMemory();
  const f = fx.on(db);
  await seedAuth(db);
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox: fakeSandbox(),
    waiters: new Map(),
    config: loadConfig(),
  };
  const p = await f.project.create({ name: "p" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  await f.agent.create({ project_id: p.id, grp_id: g.id, role: "librarian", model: "haiku", token: "tok-lib" });
  return { db, ctx, f, app: makeApp(ctx) };
}

const lesson = (app: (r: Request) => Promise<Response>, body: string) =>
  app(
    new Request("http://x/orch/v1/journal", {
      method: "POST",
      body: JSON.stringify({ kind: "lesson", body }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-orch-token": "tok-lib",
      },
    }),
  );

test("the 21st lesson evicts the oldest, and only within its own project", async () => {
  const { db, ctx, f, app } = await harness();
  for (let i = 1; i <= LESSON_CAP; i++) {
    const r = await lesson(app, `lesson ${i}`);
    expect(r.status).toBe(200);
  }
  const lessons = async () => (await db.select({ c: countRows() }).from(note).where(eq(note.kind, "lesson")))[0]!.c;
  expect(await lessons()).toBe(LESSON_CAP);

  expect((await lesson(app, "lesson 21")).status).toBe(200);
  expect(await lessons()).toBe(LESSON_CAP);
  // The oldest went, the newest stayed: eviction has to be by age or the list stops
  // reflecting what the project last learned.
  const bodies = (
    await db.select({ body: note.body }).from(note).where(eq(note.kind, "lesson")).orderBy(asc(note.at), asc(note.id))
  ).map((r) => r.body);
  expect(bodies).not.toContain("lesson 1");
  expect(bodies.at(-1)).toContain("lesson 21");

  // A second project's lessons are its own. The prompt injection is per project, so
  // sharing the cap across projects would let a busy one silently empty a quiet one.
  const other = await f.project.create({ name: "other", repo_path: "/tmp/o" });
  await f.note.create({ project_id: other.id, kind: "lesson", lang: "中文", body: "other project" });
  await evictOldestLessons(ctx.db, 1);
  const [kept] = await db
    .select({ c: countRows() })
    .from(note)
    .where(and(eq(note.kind, "lesson"), eq(note.project_id, other.id)));
  expect(kept!.c).toBe(1);
});

test("the reader and the evictor agree on the set and the cap", async () => {
  // They had two definitions of both. The reader was inline in executor.ts with
  // `(project_id IS ? OR project_id IS NULL)` and a literal 20; the evictor used
  // `(project_id IS ? OR (? IS NULL AND project_id IS NULL))` — whose second
  // clause is false for any real project — and LESSON_CAP, which three other
  // files import and the reader did not. Change the cap and the prompt kept 20.
  const db = await openMemory();
  const f = fx.on(db);
  await f.project.create({ name: "p" });
  const add = (project: number | null, body: string, at: number) =>
    f.note.create({ project_id: project, kind: "lesson", body, at });

  await add(null, "global-old", 1);
  await add(1, "mine", 2);
  await add(null, "global-new", 3);

  // Newest first, and a project sees its own plus every global.
  expect(await lessonsFor(db, 1)).toEqual(["global-new", "mine", "global-old"]);
  // A different project sees the globals and none of project 1's.
  expect(await lessonsFor(db, 2)).toEqual(["global-new", "global-old"]);

  // The cap is one number. Fill past it and the reader stops at exactly what
  // survives eviction rather than at a literal of its own.
  for (let i = 0; i < LESSON_CAP + 5; i++) await add(1, `l${i}`, 100 + i);
  expect((await lessonsFor(db, 1)).length).toBe(LESSON_CAP);
});
