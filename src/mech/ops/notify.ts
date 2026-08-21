/**
 * Getting the boss's attention, sparingly.
 *
 * Two tiers and a backoff, because a system that pings twenty times a day is a
 * system the boss stops reading — at which point every mechanism upstream of the
 * notification is decorative.
 */

import { say } from "../../platform/text/lang.ts";
import { scrub } from "../../platform/observability/redaction.ts";
import { DEFAULTS_FOR_CHECK as DEFAULTS } from "../../platform/config/load.ts";
import type { Bus } from "../../platform/persistence/event-bus.ts";

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
  "budget_exhausted",
  "waiting_on_you",
]);

/**
 * Findings the boss can actually do something about.
 *
 * A notification claims the reader has to act. Most watchdog rules are the opposite:
 * the system noticed something and already handled it, arriving under a heading
 * saying "5 things need you". Two of those and the heading stops meaning anything,
 * which costs the notifications that were real.
 *
 * So: the boss's own queue, plus money running out.
 */
const BOSS_RULES = new Set([
  "blocker",
  "reserved_action",
  "chain_exhausted",
  "budget_exhausted",
  "waiting_on_you",
  "waiting_card",
  "waiting_slice",
  "waiting_merge",
  "waiting_parked",
]);

export function notifiable(rule: string, severity?: string): boolean {
  return severity === "blocker" || BOSS_RULES.has(rule);
}

export function tierFor(rule: string, severity?: string): Tier {
  if (severity === "blocker") return "immediate";
  return IMMEDIATE_RULES.has(rule) ? "immediate" : "batched";
}

/**
 * Defaults read off the config rather than restated: `intervals.notifyBackoffMs`
 * is 5 min, then 15, then hourly, because a repeat is a reminder and not a new
 * problem. Production passes the live values from `Config`; these apply where
 * there is no one to ask, which is the tests.
 */
const BACKOFF_MS = DEFAULTS.intervals.notifyBackoffMs;

export interface NotifierOptions {
  /** Flush the batch when this many pile up. */
  batchSize?: number;
  /** …or when the oldest has waited this long. `intervals.notifyBatchMs`. */
  batchMs?: number;
  /** The reminder ladder, longest step last. `intervals.notifyBackoffMs`. */
  backoffMs?: number[];
  /** Delivery. Injected everywhere: the server passes `busDeliver`, tests pass a spy. */
  deliver?: (title: string, body: string, url?: string) => void | Promise<void>;
  /**
   * `output.language`, for the one sentence this class writes itself.
   *
   * Every item in a batch is already in the boss's language and the heading over
   * them was the literal `N things need you:` — English, on the one string that
   * arrives as a system notification.
   */
  lang?: string;
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
  private readonly backoffMs: number[];
  private readonly now: () => number;

  private readonly lang: string | undefined;
  private readonly deliver: NonNullable<NotifierOptions["deliver"]>;

  private readonly opts: NotifierOptions;

  constructor(opts: NotifierOptions = {}) {
    this.opts = opts;
    this.batchSize = opts.batchSize ?? 5;
    this.batchMs = opts.batchMs ?? DEFAULTS.intervals.notifyBatchMs;
    // Never empty: an empty ladder makes the wait below `undefined` and every
    // reminder immediate, which is the noise this class exists to stop.
    this.backoffMs = opts.backoffMs?.length ? opts.backoffMs : BACKOFF_MS;
    this.now = opts.now ?? (() => Date.now());
    this.lang = opts.lang;
    // No default. There is exactly one delivery path and the server owns it, so
    // a Notifier built without one is a test, and a test that forgot its spy
    // should fail rather than quietly notify nobody.
    this.deliver = opts.deliver ?? (() => {});
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
        : `${say(this.lang, "notify.batch", { n: items.length })}\n` + items.map((i) => `• ${i.body}`).join("\n");
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
    const wait = this.backoffMs[Math.min(prev.strikes - 1, this.backoffMs.length - 1)]!;
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
 * Delivery: the page tells you, and optionally a webhook.
 *
 * This was `terminal-notifier` or `osascript`, both macOS-only — so the one path
 * meant to reach the boss did not exist on windows-x64, which is a shipped target.
 */
/**
 * The panel is already open on the machine the server runs on; that is the whole
 * deployment. So the server pushes a frame and the page raises a real system
 * notification through the browser: no dependency, no install, same code on all five
 * targets. A background tab keeps its EventSource and raises it anyway, which is the
 * case `terminal-notifier` was actually covering.
 *
 * Web Push would cover the closed browser too. Not here on purpose: a service
 * worker, VAPID keys, a subscription table and a round trip through FCM.
 */
export function busDeliver(bus: Bus, webhook?: string, timeoutMs: number = DEFAULTS.timeouts.webhookMs) {
  return async (title: string, body: string, url?: string): Promise<void> => {
    // A frame of its own rather than an ordinary event: the page raises a system
    // notification for these and nothing else, and "everything the boss might
    // want" is what turns a notification into noise.
    await bus.emit({ author: "orchestrator", kind: "notify", body, meta: { url, title } });
    if (!webhook) return;
    try {
      // Scrubbed, because this is the one thing here that leaves the machine.
      // Escalation text and watchdog findings do not pass the bus masker on the
      // way in, and a webhook URL is somebody else's server.
      // fallow-ignore-next-line security-sink -- `webhook` is `cfg.notifyWebhook`, which only the boss's own settings page writes; settings are not reachable from a sandbox (`mailbox.ts` admits `/orch/v1/` only). No credential is attached and the body is scrubbed.
      await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, message: scrub(body.slice(0, 1000)), url }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // A failed notification must never take down the run that produced it.
    }
  };
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
      ...(url ? { url: i.grpId ? `${url}/#g=${i.grpId}&v=progress` : url } : {}),
    };
  }

  // Keyed by the set, so the reminder backs off while the set is unchanged and
  // fires immediately when something new joins it.
  const key = `batch:${items
    .map((i) => i.id)
    .sort((a, b) => a - b)
    .join(",")}`;
  const lines = items.map((i) => `• ${i.group ?? "?"}: ${i.question.slice(0, 120)}`);
  return {
    key,
    tier: blockers.length > 0 ? "immediate" : "batched",
    ...(url ? { url } : {}),
    body:
      `${items.length} waiting on you` +
      (blockers.length ? ` (${blockers.length} blocking)` : "") +
      `:\n${lines.join("\n")}`,
  };
}
