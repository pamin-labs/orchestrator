import { expect, test } from "bun:test";
import { postTaskClaim, postTaskDone } from "../../src/api/orch/tasks.ts";
import type { Caller } from "../../src/http/agent-auth.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

const request = new Request("http://x/orch/v1/task", { method: "POST" });

function twoGroups() {
  const ctx = testContext();
  const p = fx.project.insert(ctx.db, { name: "p" });
  for (const name of ["caller", "other"]) fx.runningGrp.insert(ctx.db, { project_id: p.id, name });
  fx.agent.insert(ctx.db, { project_id: p.id, grp_id: 1, token: "caller-token" });
  fx.task.insert(ctx.db, { grp_id: 2, title: "private work" });
  const caller: Caller = { id: 1, grp_id: 1, project_id: 1, role: "engineer" };
  return { ctx, caller };
}

test("a guessed task id cannot claim another group's task", async () => {
  const { ctx, caller } = twoGroups();
  try {
    const response = await postTaskClaim(ctx, request, caller, {}, { task_id: 1 });

    expect(response.status).toBe(422);
    expect(
      ctx.db
        .query<{ status: string; owner: number | null }, []>(
          "SELECT status, owner_agent_id AS owner FROM task WHERE id = 1",
        )
        .get(),
    ).toEqual({ status: "pending", owner: null });
  } finally {
    ctx.db.close();
  }
});

test("a guessed task id cannot finish another group's task", async () => {
  const { ctx, caller } = twoGroups();
  try {
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
    expect(
      ctx.db
        .query<{ status: string; owner: number | null; claim: string | null }, []>(
          "SELECT status, owner_agent_id AS owner, claim_json AS claim FROM task WHERE id = 1",
        )
        .get(),
    ).toEqual({ status: "pending", owner: null, claim: null });
    expect(ctx.db.query<{ count: number }, []>("SELECT count(*) AS count FROM event").get()!.count).toBe(0);
  } finally {
    ctx.db.close();
  }
});
