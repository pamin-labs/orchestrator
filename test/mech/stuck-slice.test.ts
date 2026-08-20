import { expect, test } from "bun:test";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { runInvariants } from "../../src/mech/ops/invariants.ts";
import { sendBack } from "../../src/mech/flow/review.ts";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { Scheduler, type Job } from "../../src/platform/scheduling/scheduler.ts";
import { eq } from "drizzle-orm";
import { slice, task } from "../../src/platform/persistence/schema.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import type { Json } from "../../src/contracts/json.ts";
import * as fx from "../support/factories.ts";

/**
 * The deadlock that stopped eight groups at once, from both ends.
 *
 * A slice sent back for a retry kept its tasks `done`, and `done` is the one state
 * the writer cannot act on — `task list` showed a finished card, `task claim` said
 * the slice was not being worked, `task done` said the task was not its. No legal
 * move, so every turn ended by asking the boss. Four groups stopped outright, each
 * reading as RUNNING with an engineer on it.
 */
/**
 * The other end is the same card claimed by an agent that no longer exists. Ownership
 * was a row id, so rehiring a group's writer locked its own work away from it
 * permanently.
 */

async function harness() {
  const db: DB = await openMemory();
  await seedAuth(db);
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
  const f = fx.on(db);
  const p = await f.project.create({ name: "p" });
  const g = await f.runningGrp.create({ project_id: p.id, name: "g1" });
  await f.slice.create({ grp_id: g.id, seq: 1, title: "s1", accept_spec: "it works", status: "running" });
  return { db, ctx, cfg, sched, app: makeApp(ctx), deps: { ctx, cfg, git: async () => ({ code: 0, out: "" }) } };
}

/** A writer that has already delivered this card once. */
async function delivered(db: DB, opts: { owner: "live" | "retired" } = { owner: "live" }) {
  const f = fx.on(db);
  const agentId = (
    await f.agent.create({
      project_id: 1,
      grp_id: 1,
      token: "tok-old",
      state: opts.owner === "retired" ? "retired" : "idle",
    })
  ).id;
  await f.task.create({
    grp_id: 1,
    slice_id: 1,
    title: "t1",
    status: "done",
    owner_agent_id: agentId,
    claim_json: { files: ["src/one.ts"], summary: "did it" },
  });
  return agentId;
}

const post = (app: (r: Request) => Promise<Response>, path: string, body: Json, token: string) =>
  app(
    new Request(`http://x${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-orch-token": token,
      },
    }),
  );

test("a slice sent back gets its card back", async () => {
  const h = await harness();
  await delivered(h.db);

  await sendBack(h.deps, 1, "gate said no", "gate");

  const t = (await h.db.select().from(task).where(eq(task.id, 1)))[0]!;
  expect(t.status).toBe("pending");
  expect(t.owner_agent_id).toBeNull();
  // claim_json survives on purpose: reconcile only reads it off `done` rows, so it
  // is inert here, and it is the record of what the last attempt already put on the
  // branch. getTasks shows it back so the retry checks before rewriting.
  expect(t.claim_json).toEqual({ files: ["src/one.ts"], summary: "did it" });
});

test("the writer can claim and close the card it was handed back", async () => {
  const h = await harness();
  await delivered(h.db);
  await sendBack(h.deps, 1, "gate said no", "gate");

  // The retry is a fresh session, so it is a fresh agent row. Ownership used to be
  // the old row's id, which nothing could ever release.
  await fx.on(h.db).agent.create({ project_id: 1, grp_id: 1, token: "tok-new" });

  expect(await (await post(h.app, "/orch/v1/task/claim", { task_id: 1 }, "tok-new")).json()).toEqual({ message: "ok" });
  const done = await post(
    h.app,
    "/orch/v1/task/done",
    {
      task_id: 1,
      claim: { files: ["src/one.ts"], summary: "src/one.ts returns the fixed value" },
      review: "pass: it works — src/one.ts:1 returns the fixed value",
    },
    "tok-new",
  );
  expect(await done.json()).toEqual({ message: "ok" });
  expect((await h.db.select().from(slice).where(eq(slice.id, 1)))[0]!.status).toBe("gate");
});

test("a card whose owner retired is not locked away from the group", async () => {
  const h = await harness();
  // Mid-flight, not done: exactly grp18's slice 36. The repair below cannot see it
  // (its slice still has an open task), so the endpoints have to answer for it.
  await delivered(h.db, { owner: "retired" });
  await h.db.update(task).set({ status: "in_progress" }).where(eq(task.id, 1));
  await fx.on(h.db).agent.create({ project_id: 1, grp_id: 1, token: "tok-new" });

  const done = await post(
    h.app,
    "/orch/v1/task/done",
    {
      task_id: 1,
      already_done: "already on the branch from the previous session",
      review: "pass: it works — already on origin/main",
    },
    "tok-new",
  );
  expect(await done.json()).toEqual({ message: "ok" });
});

test("the invariant repair reopens a running slice nobody can work on", async () => {
  const h = await harness();
  await delivered(h.db, { owner: "retired" });

  // No sendBack here: this is the row that was already stranded before the fix, or
  // by any other path that flips a slice back without looking at its cards.
  await runInvariants(h.ctx);

  const t = (await h.db.select().from(task).where(eq(task.id, 1)))[0]!;
  expect(t.status).toBe("pending");
  expect(t.owner_agent_id).toBeNull();

  // Idempotent: a second tick must not disturb a slice that is being worked now.
  await h.db.update(task).set({ status: "in_progress" }).where(eq(task.id, 1));
  await runInvariants(h.ctx);
  expect((await h.db.select().from(task).where(eq(task.id, 1)))[0]!.status).toBe("in_progress");
});

test("a reopened card says what it already delivered, and how to close it", async () => {
  const h = await harness();
  await delivered(h.db);
  await sendBack(h.deps, 1, "gate said no", "gate");

  const list = await (
    await h.app(new Request("http://x/orch/v1/task", { headers: { "x-orch-token": "tok-old" } }))
  ).text();
  expect(list).toContain("src/one.ts");
  expect(list).toContain("--already-done");
  // The old owner is retired-or-gone either way; showing `engineer` there reads as
  // "someone else has this" to the one agent that calls itself engineer.
  expect(list).toContain("pending");
});
