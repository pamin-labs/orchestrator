import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * Either a reading, or why there is not one.
 *
 * The distinction the header needs is not "data / no data". It is "this account
 * has windows and here they are", "this account has windows and we cannot read
 * them right now", and "this account has no windows at all" — the last being an
 * API-key user, who is billed per token and has nothing to run out of.
 */
export type UsageRead = { rl: RateLimitInfo } | { error: string };

export async function fetchClaudeUsage(token: string): Promise<UsageRead> {
  const res = await fetch(ENDPOINT, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": BETA },
    signal: AbortSignal.timeout(10_000),
  });
  // 429 is the one worth naming: it is self-inflicted and it clears by itself, so
  // the header should say "wait" rather than the shrug it says for everything else.
  if (!res.ok) return { error: res.status === 429 ? "rate_limited" : `http_${res.status}` };
  const rl = toRateLimit((await res.json()) as UsageResponse);
  return rl ? { rl } : { error: "no_windows" };
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
  // No OAuth token means no subscription: this account is billed per token, has no
  // window to run out of, and must not get a usage bar at all — an error state
  // there would be reporting the absence of something it never had. Nothing is
  // written, so the row never appears.
  const token = await claudeToken();
  if (!token) return false;

  // Stamped before the attempt, not after a success. The watchdog ticks every 30s,
  // so an interval that only applied to successes meant a failing endpoint was
  // retried twice a minute — and this one answers a failure with 429, which that
  // would then keep feeding. Observed live while testing.
  stamp(db, now, { error: "unreachable" });
  try {
    const read = await fetchClaudeUsage(token);
    stamp(db, now, read);
    return "rl" in read;
  } catch {
    // An undocumented endpoint is allowed to disappear. The header says it cannot
    // read the window rather than implying the window is fine.
    return false;
  }
}

/**
 * Upsert the row.
 *
 * A failure keeps whatever percentages were last read and adds the reason beside
 * them: the window did not move because we could not ask it, and blanking the bar
 * would read as "no data" when what we have is data from a minute ago. A success
 * clears the reason.
 */
function stamp(db: DB, now: number, read: UsageRead): void {
  const patch = "rl" in read ? JSON.stringify(read.rl) : JSON.stringify({ error: read.error });
  db.run(
    `INSERT INTO usage_snapshot (runtime, json, at) VALUES ('claude', ?, ?)
     ON CONFLICT (runtime) DO UPDATE SET
       json = json_patch(usage_snapshot.json, ?), at = excluded.at`,
    ["rl" in read ? patch : "{}", now, "rl" in read ? json_clear(patch) : patch],
  );
}

/** A success has to remove a stale `error`, and json_patch removes on null. */
function json_clear(good: string): string {
  return JSON.stringify({ ...JSON.parse(good), error: null });
}

/**
 * codex's quota, which is not in the stream.
 *
 * `codex exec --json` emits thread.started, turn.started, item.* and
 * turn.completed and nothing else — checked against six real turn logs from this
 * repo. `token_count`, which carries `rate_limits`, is a TUI event. But codex
 * writes a rollout file per session under $CODEX_HOME/sessions, and that file has
 * the same `rate_limits` object in it. Since the orchestrator sets CODEX_HOME
 * itself (codexHome()), those files are ours to read.
 *
 * The shape is not the one the TUI streams: windows come back as
 * `{used_percent, window_minutes, resets_at}` with `resets_at` absolute, and an
 * account may report only one of them — this one has a single 10080-minute
 * window and a null secondary. So the window is identified by its length rather
 * than by which slot it arrived in.
 */
export function codexUsage(dataDir: string, now = Date.now()): RateLimitInfo | null {
  // Not just the newest file: a session that ended before its first quota ping has
  // none, and short ones are common. Walk back through the recent ones.
  for (const file of recentFiles(join(dataDir, "codex-home", "sessions"), 12)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Last reading in the file wins: it grows as the session runs.
    for (const raw of objectsAfter(text, '"rate_limits":').reverse()) {
      try {
        const rl = JSON.parse(raw) as { primary?: CodexWindow; secondary?: CodexWindow };
        const out = fromCodex(rl.primary ?? null, rl.secondary ?? null, now);
        if (out) return out;
      } catch {}
    }
  }
  return null;
}

/**
 * Every JSON object following `key` in the text, brace-matched.
 *
 * A regex cannot do this: the object nests (`primary` is an object inside it), so
 * a non-greedy match ends at the first inner `}` and produces something that
 * parses to the wrong thing or not at all.
 */
export function objectsAfter(text: string, key: string): string[] {
  const out: string[] = [];
  let i = text.indexOf(key);
  while (i !== -1) {
    const start = text.indexOf("{", i + key.length);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < text.length; j++) {
      const c = text[j]!;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = !inStr;
      else if (!inStr && c === "{") depth++;
      else if (!inStr && c === "}" && --depth === 0) {
        out.push(text.slice(start, j + 1));
        break;
      }
    }
    i = text.indexOf(key, i + key.length);
  }
  return out;
}

type CodexWindow = { used_percent?: number; window_minutes?: number; resets_at?: number; resets_in_seconds?: number } | null;

/** 299 minutes is the five-hour window, 10079/10080 the week. Anything else is ignored. */
function fromCodex(...args: [CodexWindow, CodexWindow, number]): RateLimitInfo | null {
  const [a, b, now] = args;
  const wins = [a, b].filter((w): w is NonNullable<CodexWindow> => !!w && w.used_percent !== undefined);
  if (!wins.length) return null;
  const at = (w: NonNullable<CodexWindow>) =>
    w.resets_at ?? (w.resets_in_seconds ? Math.floor(now / 1000) + w.resets_in_seconds : 0);
  const five = wins.find((w) => (w.window_minutes ?? 0) < 600);
  const week = wins.find((w) => (w.window_minutes ?? 0) >= 6000);
  if (!five && !week) return null;
  return {
    status: "allowed",
    rateLimitType: "five_hour",
    resetsAt: five ? at(five) : 0,
    fiveHourPercent: five?.used_percent,
    weeklyPercent: week?.used_percent,
    weeklyResetsAt: week ? at(week) : undefined,
  };
}

/** The `limit` most recently modified files under a directory tree, newest first. */
function recentFiles(root: string, limit: number): string[] {
  const all: { path: string; at: number }[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else all.push({ path: p, at: s.mtimeMs });
      } catch {}
    }
  };
  walk(root);
  return all.sort((a, b) => b.at - a.at).slice(0, limit).map((f) => f.path);
}

/** Both providers, on the watchdog's clock. */
export async function pollUsage(db: DB, dataDir: string, now = Date.now()): Promise<void> {
  await pollClaudeUsage(db, now);
  const rl = codexUsage(dataDir, now);
  if (!rl) return;
  db.run(
    `INSERT INTO usage_snapshot (runtime, json, at) VALUES ('codex', ?, ?)
     ON CONFLICT (runtime) DO UPDATE SET json = excluded.json, at = excluded.at`,
    [JSON.stringify(rl), now],
  );
}
