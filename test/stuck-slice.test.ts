import { expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { openMemory, type DB } from "../src/db.ts";
import { runInvariants } from "../src/mech/ops/invariants.ts";
import { sendBack } from "../src/mech/flow/review.ts";
import { makeApp, type Ctx } from "../src/api.ts";
import { Scheduler, type Job } from "../src/scheduler.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { seedAuth } from "./seed-auth.ts";
import type { Json } from "../src/http/respond.ts";

/**
 * The deadlock that stopped eight groups at once, from both ends.
 *
 * A slice sent back for a retry kept its tasks `done`, and `done` is the one state
 * the writer cannot act on — `task list` showed a finished card, `task claim` said
 * the slice was not being worked, `task done` said the task was not its. No legal
 * move, so every turn ended the only way it could: a question to the boss. Four
 * groups stopped outright, and each read as RUNNING with an engineer on it.
 *
 * The other end is the same card claimed by an agent that no longer exists.
 * Ownership was a row id, so rehiring a group's writer locked its own work away
 * from it permanently.
 */

function harness() {
  const db: DB = openMemory();
  seedAuth(db);
  const bus = new Bus(db);
  const ran: Job[] = [];
  const sched = new Scheduler(db, async (j) => void ran.push(j));
  const cfg = { ...loadConfig(), gateRetries: 5 };
  const ctx: Ctx = {
    db,
    bus,
    sched,
    sandbox: fakeSandbox(),
    waiters: new Map(),
    config: cfg,
  };
  db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  db.run("INSERT INTO grp (project_id, name, status, created_at) VALUES (1, 'g1', 'RUNNING', 0)");
  db.run(
    `INSERT INTO slice (grp_id, seq, title, accept_spec, status, created_at)
     VALUES (1, 1, 's1', 'it works', 'running', 0)`,
  );
  return { db, ctx, cfg, sched, app: makeApp(ctx), deps: { ctx, cfg, git: async () => ({ code: 0, out: "" }) } };
}

/** A writer that has already delivered this card once. */
function delivered(db: DB, opts: { owner: "live" | "retired" } = { owner: "live" }) {
  db.run(
    `INSERT INTO agent (project_id, grp_id, role, model, token, state, created_at)
     VALUES (1, 1, 'engineer', 'm', 'tok-old', ?, 0)`,
    [opts.owner === "retired" ? "retired" : "idle"],
  );
  const agentId = db.query<{ id: number }, []>("SELECT max(id) AS id FROM agent").get()!.id;
  db.run(
    `INSERT INTO task (grp_id, slice_id, title, status, owner_agent_id, claim_json, created_at)
     VALUES (1, 1, 't1', 'done', ?, '{"files":["src/one.ts"],"summary":"did it"}', 0)`,
    [agentId],
  );
  return agentId;
}

const post = (app: (r: Request) => Promise<Response>, path: string, body: Json, token: string) =>
  app(
    new Request(`http://x${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-orch-token": token },
    }),
  );

test("a slice sent back gets its card back", async () => {
  const h = harness();
  delivered(h.db);

  sendBack(h.deps, 1, "gate said no", "gate");

  const t = h.db
    .query<{ status: string; owner: number | null; claim_json: string | null }, []>(
      "SELECT status, owner_agent_id AS owner, claim_json FROM task WHERE id = 1",
    )
    .get()!;
  expect(t.status).toBe("pending");
  expect(t.owner).toBeNull();
  // claim_json survives on purpose: reconcile only reads it off `done` rows, so it
  // is inert here, and it is the record of what the last attempt already put on the
  // branch. getTasks shows it back so the retry checks before rewriting.
  expect(t.claim_json).toContain("src/one.ts");
});

test("the writer can claim and close the card it was handed back", async () => {
  const h = harness();
  delivered(h.db);
  sendBack(h.deps, 1, "gate said no", "gate");

  // The retry is a fresh session, so it is a fresh agent row. Ownership used to be
  // the old row's id, which nothing could ever release.
  h.db.run(
    `INSERT INTO agent (project_id, grp_id, role, model, token, created_at)
     VALUES (1, 1, 'engineer', 'm', 'tok-new', 0)`,
  );

  expect(await (await post(h.app, "/orch/task/claim", { task_id: 1 }, "tok-new")).json()).toEqual({ message: "ok" });
  const done = await post(
    h.app,
    "/orch/task/done",
    {
      task_id: 1,
      claim: { files: ["src/one.ts"], summary: "src/one.ts returns the fixed value" },
      review: "pass: it works — src/one.ts:1 returns the fixed value",
    },
    "tok-new",
  );
  expect(await done.json()).toEqual({ message: "ok" });
  expect(h.db.query<{ status: string }, []>("SELECT status FROM slice WHERE id = 1").get()!.status).toBe("gate");
});

test("a card whose owner retired is not locked away from the group", async () => {
  const h = harness();
  // Mid-flight, not done: exactly grp18's slice 36. The repair below cannot see it
  // (its slice still has an open task), so the endpoints have to answer for it.
  delivered(h.db, { owner: "retired" });
  h.db.run("UPDATE task SET status = 'in_progress' WHERE id = 1");
  h.db.run(
    `INSERT INTO agent (project_id, grp_id, role, model, token, created_at)
     VALUES (1, 1, 'engineer', 'm', 'tok-new', 0)`,
  );

  const done = await post(
    h.app,
    "/orch/task/done",
    {
      task_id: 1,
      already_done: "already on the branch from the previous session",
      review: "pass: it works — already on origin/main",
    },
    "tok-new",
  );
  expect(await done.json()).toEqual({ message: "ok" });
});

test("the invariant repair reopens a running slice nobody can work on", () => {
  const h = harness();
  delivered(h.db, { owner: "retired" });

  // No sendBack here: this is the row that was already stranded before the fix, or
  // by any other path that flips a slice back without looking at its cards.
  runInvariants(h.ctx);

  const t = h.db
    .query<{ status: string; owner: number | null }, []>(
      "SELECT status, owner_agent_id AS owner FROM task WHERE id = 1",
    )
    .get()!;
  expect(t.status).toBe("pending");
  expect(t.owner).toBeNull();

  // Idempotent: a second tick must not disturb a slice that is being worked now.
  h.db.run("UPDATE task SET status = 'in_progress' WHERE id = 1");
  runInvariants(h.ctx);
  expect(h.db.query<{ status: string }, []>("SELECT status FROM task WHERE id = 1").get()!.status).toBe("in_progress");
});

test("a reopened card says what it already delivered, and how to close it", async () => {
  const h = harness();
  delivered(h.db);
  sendBack(h.deps, 1, "gate said no", "gate");

  const list = await (
    await h.app(new Request("http://x/orch/task", { headers: { "x-orch-token": "tok-old" } }))
  ).text();
  expect(list).toContain("src/one.ts");
  expect(list).toContain("--already-done");
  // The old owner is retired-or-gone either way; showing `engineer` there reads as
  // "someone else has this" to the one agent that calls itself engineer.
  expect(list).toContain("pending");
});
