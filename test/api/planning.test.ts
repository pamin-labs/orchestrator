import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { makeApp } from "../../src/composition/api.ts";
import type { Json } from "../../src/contracts/json.ts";
import { grp } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { fakeSandbox } from "../support/fake-sandbox.ts";
import { seedAuth } from "../support/seed-auth.ts";
import { testContext } from "../support/test-context.ts";

/**
 * The planning verbs' refusals.
 *
 * `api.test.ts` covers what each verb does when it is allowed to. What is here
 * is the other half — the conditions that stop it — because every one of them
 * guards the invariant this module's own doc comment names: a group has exactly
 * one owner of any path, and a split happens before work exists or not at all.
 */
async function harness() {
  const ctx = await testContext({ sandbox: fakeSandbox() });
  const db = ctx.db;
  await seedAuth(db);
  const app = makeApp(ctx);

  const f = fx.on(db);
  const p = await f.project.create({ name: "p", remote: "https://github.com/o/p.git" });
  const mine = await f.runningGrp.create({ project_id: p.id, name: "g1", owns_json: ["src/a/**"] });
  const other = await f.grp.create({ project_id: p.id, name: "g2", status: "PLANNING" });
  await f.agent.create({ project_id: p.id, role: "architect", token: "tok-arch" });
  await f.agent.create({ project_id: p.id, grp_id: other.id, role: "dispatcher", token: "tok-disp" });
  await f.agent.create({ project_id: p.id, grp_id: other.id, token: "tok-eng" });

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
  const h = await harness();
  const r = await h.post("/orch/v1/owns", { group_id: h.other, paths: ["src/a/**"] }, "tok-arch");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("g1");
});

test("only the boundary role cuts boundaries", async () => {
  // `owns_json` is what dispatch is gated on, so any role able to write it can
  // stall or unstall the whole fleet.
  const h = await harness();
  const r = await h.post("/orch/v1/owns", { group_id: h.other, paths: ["src/b/**"] }, "tok-eng");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("does not cut boundaries");
});

test("a split has a ceiling, because seven requirements is a decomposition nobody read", async () => {
  const h = await harness();
  const ok = await h.post("/orch/v1/split", { group_id: h.other, requirements: requirements(6) }, "tok-disp");
  expect(ok.status).toBe(200);

  const fresh = await harness();
  const tooMany = await fresh.post(
    "/orch/v1/split",
    { group_id: fresh.other, requirements: requirements(7) },
    "tok-disp",
  );
  expect(tooMany.status).toBe(422);
  expect(await tooMany.text()).toContain("too many");
  // Refused whole: seven groups must not be six groups and an error.
  expect(await fresh.db.select({ id: grp.id }).from(grp)).toHaveLength(2);
});

test("a split once the work has a branch is a respec, and says so", async () => {
  // Splitting after approval leaves a branch and a checkout belonging to a group
  // that is about to be DISSOLVED, and the slices under it pointing at nothing.
  const h = await harness();
  await h.db.update(grp).set({ branch: "orch/g2" }).where(eq(grp.id, h.other));
  const r = await h.post("/orch/v1/split", { group_id: h.other, requirements: requirements(2) }, "tok-disp");
  expect(r.status).toBe(422);
  expect(await r.text()).toContain("already has slices or a branch");
  const [row] = await h.db.select({ status: grp.status }).from(grp).where(eq(grp.id, h.other));
  expect(row?.status).toBe("PLANNING");
});
