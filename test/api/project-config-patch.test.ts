import { expect, test } from "bun:test";
import { patchProjectConfig } from "../../src/api/panel/project.ts";
import { testContext } from "../support/test-context.ts";

test("an unrelated patch cannot bless a malformed known project setting", async () => {
  const ctx = testContext();
  const stored = JSON.stringify({ gates: "build", migration_note: "keep" });
  ctx.db.run("INSERT INTO project (id, name, repo_path, config_json, created_at) VALUES (1,'p','/p',?,0)", [stored]);

  const response = await patchProjectConfig(ctx, new Request("http://x"), { id: 1 }, { install: "bun install" });

  expect(response.status).toBe(422);
  expect(ctx.db.query<{ config_json: string }, []>("SELECT config_json FROM project").get()!.config_json).toBe(stored);
});
