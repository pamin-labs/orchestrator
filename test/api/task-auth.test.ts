import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { postTaskClaim, postTaskDone } from "../../src/api/orch/tasks.ts";
import type { Caller } from "../../src/http/agent-auth.ts";
import { event, task } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

const request = new Request("http://x/orch/v1/task", { method: "POST" });

async function twoGroups() {
  const ctx = await testContext();
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  for (const name of ["caller", "other"]) await f.runningGrp.create({ project_id: p.id, name });
  await f.agent.create({ project_id: p.id, grp_id: 1, token: "caller-token" });
  await f.task.create({ grp_id: 2, title: "private work" });
  const caller: Caller = { id: 1, grp_id: 1, project_id: 1, role: "engineer" };
  return { ctx, caller };
}

test("a guessed task id cannot claim another group's task", async () => {
  const { ctx, caller } = await twoGroups();
  const response = await postTaskClaim(ctx, request, caller, {}, { task_id: 1 });

  expect(response.status).toBe(422);
  const rows = await ctx.db
    .select({ status: task.status, owner: task.owner_agent_id })
    .from(task)
    .where(eq(task.id, 1));
  expect(rows[0]).toEqual({ status: "pending", owner: null });
});

test("a guessed task id cannot finish another group's task", async () => {
  const { ctx, caller } = await twoGroups();
  const response = await postTaskDone(
    ctx,
    request,
    caller,
    {},
    {
      task_id: 1,
      already_done: "the work already exists on the branch",
    },
  );

  expect(response.status).toBe(422);
  const rows = await ctx.db
    .select({ status: task.status, owner: task.owner_agent_id, claim: task.claim_json })
    .from(task)
    .where(eq(task.id, 1));
  expect(rows[0]).toEqual({ status: "pending", owner: null, claim: null });
  expect(await ctx.db.select().from(event)).toHaveLength(0);
});
