import { expect, test } from "bun:test";
import { logLine } from "../../src/platform/observability/logging.ts";
import { maskValue } from "../../src/platform/observability/redaction.ts";
import { requestContext } from "../../src/platform/observability/request-context.ts";
import { publishStandupItem } from "../../src/application/executor.ts";
import type { StandupItem } from "../../src/mech/flow/standup.ts";

import { count, eq } from "drizzle-orm";
import { event } from "../../src/platform/persistence/schema.ts";
import * as fx from "../support/factories.ts";
import type { Ctx } from "../../src/mech/ctx.ts";
import { testContext } from "../support/test-context.ts";
import { loadConfig } from "../../src/platform/config/load.ts";

const at = new Date("2026-08-17T09:00:00.000Z");

const standupLines = async (db: Ctx["db"]) =>
  (await db.select({ c: count() }).from(event).where(eq(event.author, "standup")))[0]!.c;

/** A log line is JSON off a stream, so it is narrowed rather than trusted. */
function parsed(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`not a log object: ${line}`);
  }
  return { ...value };
}

test("a secret never reaches a log line, however it was logged", () => {
  maskValue("ghp_realtokenvalue");

  const asString = parsed(logLine({ date: at, type: "info", args: ["push failed: ghp_realtokenvalue"] }, undefined));
  expect(asString.message).not.toContain("ghp_realtokenvalue");

  // An Error is logged by its stack, which is the other way a token gets out.
  const asError = parsed(
    logLine({ date: at, type: "error", args: [new Error("auth: ghp_realtokenvalue rejected")] }, undefined),
  );
  expect(asError.message).not.toContain("ghp_realtokenvalue");
  // Still the stack, not just the message — the message alone names the failure
  // without saying where it happened.
  expect(asError.message).toContain("observe-standup.test");
});

test("a line about a request carries what correlates it, and claims nothing it lacks", () => {
  const store = {
    requestId: "req-1",
    traceId: "trace-1",
    spanId: "span-1",
    traceFlags: 1,
    method: "POST",
    path: "/api/v1/groups",
  };
  const line = parsed(
    requestContext.run(store, () => logLine({ date: at, type: "info", args: ["ok"] }, requestContext.getStore())),
  );

  expect(line).toMatchObject({ request_id: "req-1", trace_id: "trace-1", method: "POST", path: "/api/v1/groups" });
  // No job, group or agent here: the keys are absent rather than present and
  // null, so a log query for `job_id` does not match a line that has none.
  expect(line).not.toHaveProperty("job_id");
  expect(line).not.toHaveProperty("group_id");
  expect(line).not.toHaveProperty("agent_id");
});

test("a line outside any request is still valid JSON with a level and a timestamp", () => {
  const line = parsed(logLine({ date: at, type: "warn", args: ["starting"] }, undefined));
  expect(line).toEqual({ timestamp: at.toISOString(), level: "warn", message: "starting" });
});

/**
 * One item, named the way `runStandup` names them.
 *
 * These fixtures used to be `{ kind: "budget", body: "预算快用完了" }` — a kind
 * that is not in `StandupItem` and a sentence in a language the panel stopped
 * using. They compiled because `publishStandupItem` declared its parameter as a
 * structural copy with `kind: string`; taking the real type is what surfaced
 * them.
 */
const stalled = (message: string): StandupItem => ({
  kind: "stalled",
  say: { id: message, message },
  grpIds: [1],
});

test("the same standup line is not re-emitted within the re-emit window", async () => {
  const ctx = await testContext();
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  await f.grp.create({ project_id: p.id, name: "g" });
  const item = stalled("two requirements are stuck on the same file");

  await publishStandupItem(ctx, item);
  await publishStandupItem(ctx, item);

  const said = await standupLines(ctx.db);
  // The standup runs on a timer against a condition that persists. Without the
  // window, a group stuck for a day repeats the same line every pass.
  expect(said).toBe(1);
});

test("a standup line returns once the window has passed", async () => {
  const ctx = await testContext();
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  await f.grp.create({ project_id: p.id, name: "g" });
  const item = stalled("still those two requirements");

  await publishStandupItem(ctx, item);
  await ctx.db
    .update(event)
    .set({ at: Date.now() - loadConfig().watchdog.reemitMs - 1 })
    .where(eq(event.author, "standup"));
  await publishStandupItem(ctx, item);

  const said = await standupLines(ctx.db);
  expect(said).toBe(2);
});

test("a standup finding reaches the watchdog channel with the group it is about", async () => {
  const ctx = await testContext();
  const f = fx.on(ctx.db);
  const p = await f.project.create({ name: "p" });
  await f.grp.create({ project_id: p.id, name: "g" });
  const seen: Array<{ rule: string; severity: string; grpId: number | null }> = [];
  ctx.onFinding = (rule, severity, _body, grpId) => seen.push({ rule, severity, grpId });

  await publishStandupItem(ctx, { ...stalled("the budget is nearly gone"), grpIds: [1, 2] });

  // Advisory, not blocker: the standup observes, it does not stop anyone.
  expect(seen).toEqual([{ rule: "stalled", severity: "advisory", grpId: 1 }]);
});

test("a standup line about no group at all still lands", async () => {
  const ctx = await testContext();

  await publishStandupItem(ctx, { ...stalled("nobody is running today"), grpIds: [] });

  const [row] = await ctx.db.select({ grp_id: event.grp_id }).from(event).where(eq(event.author, "standup"));
  expect(row?.grp_id).toBeNull();
});
