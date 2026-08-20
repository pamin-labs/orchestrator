import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { Ctx } from "../../src/mech/ctx.ts";
import { job, slice } from "../../src/platform/persistence/schema.ts";
import { handToQa } from "../../src/mech/flow/review.ts";
import { checkCapabilities, loadConfig, loadRoles, roleWith } from "../../src/platform/config/load.ts";
import { AgentTurnPayloadSchema } from "../../src/platform/scheduling/scheduler.ts";
import * as fx from "../support/factories.ts";
import { testContext } from "../support/test-context.ts";
import { tempDir } from "../support/temp.ts";

/**
 * A roles directory built out of nothing but the argument.
 *
 * The whole claim is that a role is a file, so the fixture has to be a file and
 * not a hand-built `Map` — a Map would skip the schema, which is the half that
 * decides whether `capabilities:` is a legal thing for a yaml to say.
 */
function rolesDir(...defs: { name: string; capabilities: string[] }[]): string {
  const dir = tempDir("orch-roles-");
  for (const d of defs) {
    const yaml = `name: ${d.name}\nprompt: |\n  You are the ${d.name}.\ncapabilities: [${d.capabilities.join(", ")}]\n`;
    writeFileSync(join(dir, `${d.name}.yaml`), yaml);
  }
  return dir;
}

/** The role the newest `agent_turn` job was enqueued for. */
async function enqueuedRole(ctx: Ctx): Promise<string | undefined> {
  // `payload_json` is jsonb, so it arrives parsed; the schema is still what
  // decides whether what arrived is a turn payload.
  const [row] = await ctx.db
    .select({ payload: job.payload_json })
    .from(job)
    .where(eq(job.kind, "agent_turn"))
    .orderBy(desc(job.id));
  return row ? AgentTurnPayloadSchema.parse(row.payload).role : undefined;
}

/**
 * The claim in `load.ts`, as a test: a new role is a yaml file and nothing else.
 *
 * No role here is called `qa`, and nothing in this file edits the pipeline. If
 * `handToQa` still reaches the Composer, the flow is asking for a capability. If
 * this ever needs a code change to pass, the comment above `RoleDefSchema` is a
 * lie again.
 */
test("a role that declares review_slice is dispatched without touching the flow", async () => {
  const ctx = await testContext({ roles: loadRoles(rolesDir({ name: "composer", capabilities: ["review_slice"] })) });
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  const g = await f.runningGrp.create({ project_id: p.id });
  const s = await f.slice.create({ grp_id: g.id, status: "gate" });

  await handToQa({ ctx, cfg: loadConfig() }, s.id);

  expect(await enqueuedRole(ctx)).toBe("composer");
  expect((await ctx.db.select({ status: slice.status }).from(slice))[0]?.status).toBe("qa");
});

test("a capability no role declares is a named error, not an undefined role", () => {
  const roles = loadRoles(rolesDir({ name: "composer", capabilities: ["write_code"] }));
  expect(() => roleWith(roles, "review_slice")).toThrow(/no role in roles\/ declares the capability "review_slice"/);
});

test("two roles claiming one capability is refused rather than resolved by readdir order", () => {
  const roles = loadRoles(
    rolesDir({ name: "composer", capabilities: ["review_slice"] }, { name: "critic", capabilities: ["review_slice"] }),
  );
  expect(() => roleWith(roles, "review_slice")).toThrow(/declared by composer, critic; exactly one role may/);
});

test("an unknown capability is refused when the yaml is read, naming the file", () => {
  const dir = tempDir("orch-roles-");
  writeFileSync(join(dir, "composer.yaml"), "name: composer\nprompt: x\ncapabilities: [reviews_slices]\n");
  expect(() => loadRoles(dir)).toThrow(z.ZodError);
});

/** The boot check the server runs, against the roles this installation ships. */
test("every capability the flow dispatches on resolves against roles/", () => {
  expect(() => checkCapabilities(loadRoles("roles"))).not.toThrow();
});
