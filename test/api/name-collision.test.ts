import { expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { makeApp } from "../../src/composition/api.ts";
import { newGroup } from "../../src/mech/flow/newgroup.ts";
import { openMemory } from "../../src/platform/persistence/database.ts";
import { grp } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

const GroupIdResponse = z.object({ grp_id: z.number() });

const file = (app: (r: Request) => Promise<Response>, projectId: number, text: string) =>
  app(
    new Request("http://x/api/v1/ideas", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, text }),
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    }),
  );

test("two ideas that slug the same are both filed, under names that differ", async () => {
  const db = await openMemory();
  const ctx = await testContext({ db });
  const app = makeApp(ctx);
  const project = await fx.on(db).project.create({ name: "p", remote: "https://github.com/o/p.git" });

  // The same three non-stopword ascii words, which is all `slug` reads. Two
  // requirements about the same area is the ordinary case, not a rare one.
  const first = await file(app, project.id, "add rate limiting to the api, per token");
  const second = await file(app, project.id, "add rate limiting to the api, per address");
  const third = await file(app, project.id, "add rate limiting to the api, on the panel too");

  expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
  const ids = await Promise.all([first, second, third].map(async (r) => GroupIdResponse.parse(await r.json()).grp_id));
  const names = await db.select({ name: grp.name }).from(grp).orderBy(asc(grp.id));
  expect(new Set(names.map((r) => r.name)).size).toBe(3);
  expect(names.map((r) => r.name)).toEqual(["rate-limiting-api", "rate-limiting-api-2", "rate-limiting-api-3"]);
  expect(new Set(ids).size).toBe(3);
});

test("a name a caller chose is kept, and only the collision gets a suffix", async () => {
  const db = await openMemory();
  const ctx = await testContext({ db });
  const project = await fx.on(db).project.create({ name: "p", remote: "https://github.com/o/p.git" });

  const a = await newGroup(ctx, { projectId: project.id, name: "ship-it", idea: "one" });
  const b = await newGroup(ctx, { projectId: project.id, name: "ship-it", idea: "two" });

  const rows = await db.select({ id: grp.id, name: grp.name }).from(grp).orderBy(asc(grp.id));
  expect(rows.map((r) => r.name)).toEqual(["ship-it", "ship-it-2"]);
  expect([a.id, b.id]).toEqual(rows.map((r) => r.id));

  // A different project is a different namespace: the constraint is on the pair.
  const other = await fx.on(db).project.create({ name: "q", remote: "https://github.com/o/q.git" });
  const c = await newGroup(ctx, { projectId: other.id, name: "ship-it", idea: "three" });
  expect((await db.select({ name: grp.name }).from(grp).where(eq(grp.id, c.id)))[0]?.name).toBe("ship-it");
});
