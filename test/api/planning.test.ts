import { expect, test } from "bun:test";
import { Bus } from "../../src/platform/persistence/event-bus.ts";
import { loadConfig } from "../../src/platform/config/load.ts";
import { openMemory, type DB } from "../../src/platform/persistence/database.ts";
import { Scheduler } from "../../src/platform/scheduling/scheduler.ts";
import { makeApp } from "../../src/composition/api.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import type { Json } from "../../src/contracts/json.ts";
import * as fx from "../support/factories.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";

/**
 * The planning verbs' refusals.
 *
 * `api.test.ts` covers what each verb does when it is allowed to. What is here
 * is the other half — the conditions that stop it — because every one of them
 * guards the invariant this module's own doc comment names: a group has exactly
 * one owner of any path, and a split happens before work exists or not at all.
 */
function harness() {
  const db: DB = openMemory();
  seedAuth(db);
  const bus = new Bus(db);
  const sched = new Scheduler(db, async () => {});
  const ctx: Ctx = { db, bus, sched, sandbox: fakeSandbox(), waiters: new Map(), config: loadConfig() };
  const app = makeApp(ctx);

  const p = fx.project.insert(db, { name: "p", remote: "https://github.com/o/p.git" });
  const mine = fx.runningGrp.insert(db, { project_id: p.id, name: "g1" });
  db.run("UPDATE grp SET owns_json = ? WHERE id = ?", [JSON.stringify(["src/a/**"]), mine.id]);
  const other = fx.runningGrp.insert(db, { project_id: p.id, name: "g2" });
  db.run("UPDATE grp SET status = 'PLANNING' WHERE id = ?", [other.id]);
  fx.agent.insert(db, { project_id: p.id, role: "architect", token: "tok-arch" });
  fx.agent.insert(db, { project_id: p.id, grp_id: other.id, role: "dispatcher", token: "tok-disp" });
  fx.agent.insert(db, { project_id: p.id, grp_id: other.id, token: "tok-eng" });

  const post = (path: string, body?: Json, token?: string) =>
    app(
      new Request(`http://x${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...(token ? { "x-orch-token": token } : {}),
        },
      }),
    );
  return { db, ctx, post, mine: mine.id, other: other.id };
}

const requirements = (n: number) => Array.from({ length: n }, (_, i) => ({ idea: `第 ${i + 1} 件事` }));

test("a boundary that overlaps a live group is refused, not answered ok", async () => {
  // The refusal is the whole point of the verb. `canStart`'s verdict was computed,
  // written into the event, and then discarded — so the Architect drew a boundary
  // over a running group's paths, was told "ok", and the collision surfaced later as
  // two groups editing the same file.
  const h = harness();
  const r = await h.post("/orch/v1/owns", { group_id: h.other, paths: ["src/a/**"] }, "tok-arch");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("g1");
});

test("only the boundary role cuts boundaries", async () => {
  // `owns_json` is what dispatch is gated on, so any role able to write it can
  // stall or unstall the whole fleet.
  const h = harness();
  const r = await h.post("/orch/v1/owns", { group_id: h.other, paths: ["src/b/**"] }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("does not cut boundaries");
});

test("a split has a ceiling, because seven requirements is a decomposition nobody read", async () => {
  const h = harness();
  const ok = await h.post("/orch/v1/split", { group_id: h.other, requirements: requirements(6) }, "tok-disp");
  expect(ok.status).toBe(200);

  const fresh = harness();
  const tooMany = await fresh.post(
    "/orch/v1/split",
    { group_id: fresh.other, requirements: requirements(7) },
    "tok-disp",
  );
  expect(tooMany.status).toBe(422);
  expect(await tooMany.text()).toContain("too many");
  // Refused whole: seven groups must not be six groups and an error.
  expect(fresh.db.query<{ c: number }, []>("SELECT count(*) AS c FROM grp").get()!.c).toBe(2);
});

test("a split once the work has a branch is a respec, and says so", async () => {
  // Splitting after approval leaves a branch and a checkout belonging to a group
  // that is about to be DISSOLVED, and the slices under it pointing at nothing.
  const h = harness();
  h.db.run("UPDATE grp SET branch = 'orch/g2' WHERE id = ?", [h.other]);
  const r = await h.post("/orch/v1/split", { group_id: h.other, requirements: requirements(2) }, "tok-disp");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("already has slices or a branch");
  expect(h.db.query<{ status: string }, [number]>("SELECT status FROM grp WHERE id = ?").get(h.other)!.status).toBe(
    "PLANNING",
  );
});
