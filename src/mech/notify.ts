/**
 * Getting the boss's attention, sparingly.
 *
 * Two tiers and a backoff, because a system that pings twenty times a day is a
 * system the boss stops reading — at which point every mechanism upstream of the
 * notification is decorative.
 */

export type Tier = "immediate" | "batched";

export interface Notification {
  /** Dedupe identity. Same key + same problem = the same interruption. */
  key: string;
  tier: Tier;
  body: string;
  url?: string;
}

/** Reasons that always interrupt, however busy the boss is. */
const IMMEDIATE_RULES = new Set([
  "blocker",
  "reserved_action",
  "chain_exhausted",
  "turn_timeout",
  "no_progress",
  "circling",
  "env_suspect",
  "budget_exhausted",
  "waiting_on_you",
]);

export function tierFor(rule: string, severity?: string): Tier {
  if (severity === "blocker") return "immediate";
  return IMMEDIATE_RULES.has(rule) ? "immediate" : "batched";
}

/** 5 min, then 15, then hourly. A repeat is a reminder, not a new problem. */
export const BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface NotifierOptions {
  /** Flush the batch when this many pile up. */
  batchSize?: number;
  /** …or when the oldest has waited this long. */
  batchMs?: number;
  /** Delivery. Injected in tests; defaults to macOS notification + optional ntfy. */
  deliver?: (title: string, body: string, url?: string) => void | Promise<void>;
  ntfyTopic?: string;
  now?: () => number;
}

interface Sent {
  at: number;
  strikes: number;
}

export class Notifier {
  private lastSent = new Map<string, Sent>();
  private batch: Notification[] = [];
  private batchOpenedAt = 0;
  private readonly batchSize: number;
  private readonly batchMs: number;
  private readonly now: () => number;
  private readonly deliver: NonNullable<NotifierOptions["deliver"]>;

  constructor(private opts: NotifierOptions = {}) {
    this.batchSize = opts.batchSize ?? 5;
    this.batchMs = opts.batchMs ?? 30 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.deliver = opts.deliver ?? ((t, b, u) => macNotify(t, b, u, opts.ntfyTopic));
  }

  /** Returns true when this actually reached the boss. */
  async push(n: Notification): Promise<boolean> {
    // Both tiers, not just immediate. The watchdog and the standup re-derive the
    // same findings every 30 s and re-push them verbatim; without this the batch
    // filled with five copies of two problems and fired every minute all evening.
    if (!this.dueNow(n.key)) return false;

    if (n.tier === "immediate") {
      await this.deliver("orchestrator", n.body, n.url);
      return true;
    }

    this.batch.push(n);
    if (this.batch.length === 1) this.batchOpenedAt = this.now();
    if (this.batch.length >= this.batchSize || this.now() - this.batchOpenedAt >= this.batchMs) {
      return this.flush();
    }
    return false;
  }

  /** Send whatever is waiting as one interruption. */
  async flush(): Promise<boolean> {
    if (this.batch.length === 0) return false;
    const items = this.batch;
    this.batch = [];
    const body =
      items.length === 1
        ? items[0]!.body
        : `${items.length} things need you:\n` + items.map((i) => `• ${i.body}`).join("\n");
    // No lastSent write here: push() already stamped every key through dueNow,
    // and rewriting it would reset strikes to 1, pinning the backoff at its
    // first step forever.
    await this.deliver("orchestrator", body, items[0]?.url);
    return true;
  }

  pending(): number {
    return this.batch.length;
  }

  /**
   * Backoff, so an unanswered question nags at a decreasing rate instead of
   * every tick.
   *
   * ponytail: in-memory, so a server restart re-notifies once. Persist to a
   * table if that ever becomes annoying in practice.
   */
  private dueNow(key: string): boolean {
    const prev = this.lastSent.get(key);
    const t = this.now();
    if (!prev) {
      this.lastSent.set(key, { at: t, strikes: 1 });
      return true;
    }
    const wait = BACKOFF_MS[Math.min(prev.strikes - 1, BACKOFF_MS.length - 1)]!;
    if (t - prev.at < wait) return false;
    this.lastSent.set(key, { at: t, strikes: prev.strikes + 1 });
    return true;
  }

  /** The boss answered: stop reminding. */
  clear(key: string): void {
    this.lastSent.delete(key);
    this.batch = this.batch.filter((b) => b.key !== key);
  }
}

/**
 * Clicking a notification should open the page it is about.
 *
 * `osascript display notification` cannot carry a click action at all: the
 * notification belongs to whatever app ran the script, so clicking it opens
 * Script Editor. Measured, that looked like the tool pointing the boss at a
 * local folder. `terminal-notifier -open <url>` does the right thing, so use it
 * when it is installed and fall back to osascript with the URL in the text.
 */
let clickable: boolean | null = null;
function hasTerminalNotifier(): boolean {
  if (clickable === null) {
    try {
      clickable = Bun.spawnSync(["terminal-notifier", "-help"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
      clickable = false;
    }
  }
  return clickable;
}

async function macNotify(title: string, body: string, url?: string, ntfyTopic?: string): Promise<void> {
  const text = url ? `${body}\n${url}` : body;
  try {
    if (url && hasTerminalNotifier()) {
      Bun.spawn([
        "terminal-notifier",
        "-title", title,
        "-message", body.slice(0, 400),
        "-open", url,
      ]);
    } else {
      Bun.spawn([
        "osascript",
        "-e",
        `display notification ${JSON.stringify(text.slice(0, 400))} with title ${JSON.stringify(title)}`,
      ]);
    }
  } catch {
    // A missing notification must never take down the run that produced it.
  }
  if (ntfyTopic) {
    // One HTTP POST, no app, no bot. Off unless a topic is configured.
    try {
      await fetch(`https://ntfy.sh/${ntfyTopic}`, { method: "POST", body: text.slice(0, 1000) });
    } catch {}
  }
}

/**
 * Aggregate everything waiting on the boss into one interruption.
 *
 * The CoS is supposed to do this in its own words, but a prompt is not a
 * guarantee: if it is busy, parked or simply does not run, the boss should still
 * get one message rather than N or zero. Deterministic backstop.
 */
export interface PendingItem {
  grpId?: number | null;
  id: number;
  severity: string;
  question: string;
  group: string | null;
}

export function batchForBoss(items: PendingItem[], url?: string): Notification | null {
  if (items.length === 0) return null;
  const blockers = items.filter((i) => i.severity === "blocker");

  if (items.length === 1) {
    const i = items[0]!;
    return {
      key: `escalation:${i.id}`,
      tier: i.severity === "blocker" ? "immediate" : "batched",
      body: `${i.group ?? "someone"}: ${i.question.slice(0, 200)}`,
      // Straight to the requirement that is asking, not the front page.
      url: url && i.grpId ? `${url}/#g=${i.grpId}&v=progress` : url,
    };
  }

  // Keyed by the set, so the reminder backs off while the set is unchanged and
  // fires immediately when something new joins it.
  const key = `batch:${items.map((i) => i.id).sort((a, b) => a - b).join(",")}`;
  const lines = items.map((i) => `• ${i.group ?? "?"}: ${i.question.slice(0, 120)}`);
  return {
    key,
    tier: blockers.length > 0 ? "immediate" : "batched",
    url,
    body:
      `${items.length} waiting on you` +
      (blockers.length ? ` (${blockers.length} blocking)` : "") +
      `:\n${lines.join("\n")}`,
  };
}
