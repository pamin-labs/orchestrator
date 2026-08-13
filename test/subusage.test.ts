import { expect, test } from "bun:test";
import { openMemory } from "../src/db.ts";
import { POLL_EVERY_MS, pollClaudeUsage, toRateLimit } from "../src/mech/subusage.ts";

// The real response, trimmed to the two windows this reads. Verbatim shape from
// GET /api/oauth/usage — a dozen other keys are present and all ignored.
const RESPONSE = {
  five_hour: { utilization: 3.0, resets_at: "2026-08-13T18:00:00.858800+00:00", limit_dollars: null },
  seven_day: { utilization: 65.0, resets_at: "2026-08-17T07:00:00.858821+00:00", limit_dollars: null },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, used_credits: 1514.0 },
};

test("both windows land in the same shape codex reports", () => {
  const rl = toRateLimit(RESPONSE)!;
  expect(rl.fiveHourPercent).toBe(3);
  expect(rl.weeklyPercent).toBe(65);
  expect(rl.resetsAt).toBe(Math.floor(Date.parse("2026-08-13T18:00:00.858800+00:00") / 1000));
  expect(rl.weeklyResetsAt).toBe(Math.floor(Date.parse("2026-08-17T07:00:00.858821+00:00") / 1000));
  // The stream stays the authority on actual throttling; this is the gauge.
  expect(rl.status).toBe("allowed");
});

test("a response without the windows produces nothing rather than zeroes", () => {
  // The endpoint is undocumented. A shape change must read as "no data", not as
  // "0% used", which would be a green header on a spent account.
  expect(toRateLimit({})).toBeNull();
  expect(toRateLimit({ seven_day_opus: null } as never)).toBeNull();
});

test("a fresh row is left alone until the poll interval is up", async () => {
  const db = openMemory();
  const now = 1_000_000_000;
  db.run("INSERT INTO usage_snapshot (runtime, json, at) VALUES ('claude', '{}', ?)", [now]);
  // No network call, so this also proves the interval is checked before the fetch:
  // the watchdog ticks every 30s and this endpoint is not ours to hammer.
  expect(await pollClaudeUsage(db, now + POLL_EVERY_MS - 1)).toBe(false);
});
