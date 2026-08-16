import { expect, test } from "bun:test";
import { postTaskClaim, postTaskDone } from "../src/api/orch/tasks.ts";
import type { Caller } from "../src/ctx.ts";
import { testContext } from "./test-context.ts";

const request = new Request("http://x/orch/v1/task", { method: "POST" });

function twoGroups() {
  const ctx = testContext();
  ctx.db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  ctx.db.run(
    `INSERT INTO grp (project_id, name, status, created_at) VALUES
       (1, 'caller', 'RUNNING', 0),
       (1, 'other', 'RUNNING', 0)`,
  );
  ctx.db.run(
    `INSERT INTO agent (project_id, grp_id, role, model, token, created_at) VALUES
       (1, 1, 'engineer', 'm', 'caller-token', 0)`,
  );
  ctx.db.run("INSERT INTO task (grp_id, title, created_at) VALUES (2, 'private work', 0)");
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
