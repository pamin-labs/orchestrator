import type { DB } from "../../platform/persistence/database.ts";
import { DEFAULTS_FOR_CHECK as DEFAULTS, type Config } from "../../platform/config/load.ts";
import { probeHosts } from "./auth.ts";

/**
 * Is this machine still able to reach the providers?
 *
 * A laptop closes, a train enters a tunnel, a VPN drops. Every turn in flight then
 * spends its wall clock retrying, hits `turnTimeoutMs`, and the watchdog
 * interrupts its group into PAUSED — which nothing takes a group out of on its
 * own, so coming back online leaves a fleet of paused groups and a park timer
 * quietly filing them away.
 */
/**
 * The answer is the shape the scheduler already has twice: a global admission
 * gate. A held job is not picked up — no process, no retry loop, no quota spent
 * proving the wall is still there — and it lifts by itself.
 *
 * What counts as online is deliberately weak: **any HTTP response at all**, 401
 * and 403 included. A refused credential is not a network problem, and treating it
 * as one would stop the fleet over a bad token. Only a transport-level throw is
 * offline; `preflight.ts` draws the same line.
 */

interface NetState {
  online: boolean;
  /** When it last changed, for the message the boss reads. */
  since: number;
}

let state: NetState = { online: true, since: 0 };

/** What the scheduler asks. Never blocks: the probe runs on the watchdog tick. */
export const isOnline = (): boolean => state.online;

/** Tests only: put the module back to its starting state. */
export function resetNet(): void {
  state = { online: true, since: 0 };
  lastProbe = 0;
}

/**
 * How often the probe goes out while things are working: `intervals.recheckMs`.
 *
 * The watchdog ticks every 30s, and probing on each is 5760 unauthenticated requests
 * a day to learn what a turn would have told us anyway. Once every five minutes is
 * 288, and the worst case it buys is a five-minute window where turns are dispatched
 * into a network already gone — one failed turn each, and those are re-queued.
 */
/**
 * While offline it probes every tick regardless: noticing the moment it returns is
 * all that matters then. The wait on one HEAD is `timeouts.networkPingMs`, short
 * because this runs inside the tick and must not hold one open.
 */
let lastProbe = 0;

/**
 * Probe, and report whether the answer changed.
 *
 * Any one host answering is enough. One provider being down is that provider's
 * problem and the 401/rate-limit paths already handle it; only *nothing*
 * answering is a network fault.
 */
/** Only the shape this uses, so a test stub is two lines rather than a cast. */
export type SandboxFetcher = (url: string, init: { method: string; signal: AbortSignal }) => Promise<Response>;

export async function probe(
  db: DB,
  now: number,
  fetchFn: SandboxFetcher = fetch,
  /**
   * Reads the config defaults rather than restating them; production passes
   * `ctx.config`, so these numbers only apply where there is no `Config` to ask.
   */
  cfg: Config = DEFAULTS,
): Promise<{ online: boolean; changed: boolean }> {
  // Only while it is working. Offline, every tick — the answer that matters then
  // is "is it back", and nothing else on the tick is running anyway.
  if (state.online && now - lastProbe < cfg.intervals.recheckMs) return { online: true, changed: false };
  lastProbe = now;

  const origins = await probeHosts(db);
  // Nothing configured yet: there is no wall to detect, and gating every turn on
  // an empty probe would stop a fleet that has not been set up rather than say so.
  // `credentialMissing` in the scheduler is what covers that case.
  const online = origins.length === 0 ? true : await reachable(origins, fetchFn, cfg.timeouts.networkPingMs);
  const changed = online !== state.online;
  if (changed) state = { online, since: now };
  return { online, changed };
}

async function reachable(origins: string[], fetchFn: SandboxFetcher, timeoutMs: number): Promise<boolean> {
  const tries = origins.map(async (origin) => {
    // HEAD, not GET: nothing here wants the body, and some of these endpoints
    // charge for one. A 404 or a 405 is still a reachable host.
    await fetchFn(`${origin}/`, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  });
  const answers = await Promise.allSettled(tries);
  return answers.some((a) => a.status === "fulfilled");
}
