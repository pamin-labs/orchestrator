import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { openMemory } from "../src/db.ts";
import { evictOldestLessons, LESSON_CAP, makeApp, type Ctx } from "../src/api.ts";
import { lessonsFor } from "../src/mech/knowledge/lessons.ts";
import { Scheduler } from "../src/scheduler.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";

/**
 * PLAN.md §7: the lesson list is injected into every later group's prompt, so an
 * unbounded one is "the cure becoming the disease" — a fixed tax on every turn that
 * grows forever. The cap was implemented and never checked.
 */
function harness() {
  const db = openMemory();
  seedAuth(db);
  const ctx: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox: fakeSandbox(),
    waiters: new Map(),
    config: { language: "中文" },
  };
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    "INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES (1, 1, 'librarian', 'haiku', 'tok-lib', 0)",
  );
  return { db, ctx, app: makeApp(ctx) };
}

const lesson = (app: (r: Request) => Promise<Response>, body: string) =>
  app(
    new Request("http://x/orch/journal", {
      method: "POST",
      body: JSON.stringify({ kind: "lesson", body }),
      headers: { "content-type": "application/json", "x-orch-token": "tok-lib" },
    }),
  );

test("the 21st lesson evicts the oldest, and only within its own project", async () => {
  const { db, app } = harness();
  for (let i = 1; i <= LESSON_CAP; i++) {
    const r = await lesson(app, `lesson ${i}`);
    expect(r.status).toBe(200);
  }
  const count = () => db.query<{ c: number }, []>("SELECT count(*) AS c FROM note WHERE kind = 'lesson'").get()!.c;
  expect(count()).toBe(LESSON_CAP);

  expect((await lesson(app, "lesson 21")).status).toBe(200);
  expect(count()).toBe(LESSON_CAP);
  // The oldest went, the newest stayed: eviction has to be by age or the list stops
  // reflecting what the project last learned.
  const bodies = db
    .query<{ body: string }, []>("SELECT body FROM note WHERE kind = 'lesson' ORDER BY at, id")
    .all()
    .map((r) => r.body);
  expect(bodies).not.toContain("lesson 1");
  expect(bodies.at(-1)).toContain("lesson 21");

  // A second project's lessons are its own. The prompt injection is per project, so
  // sharing the cap across projects would let a busy one silently empty a quiet one.
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('other', '/tmp/o', 0)");
  db.run("INSERT INTO note (project_id, kind, lang, body, at) VALUES (2, 'lesson', '中文', 'other project', 0)");
  evictOldestLessons({ ...harness().ctx, db } as any, 1);
  expect(
    db.query<{ c: number }, []>("SELECT count(*) AS c FROM note WHERE kind = 'lesson' AND project_id = 2").get()!.c,
  ).toBe(1);
});

test("the reader and the evictor agree on the set and the cap", () => {
  // They had two definitions of both. The reader was inline in executor.ts with
  // `(project_id IS ? OR project_id IS NULL)` and a literal 20; the evictor used
  // `(project_id IS ? OR (? IS NULL AND project_id IS NULL))` — whose second
  // clause is false for any real project — and LESSON_CAP, which three other
  // files import and the reader did not. Change the cap and the prompt kept 20.
  const db = openMemory();
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p','/tmp/p',0)");
  const add = (project: number | null, body: string, at: number) =>
    db.run("INSERT INTO note (project_id, kind, lang, body, at) VALUES (?, 'lesson', 'zh', ?, ?)", [project, body, at]);

  add(null, "global-old", 1);
  add(1, "mine", 2);
  add(null, "global-new", 3);

  // Newest first, and a project sees its own plus every global.
  expect(lessonsFor(db, 1)).toEqual(["global-new", "mine", "global-old"]);
  // A different project sees the globals and none of project 1's.
  expect(lessonsFor(db, 2)).toEqual(["global-new", "global-old"]);

  // The cap is one number. Fill past it and the reader stops at exactly what
  // survives eviction rather than at a literal of its own.
  for (let i = 0; i < LESSON_CAP + 5; i++) add(1, `l${i}`, 100 + i);
  expect(lessonsFor(db, 1).length).toBe(LESSON_CAP);
});
