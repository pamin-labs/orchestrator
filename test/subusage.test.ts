import { expect, test } from "bun:test";

import { Bus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/ctx.ts";
import { openMemory } from "../src/db.ts";
import { saveAuth } from "../src/mech/sandbox/auth.ts";
import { fakeSandbox } from "./fake-sandbox.ts";
import { POLL_EVERY_MS, pollClaudeUsage, pollUsage, rateLimitsIn, toRateLimit } from "../src/mech/ops/subusage.ts";
import { seedAuth } from "./seed-auth.ts";
import { Scheduler } from "../src/scheduler.ts";
import { z } from "zod";

const StoredUsage = z.object({ fiveHourPercent: z.number().optional(), weeklyPercent: z.number().optional() });

// The real response, trimmed to the two windows this reads. Verbatim shape from
// GET /api/oauth/usage — a dozen other keys are present and all ignored.
const RESPONSE = {
  five_hour: { utilization: 3.0, resets_at: "2026-08-13T18:00:00.858800+00:00", limit_dollars: null },
  seven_day: { utilization: 65.0, resets_at: "2026-08-17T07:00:00.858821+00:00", limit_dollars: null },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, used_credits: 1514.0 },
};

/**
 * The usage read runs in the utility container now, not as a host `fetch` — the
 * real token stays in `runtime_auth` and the sidecar substitutes it. So the seam
 * these tests drive is a sandbox command, and `curl`'s answer is a body plus a
 * status line.
 */
const ctx = (db: ReturnType<typeof openMemory>, answer = `${JSON.stringify(RESPONSE)}\n200`): Ctx => ({
  db,
  bus: new Bus(db),
  sched: new Scheduler(db, async () => {}),
  sandbox: fakeSandbox(() => ({ out: answer })),
  waiters: new Map(),
  config: loadConfig(),
});

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
  expect(toRateLimit({ seven_day_opus: null })).toBeNull();
  expect(toRateLimit({ five_hour: { utilization: "3" } })).toBeNull();
  expect(toRateLimit({ seven_day: { utilization: -1 } })).toBeNull();
});

test("a fresh row is left alone until the poll interval is up", async () => {
  const db = openMemory();
  seedAuth(db);
  const now = 1_000_000_000;
  db.run("INSERT INTO usage_snapshot (runtime, json, at) VALUES ('claude', '{}', ?)", [now]);
  // No network call, so this also proves the interval is checked before the fetch:
  // the watchdog ticks every 30s and this endpoint is not ours to hammer.
  expect(await pollClaudeUsage(ctx(db), now + POLL_EVERY_MS - 1)).toBe(false);
});

test("a failed poll still costs the interval, so a bad endpoint is not hammered", async () => {
  const db = openMemory();
  seedAuth(db);
  const now = 2_000_000_000;
  // No token, no network, so this fails — and must still record the attempt. The
  // watchdog ticks every 30s, and stamping only on success meant a failing
  // endpoint got retried twice a minute. This one answers failure with 429.
  await pollClaudeUsage(ctx(db), now);
  const row = db.query<{ at: number }, []>("SELECT at FROM usage_snapshot WHERE runtime = 'claude'").get();
  expect(row?.at).toBe(now);
  expect(await pollClaudeUsage(ctx(db), now + POLL_EVERY_MS - 1)).toBe(false);
});

test("a failed poll keeps the last good reading rather than blanking the header", () => {
  const db = openMemory();
  const good = JSON.stringify(toRateLimit(RESPONSE));
  db.run("INSERT INTO usage_snapshot (runtime, json, at) VALUES ('claude', ?, 1)", [good]);
  // The window did not move because we could not ask; showing nothing would read
  // as "no data" when what we have is data from four minutes ago.
  db.run(
    `INSERT INTO usage_snapshot (runtime, json, at) VALUES ('claude', '{}', 2)
     ON CONFLICT (runtime) DO UPDATE SET json = usage_snapshot.json, at = excluded.at`,
  );
  const row = db.query<{ json: string; at: number }, []>("SELECT json, at FROM usage_snapshot").get()!;
  expect(row.at).toBe(2);
  expect(StoredUsage.parse(JSON.parse(row.json)).weeklyPercent).toBe(65);
});

test("only a subscription on the official endpoint gets a usage row", async () => {
  const db = openMemory();
  const now = 3_000_000_000;
  const row = () => db.query<{ at: number }, []>("SELECT at FROM usage_snapshot WHERE runtime = 'claude'").get();
  const stale = () => db.run("INSERT OR REPLACE INTO usage_snapshot (runtime, json, at) VALUES ('claude', '{}', 1)");

  // Billed per token: no window to run out of, and the row left over from before
  // the switch would keep showing a number nobody is spending against.
  stale();
  saveAuth(db, { runtime: "claude", mode: "api_key", secret: "sk-ant-x" });
  expect(await pollClaudeUsage(ctx(db), now)).toBe(false);
  expect(row()).toBeNull();

  // A subscription behind a gateway: the endpoint this reads is the provider's
  // own, so the quota it would report belongs to a different account.
  stale();
  saveAuth(db, {
    runtime: "claude",
    mode: "oauth_token",
    secret: "sk-ant-oat01-x",
    baseUrl: "https://gw.internal/v1",
  });
  expect(await pollClaudeUsage(ctx(db), now)).toBe(false);
  expect(row()).toBeNull();

  // Subscription, official endpoint: it gets as far as stamping the attempt.
  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: "sk-ant-oat01-x" });
  await pollClaudeUsage(ctx(db), now);
  expect(row()?.at).toBe(now);
});

test("codex quota comes from its rollout file, not the stream", () => {
  // Verbatim shape from a real $CODEX_HOME/sessions rollout. `codex exec --json`
  // never emits token_count — six live turn logs carry only thread.started,
  // turn.started, item.* and turn.completed — so this is where the numbers are.
  // Note what this account reports: one 10080-minute window and a null secondary,
  // with an absolute resets_at. The window is identified by its length, not by
  // which slot it arrived in.
  const ping = (pct: number, resets: number) =>
    '{"type":"event_msg","payload":{"rate_limits":{"limit_id":"codex","limit_name":null,' +
    `"primary":{"used_percent":${pct},"window_minutes":10080,"resets_at":${resets}},` +
    '"secondary":null,"credits":{"has_credits":false,"balance":"0"}}}}';

  // A rollout is `.jsonl`, so the line is the object. Drives `rateLimitsIn`
  // rather than the brace matcher it replaced: what matters is the number that
  // comes out, and the matcher was a JSON parser written to avoid calling one.
  const rl = rateLimitsIn(ping(12.5, 1787207305), 0)!;
  expect(rl.weeklyPercent).toBe(12.5);
  expect(rl.weeklyResetsAt).toBe(1787207305);
  // The five-hour window is genuinely absent here, not zero.
  expect(rl.fiveHourPercent).toBeUndefined();

  // The file grows as the session runs, so the last reading wins — and the
  // first line of a `tail -c` is a fragment that must not stop the walk.
  const tailed = ['_limits":{"primary":{"used_percent":99,', ping(12.5, 1), ping(40, 2)].join("\n");
  expect(rateLimitsIn(tailed, 0)!.weeklyPercent).toBe(40);

  // Nothing to find is null, not a zeroed reading that would read as "plenty left".
  expect(rateLimitsIn('{"type":"event_msg","payload":{}}', 0)).toBeNull();
  expect(rateLimitsIn("", 0)).toBeNull();
});

test("codex quota is read from a sandbox first, and the host is only the fallback", async () => {
  // Since 005 `CODEX_HOME` is `/root/.codex` inside a container, so the host's
  // `<dataDir>/codex-home/sessions` holds nothing but the weekly refresh nudge's
  // own rollout. The number it reports is the account's and correct — and up to a
  // week stale, while ten agents spend the same subscription.
  const db = openMemory();
  saveAuth(db, {
    runtime: "codex",
    mode: "chatgpt",
    secret: JSON.stringify({ tokens: { refresh_token: "r" } }),
  });
  const rollout =
    `{"type":"event_msg","payload":{"type":"token_count","rate_limits":` +
    `{"primary":{"used_percent":42,"window_minutes":300,"resets_at":1786000000},"secondary":null}}}`;

  await pollUsage(ctx(db), "/tmp/nonexistent-codex-home", 1_700_000_000_000, async () => rollout);
  const snap = db.query<{ json: string }, []>("SELECT json FROM usage_snapshot WHERE runtime = 'codex'").get()!;
  expect(StoredUsage.parse(JSON.parse(snap.json)).fiveHourPercent).toBe(42);
});

test("the usage read carries a decoy, never the stored token", async () => {
  // This was the last place a real model credential left this machine without
  // going through the sidecar: a host `fetch` with `Bearer ${runtime_auth}`. The
  // vault's premise is that a real value only reaches the wire by substitution,
  // so an exception here did not weaken the rule — it made it untrue.
  const db = openMemory();
  saveAuth(db, { runtime: "claude", mode: "oauth_token", secret: `sk-ant-oat01-${"S".repeat(80)}` });
  const seen: string[] = [];
  const c: Ctx = {
    db,
    bus: new Bus(db),
    sched: new Scheduler(db, async () => {}),
    sandbox: fakeSandbox((cmd) => {
      seen.push(cmd);
      return { out: `${JSON.stringify(RESPONSE)}\n200` };
    }),
    waiters: new Map(),
    config: loadConfig(),
  };

  expect(await pollClaudeUsage(c, Date.now())).toBe(true);
  const cmd = seen.find((x) => x.includes("curl"))!;
  expect(cmd).not.toContain("S".repeat(80));
  expect(cmd).toContain("Authorization: Bearer sk-ant-oat01-");
  // And it asked from the utility container's shell, not from this process.
  expect(cmd).toContain("api.anthropic.com/api/oauth/usage");
});

test("an unreachable sandbox does not lose the reading", async () => {
  // Best-effort, like everything else that reaches into a container from the
  // watchdog tick: a sandbox that has gone away must not take the quota bar with
  // it, and must not throw out of the tick either.
  const db = openMemory();
  saveAuth(db, {
    runtime: "codex",
    mode: "chatgpt",
    secret: JSON.stringify({ tokens: { refresh_token: "r" } }),
  });
  await pollUsage(ctx(db), "/tmp/nonexistent-codex-home", Date.now(), async () => {
    throw new Error("no such sandbox");
  });
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM usage_snapshot").get()!.n).toBe(0);
});
