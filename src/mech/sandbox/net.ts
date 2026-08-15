import type { DB } from "../../db.ts";
import { probeHosts } from "./auth.ts";

/**
 * Is this machine still able to reach the providers?
 *
 * A laptop closes, a train goes into a tunnel, a VPN drops. Every turn in flight
 * then spends its wall clock retrying, hits `turnTimeoutMs`, and the watchdog
 * interrupts its group into PAUSED — a state nothing takes a group out of on its
 * own, so coming back online leaves a fleet of paused groups and a park timer
 * quietly filing them away. The work is not lost, but nobody is pushing it, which
 * is exactly the failure class `invariants.ts` exists for.
 *
 * The answer is the same shape the scheduler already has twice: a global
 * admission gate. A held job is simply not picked up — no process, no retry loop,
 * no quota spent proving the wall is still there — and it lifts by itself.
 *
 * What counts as online is deliberately weak: **any HTTP response at all**, 401
 * and 403 included. A refused credential is not a network problem, and treating
 * it as one would stop the fleet over a bad token. Only a transport-level throw
 * is offline. `preflight.ts` draws the same line for the same reason.
 */

export interface NetState {
  online: boolean;
  /** When it last changed, for the message the boss reads. */
  since: number;
}

let state: NetState = { online: true, since: 0 };

/** What the scheduler asks. Never blocks: the probe runs on the watchdog tick. */
export const isOnline = (): boolean => state.online;

export const netState = (): NetState => ({ ...state });

/** Tests only: put the module back to its starting state. */
export function resetNet(): void {
  state = { online: true, since: 0 };
  lastProbe = 0;
}

const TIMEOUT_MS = 2000;

/**
 * How often the probe actually goes out, while things are working.
 *
 * The watchdog ticks every 30s, and probing on each one is 5760 unauthenticated
 * requests a day to the providers to learn something a turn would have told us
 * anyway. Once every five minutes is 288, and the worst case it buys is a
 * five-minute window where turns are dispatched into a network that is already
 * gone — which costs one failed turn each, and those are re-queued.
 *
 * While offline it probes every tick, because the only thing that matters then is
 * noticing the moment it comes back.
 */
export const PROBE_EVERY_MS = 5 * 60_000;

let lastProbe = 0;

/**
 * Probe, and report whether the answer changed.
 *
 * Any one host answering is enough. One provider being down is that provider's
 * problem and the 401/rate-limit paths already handle it; only *nothing*
 * answering is a network fault.
 */
/** Only the shape this uses, so a test stub is two lines rather than a cast. */
export type Fetcher = (url: string, init: { method: string; signal: AbortSignal }) => Promise<unknown>;

export async function probe(
  db: DB,
  now: number,
  fetchFn: Fetcher = fetch,
): Promise<{ online: boolean; changed: boolean }> {
  // Only while it is working. Offline, every tick — the answer that matters then
  // is "is it back", and nothing else on the tick is running anyway.
  if (state.online && now - lastProbe < PROBE_EVERY_MS) return { online: true, changed: false };
  lastProbe = now;

  const hosts = probeHosts(db);
  // Nothing configured yet: there is no wall to detect, and gating every turn on
  // an empty probe would stop a fleet that has not been set up rather than say so.
  // `credentialMissing` in the scheduler is what covers that case.
  const online = hosts.length === 0 ? true : await reachable(hosts, fetchFn);
  const changed = online !== state.online;
  if (changed) state = { online, since: now };
  return { online, changed };
}

async function reachable(hosts: string[], fetchFn: Fetcher): Promise<boolean> {
  const tries = hosts.map(async (h) => {
    // HEAD, not GET: nothing here wants the body, and some of these endpoints
    // charge for one. A 404 or a 405 is still a reachable host.
    await fetchFn(`https://${h}/`, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return true;
  });
  const answers = await Promise.allSettled(tries);
  return answers.some((a) => a.status === "fulfilled");
}
