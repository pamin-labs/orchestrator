import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { patchProjectConfig } from "../../src/api/panel/project.ts";
import { project } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";

test("an unrelated patch cannot bless a malformed known project setting", async () => {
  const ctx = await testContext();
  const stored = { gates: "build", migration_note: "keep" };
  const f = fx.on(ctx.db);
  await f.project.create({ id: 1, name: "p", repo_path: "/p", config_json: stored });

  const response = await patchProjectConfig(ctx, new Request("http://x"), { id: 1 }, { install: "bun install" });

  expect(response.status).toBe(422);
  const [row] = await ctx.db.select({ config_json: project.config_json }).from(project).where(eq(project.id, 1));
  expect(row?.config_json).toEqual(stored);
});
