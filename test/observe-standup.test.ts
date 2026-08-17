import { expect, test } from "bun:test";
import { logLine } from "../src/observability.ts";
import { maskValue } from "../src/platform/observability/redaction.ts";
import { requestContext } from "../src/platform/observability/request-context.ts";
import { publishStandupItem } from "../src/runtime/executor.ts";
import { REEMIT_MS } from "../src/mech/ops/watchdog.ts";
import { testContext } from "./test-context.ts";

const at = new Date("2026-08-17T09:00:00.000Z");

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

test("the same standup line is not re-emitted within the re-emit window", () => {
  const ctx = testContext();
  ctx.db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  ctx.db.run("INSERT INTO grp (project_id, name, created_at) VALUES (1, 'g', 0)");
  const item = { kind: "stalled", body: "两个需求卡在同一个文件上", grpIds: [1] };

  publishStandupItem(ctx, item);
  publishStandupItem(ctx, item);

  const said = ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event WHERE author = 'standup'").get()!.c;
  // The standup runs on a timer against a condition that persists. Without the
  // window, a group stuck for a day repeats the same line every pass.
  expect(said).toBe(1);
});

test("a standup line returns once the window has passed", () => {
  const ctx = testContext();
  ctx.db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  ctx.db.run("INSERT INTO grp (project_id, name, created_at) VALUES (1, 'g', 0)");
  const item = { kind: "stalled", body: "还是那两个需求", grpIds: [1] };

  publishStandupItem(ctx, item);
  ctx.db.run("UPDATE event SET at = ? WHERE author = 'standup'", [Date.now() - REEMIT_MS - 1]);
  publishStandupItem(ctx, item);

  const said = ctx.db.query<{ c: number }, []>("SELECT count(*) AS c FROM event WHERE author = 'standup'").get()!.c;
  expect(said).toBe(2);
});

test("a standup finding reaches the watchdog channel with the group it is about", () => {
  const ctx = testContext();
  ctx.db.run("INSERT INTO project (name, repo_path, created_at) VALUES ('p', '/tmp/p', 0)");
  ctx.db.run("INSERT INTO grp (project_id, name, created_at) VALUES (1, 'g', 0)");
  const seen: Array<{ rule: string; severity: string; grpId: number | null }> = [];
  ctx.onFinding = (rule, severity, _body, grpId) => seen.push({ rule, severity, grpId });

  publishStandupItem(ctx, { kind: "budget", body: "预算快用完了", grpIds: [1, 2] });

  // Advisory, not blocker: the standup observes, it does not stop anyone.
  expect(seen).toEqual([{ rule: "budget", severity: "advisory", grpId: 1 }]);
});

test("a standup line about no group at all still lands", () => {
  const ctx = testContext();

  publishStandupItem(ctx, { kind: "fleet", body: "今天没有人在跑", grpIds: [] });

  const row = ctx.db.query<{ grp_id: number | null }, []>("SELECT grp_id FROM event WHERE author = 'standup'").get();
  expect(row?.grp_id).toBeNull();
});
