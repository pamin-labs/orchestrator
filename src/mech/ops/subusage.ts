import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../../db.ts";
import type { RateLimitInfo } from "../../runtime/claude.ts";
import { CODEX_HOME, loadAuth, subscriptionAccount } from "../sandbox/auth.ts";

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
 * Anthropic. Everything here therefore degrades rather than fails: no credential,
 * an expired token, a changed response — the header falls back to the status and
 * reset time the stream does give us. Nothing in the orchestrator may depend on
 * this working, and upstream says it barely does: anthropics/claude-code#31637
 * and #31021 report it 429ing so hard that polling it at any interval is
 * unusable, for hours at a time.
 *
 * The credential is the one on the settings page. Nothing here reads a host CLI
 * session — see `usageToken`.
 */

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";

/**
 * Ten minutes, which is as often as this endpoint will actually answer.
 *
 * It was one minute, on the reasoning that the windows move in hours and a
 * minute-fresh number costs one request. What that ignores is the endpoint's own
 * budget: it answers a 30-60s poller with 429 and then keeps answering 429, which
 * is the failure mode every community monitor hits
 * (anthropics/claude-code#31637, #31021, #30930). Live here the row sat on
 * `"error":"rate_limited"` with numbers 8 minutes old and no way out, because the
 * retry after the backoff was itself too soon.
 *
 * The boss's own `/status` in the CLI spends from the same budget, so polling
 * hard also makes their check fail. Ten minutes inside a five-hour window is a
 * 3% error at worst.
 */
export const POLL_EVERY_MS = 10 * 60_000;

/**
 * After a 429, back off hard.
 *
 * The endpoint answers a too-frequent read with 429 and it is not ours to tune,
 * so the polite response to being told to slow down is to slow down. Ten minutes
 * was not enough to clear it — the throttle is per account and the boss's own CLI
 * is spending from it too — and a retry that earns another 429 restarts the
 * lockout. The header keeps showing the last good reading meanwhile, which is
 * what it should do: the window moves in hours.
 */
export const BACKOFF_MS = 45 * 60_000;

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
 * The token the usage call is made with: the one on the settings page.
 *
 * This used to read the *host's* own Claude Code login — the macOS keychain
 * entry, falling back to `~/.claude/.credentials.json` — which contradicted the
 * check three lines below it. `subscriptionAccount` gates on `runtime_auth`,
 * whose own comment says a bar sourced from "whatever this host happens to be
 * logged into" would be about an account the fleet never touches; and then the
 * number came from exactly that. Two different accounts, one label.
 *
 * It was also the last place anything reached into a host CLI session, and the
 * only platform-specific one in the file — `security` is macOS, the file
 * fallback is Linux, and Windows had neither.
 */
function usageToken(db: DB): string | null {
  const a = loadAuth(db, "claude");
  return a?.mode === "oauth_token" ? a.secret : null;
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
  // What the fleet spends is the credential on the settings page, not whatever
  // this host is logged into — and this endpoint only reports on the provider's
  // own subscriptions. An API key or a gateway therefore gets no bar, and any row
  // left over from before the switch is deleted rather than left to age.
  if (!subscriptionAccount(db, "claude")) {
    db.run("DELETE FROM usage_snapshot WHERE runtime = 'claude'");
    return false;
  }
  const last = db
    .query<{ at: number }, []>("SELECT at FROM usage_snapshot WHERE runtime = 'claude'")
    .get()?.at;
  const prev = db
    .query<{ json: string }, []>("SELECT json FROM usage_snapshot WHERE runtime = 'claude'")
    .get()?.json;
  const throttled = !!prev && prev.includes('"error":"rate_limited"');
  if (last && now - last < (throttled ? BACKOFF_MS : POLL_EVERY_MS)) return false;
  // The settings-page credential, which is also the one `subscriptionAccount`
  // just checked. An api_key or a ChatGPT-style login has no OAuth token to ask
  // with, and that writes nothing rather than an error: a missing gauge is not
  // news the header can act on.
  const token = usageToken(db);
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
 * the same `rate_limits` object in it.
 *
 * **Where those files are moved with the turns.** Since 005 a turn runs in a
 * container and `CODEX_HOME` is `/root/.codex` *inside it*, so the host's
 * `<dataDir>/codex-home/sessions` holds only the weekly refresh nudge's own
 * rollout — the quota it reports is the account's, and correct, but as of
 * whenever the nudge last ran. The fleet's own sessions, the fresh ones, are in
 * the sandboxes. So the sandbox is asked first and the host is the fallback.
 *
 * The shape is not the one the TUI streams: windows come back as
 * `{used_percent, window_minutes, resets_at}` with `resets_at` absolute, and an
 * account may report only one of them — this one has a single 10080-minute
 * window and a null secondary. So the window is identified by its length rather
 * than by which slot it arrived in.
 */
export function rateLimitsIn(text: string, now: number): RateLimitInfo | null {
  // Last reading in the file wins: it grows as the session runs.
  for (const raw of objectsAfter(text, '"rate_limits":').reverse()) {
    try {
      const rl = JSON.parse(raw) as { primary?: CodexWindow; secondary?: CodexWindow };
      const out = fromCodex(rl.primary ?? null, rl.secondary ?? null, now);
      if (out) return out;
    } catch {}
  }
  return null;
}

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
    const out = rateLimitsIn(text, now);
    if (out) return out;
  }
  return null;
}

/**
 * The tail of the newest rollout in a container, for the same parse.
 *
 * The tail, because a rollout is a whole transcript and only the last quota ping
 * in it matters. One `find`, one `tail`, on the watchdog's five-minute clock.
 */
export const NEWEST_ROLLOUT =
  `f=$(find ${CODEX_HOME}/sessions -type f -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | ` +
  `sort -rn | head -1 | cut -d' ' -f2-); [ -n "$f" ] && tail -c 200000 "$f"`;

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

/**
 * Both providers, on the watchdog's clock.
 *
 * `fromSandbox` is injected rather than reached for, like every other network or
 * container call on this tick: a unit test must not need a running sandbox to
 * poll usage, and the fallback has to be exercised on its own.
 */
export async function pollUsage(
  db: DB,
  dataDir: string,
  now = Date.now(),
  fromSandbox?: () => Promise<string | null>,
): Promise<void> {
  await pollClaudeUsage(db, now);
  // Same rule as claude, stated rather than inferred: an api_key session's rollout
  // file happens to carry no `rate_limits`, so this used to be right by accident.
  if (!subscriptionAccount(db, "codex")) {
    db.run("DELETE FROM usage_snapshot WHERE runtime = 'codex'");
    return;
  }
  // The sandboxes first: that is where the fleet's own sessions are now, and the
  // host copy is only ever as fresh as the last weekly refresh nudge.
  //
  // On the same clock as the claude poll, and for the same reason one layer over:
  // reading it is a `commands.run` at ~1s inside a container the agents are
  // sharing, and the watchdog ticks every 30s. A quota gauge does not need to be
  // a second of container time twice a minute.
  let rl: RateLimitInfo | null = null;
  const last = db
    .query<{ at: number }, []>("SELECT at FROM usage_snapshot WHERE runtime = 'codex'")
    .get()?.at;
  if (last && now - last < POLL_EVERY_MS) return;
  const rollout = await fromSandbox?.().catch(() => null);
  if (rollout) rl = rateLimitsIn(rollout, now);
  if (!rl) rl = codexUsage(dataDir, now);
  if (!rl) return;
  db.run(
    `INSERT INTO usage_snapshot (runtime, json, at) VALUES ('codex', ?, ?)
     ON CONFLICT (runtime) DO UPDATE SET json = excluded.json, at = excluded.at`,
    [JSON.stringify(rl), now],
  );
}
