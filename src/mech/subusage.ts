import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DB } from "../db.ts";
import type { RateLimitInfo } from "../runtime/claude.ts";

/**
 * How much of the claude subscription's windows is gone.
 *
 * The CLI's own stream will not say. 267 real `rate_limit_event` frames in this
 * repo's logs carry a status, a type and a reset time — never a percentage — so
 * "am I about to run out tonight" was unanswerable from the turn stream alone.
 * codex volunteers both windows in every `token_count`, which is why only this
 * side needs a poller.
 *
 * The endpoint is the one every community monitor uses and is not documented by
 * Anthropic. Everything here therefore degrades rather than fails: no keychain
 * entry, an expired token, a changed response — the header falls back to the
 * status and reset time the stream does give us. Nothing in the orchestrator may
 * depend on this working.
 *
 * Read-only on the credentials. Claude Code owns that token and refreshes it;
 * writing there from here would fight the process that maintains it.
 */

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";

/**
 * One minute. The windows move in hours, so this is already generous — what it
 * really buys is that the header is never more than a minute stale when the boss
 * glances at it. Every read in between comes from usage_snapshot, not the network:
 * the panel polls /api/state on its own clock and must never turn into traffic
 * here. codex needs none of this; it reports both windows in every turn it runs.
 */
export const POLL_EVERY_MS = 60_000;

type Window = { utilization?: number; resets_at?: string | null };

/** Only the two windows are consumed; the response has a dozen more fields. */
export interface UsageResponse {
  five_hour?: Window;
  seven_day?: Window;
}

const secs = (iso?: string | null): number =>
  iso ? Math.floor(new Date(iso).getTime() / 1000) : 0;

export function toRateLimit(u: UsageResponse): RateLimitInfo | null {
  const five = u.five_hour;
  const week = u.seven_day;
  if (five?.utilization === undefined && week?.utilization === undefined) return null;
  return {
    // The stream is the authority on whether we are actually throttled; this is
    // the gauge, not the alarm.
    status: "allowed",
    rateLimitType: "five_hour",
    resetsAt: secs(five?.resets_at),
    fiveHourPercent: five?.utilization,
    weeklyPercent: week?.utilization,
    weeklyResetsAt: week?.resets_at ? secs(week.resets_at) : undefined,
  };
}

/**
 * The OAuth access token Claude Code is using.
 *
 * macOS keeps it in the keychain, other platforms in a file. Both are read, in
 * that order, and either missing is a normal state — the boss may be on an API
 * key, or not logged in at all.
 */
export async function claudeToken(home = homedir()): Promise<string | null> {
  try {
    const p = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) === 0 && out.trim()) {
      const t = JSON.parse(out).claudeAiOauth?.accessToken;
      if (t) return t as string;
    }
  } catch {}
  try {
    const f = join(home, ".claude/.credentials.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")).claudeAiOauth?.accessToken ?? null;
  } catch {}
  return null;
}

export async function fetchClaudeUsage(token: string): Promise<RateLimitInfo | null> {
  const res = await fetch(ENDPOINT, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": BETA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return toRateLimit((await res.json()) as UsageResponse);
}

/**
 * Refresh the claude row of usage_snapshot, at most every POLL_EVERY_MS.
 *
 * Called from the watchdog tick, which already runs on a clock nobody has to
 * remember to wind. Returns whether it wrote, for the test.
 */
export async function pollClaudeUsage(db: DB, now = Date.now()): Promise<boolean> {
  const last = db
    .query<{ at: number }, []>("SELECT at FROM usage_snapshot WHERE runtime = 'claude'")
    .get()?.at;
  if (last && now - last < POLL_EVERY_MS) return false;
  // Stamped before the attempt, not after a success. The watchdog ticks every 30s,
  // so an interval that only applied to successes meant a failing endpoint was
  // retried twice a minute — and this one answers a failure with 429, which that
  // would then keep feeding. Observed live while testing.
  stamp(db, now, null);
  try {
    const token = await claudeToken();
    if (!token) return false;
    const rl = await fetchClaudeUsage(token);
    if (!rl) return false;
    stamp(db, now, rl);
    return true;
  } catch {
    // An undocumented endpoint is allowed to disappear. The header degrades to
    // what the turn stream reports and the system does not notice.
    return false;
  }
}

/** Upsert the row. A null reading records the attempt and keeps the last good one. */
function stamp(db: DB, now: number, rl: RateLimitInfo | null): void {
  db.run(
    `INSERT INTO usage_snapshot (runtime, json, at) VALUES ('claude', ?, ?)
     ON CONFLICT (runtime) DO UPDATE SET json = ${rl ? "excluded.json" : "usage_snapshot.json"},
       at = excluded.at`,
    [JSON.stringify(rl ?? {}), now],
  );
}
