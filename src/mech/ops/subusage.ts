import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../../db.ts";
import type { RateLimitInfo } from "../../runtime/claude.ts";
import type { Ctx } from "../../ctx.ts";
import { CODEX_HOME, decoy, loadAuth, subscriptionAccount } from "../sandbox/auth.ts";
import { execIn, UTIL } from "../sandbox/sandbox.ts";
import { shq } from "../../platform/process/shell.ts";
import { jsonOr } from "../../contracts/json.ts";
import { z } from "zod";

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
const BACKOFF_MS = 45 * 60_000;

/** Only the two windows are consumed; the response has a dozen more fields. */
const SubscriptionWindow = z.object({
  utilization: z.number().nonnegative().optional(),
  resets_at: z.string().nullable().optional(),
});
const UsageResponse = z.object({
  five_hour: SubscriptionWindow.optional(),
  seven_day: SubscriptionWindow.optional(),
});

const CodexWindowSchema = z.object({
  used_percent: z.number().nonnegative().max(100).optional(),
  window_minutes: z.number().positive().optional(),
  resets_at: z.number().nonnegative().optional(),
  resets_in_seconds: z.number().nonnegative().optional(),
});
const CodexWindowsSchema = z.object({
  primary: CodexWindowSchema.nullable().optional(),
  secondary: CodexWindowSchema.nullable().optional(),
});
const CodexRolloutLine = z.object({ payload: z.object({ rate_limits: CodexWindowsSchema }).optional() });
type CodexWindow = z.infer<typeof CodexWindowSchema> | null;
/** A window with an actual reading attached; windows without one are absent, not zero. */
type CodexReading = NonNullable<CodexWindow> & { used_percent: number };

const secs = (iso?: string | null): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
};

export function toRateLimit(value: unknown): RateLimitInfo | null {
  const parsed = UsageResponse.safeParse(value);
  if (!parsed.success) return null;
  const u = parsed.data;
  const five = u.five_hour;
  const week = u.seven_day;
  if (five?.utilization === undefined && week?.utilization === undefined) return null;
  return {
    // The stream is the authority on whether we are actually throttled; this is
    // the gauge, not the alarm.
    status: "allowed",
    rateLimitType: "five_hour",
    resetsAt: secs(five?.resets_at),
    ...(five?.utilization === undefined ? {} : { fiveHourPercent: five.utilization }),
    ...(week?.utilization === undefined ? {} : { weeklyPercent: week.utilization }),
    ...(week?.resets_at ? { weeklyResetsAt: secs(week.resets_at) } : {}),
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
type UsageRead = { rl: RateLimitInfo } | { error: string };

/**
 * Asked from the utility container, with a decoy, like everything else.
 *
 * This was a host `fetch` carrying the **real** token out of `runtime_auth`, and
 * it was the last place a real model credential left this machine without going
 * through the sidecar. The vault's whole premise is that a real value only
 * appears on the wire when the sidecar substitutes it — so an exception here did
 * not weaken the rule, it made the rule untrue, and nobody reading the rule
 * would have found it.
 *
 * Injection *replaces* an Authorization header the client already set (005), so
 * curl has to send something: it sends the same decoy every container holds, and
 * the sidecar swaps in the real token on the way out. The utility container, not
 * a group's — this is a subscription-wide reading and nothing an agent asked for.
 *
 * `-w` puts the status on its own last line, because curl's body and its exit
 * code cannot tell 429 from 500 and 429 is the one worth naming.
 */
async function fetchClaudeUsage(ctx: Ctx): Promise<UsageRead> {
  const auth = `Authorization: Bearer ${decoy("claude", "oauth_token")}`;
  const r = await execIn(
    ctx,
    UTIL,
    `curl -s -m 10 -w '\n%{http_code}' -H ${shq(auth)} -H ${shq(`anthropic-beta: ${BETA}`)} ${shq(ENDPOINT)}`,
    { timeoutMs: 30_000 },
  );
  if (r.code !== 0) return { error: "unreachable" };
  const lines = r.out.trimEnd().split("\n");
  const status = Number(lines.pop());
  // 429 is the one worth naming: it is self-inflicted and it clears by itself, so
  // the header should say "wait" rather than the shrug it says for everything else.
  if (status !== 200) return { error: status === 429 ? "rate_limited" : `http_${status || "unreachable"}` };
  try {
    const rl = toRateLimit(JSON.parse(lines.join("\n")));
    return rl ? { rl } : { error: "no_windows" };
  } catch {
    return { error: "no_windows" };
  }
}

/**
 * Refresh the claude row of usage_snapshot, at most every POLL_EVERY_MS.
 *
 * Called from the watchdog tick, which already runs on a clock nobody has to
 * remember to wind. Returns whether it wrote, for the test.
 */
export async function pollClaudeUsage(ctx: Ctx, now = Date.now()): Promise<boolean> {
  const db = ctx.db;
  // What the fleet spends is the credential on the settings page, not whatever
  // this host is logged into — and this endpoint only reports on the provider's
  // own subscriptions. An API key or a gateway therefore gets no bar, and any row
  // left over from before the switch is deleted rather than left to age.
  if (!subscriptionAccount(db, "claude")) {
    db.run("DELETE FROM usage_snapshot WHERE runtime = 'claude'");
    return false;
  }
  const last = db.query<{ at: number }, []>("SELECT at FROM usage_snapshot WHERE runtime = 'claude'").get()?.at;
  const prev = db.query<{ json: string }, []>("SELECT json FROM usage_snapshot WHERE runtime = 'claude'").get()?.json;
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
    const read = await fetchClaudeUsage(ctx);
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
  const update = "rl" in read ? JSON.stringify({ ...read.rl, error: null }) : patch;
  db.run(
    `INSERT INTO usage_snapshot (runtime, json, at) VALUES ('claude', ?, ?)
     ON CONFLICT (runtime) DO UPDATE SET
       json = json_patch(usage_snapshot.json, ?), at = excluded.at`,
    ["rl" in read ? patch : "{}", now, update],
  );
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
  // A rollout is `.jsonl` — one object per line — so the line is the object and
  // `JSON.parse` is the parser. This used to brace-match its way through the raw
  // text with its own string and escape state, which is a JSON parser written to
  // avoid calling one.
  //
  // `NEWEST_ROLLOUT` tails the last 200KB, so the first line can be a fragment.
  // It throws, it is skipped, and it is the oldest reading in the window — which
  // is the one this function discards anyway.
  const lines = text.split("\n").filter((l) => l.includes('"rate_limits"'));
  // Last reading in the file wins: it grows as the session runs.
  for (let i = lines.length - 1; i >= 0; i--) {
    const rl = jsonOr(lines[i], CodexRolloutLine.nullable(), null)?.payload?.rate_limits;
    const out = rl && fromCodex(rl.primary ?? null, rl.secondary ?? null, now);
    if (out) return out;
  }
  return null;
}

function codexUsage(dataDir: string, now = Date.now()): RateLimitInfo | null {
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

/** 299 minutes is the five-hour window, 10079/10080 the week. Anything else is ignored. */
function fromCodex(...args: [CodexWindow, CodexWindow, number]): RateLimitInfo | null {
  const [a, b, now] = args;
  const wins = [a, b].filter((w): w is CodexReading => !!w && w.used_percent !== undefined);
  if (!wins.length) return null;
  const five = wins.find((w) => (w.window_minutes ?? 0) < 600);
  const week = wins.find((w) => (w.window_minutes ?? 0) >= 6000);
  if (!five && !week) return null;
  return {
    status: "allowed",
    rateLimitType: "five_hour",
    resetsAt: five ? resetAt(five, now) : 0,
    ...(five ? { fiveHourPercent: five.used_percent } : {}),
    ...(week ? { weeklyPercent: week.used_percent } : {}),
    ...(week ? { weeklyResetsAt: resetAt(week, now) } : {}),
  };
}

function resetAt(window: NonNullable<CodexWindow>, now: number): number {
  if (window.resets_at !== undefined) return window.resets_at;
  return window.resets_in_seconds ? Math.floor(now / 1000) + window.resets_in_seconds : 0;
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
  return all
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((f) => f.path);
}

/**
 * Both providers, on the watchdog's clock.
 *
 * `fromSandbox` is injected rather than reached for, like every other network or
 * container call on this tick: a unit test must not need a running sandbox to
 * poll usage, and the fallback has to be exercised on its own.
 */
export async function pollUsage(
  ctx: Ctx,
  dataDir: string,
  now = Date.now(),
  fromSandbox?: () => Promise<string | null>,
): Promise<void> {
  const db = ctx.db;
  await pollClaudeUsage(ctx, now);
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
  const last = db.query<{ at: number }, []>("SELECT at FROM usage_snapshot WHERE runtime = 'codex'").get()?.at;
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
