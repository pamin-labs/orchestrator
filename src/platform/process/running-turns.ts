/**
 * Which turns this process is currently reading.
 *
 * Replaces `job.pid`. A turn no longer runs on this machine — it runs inside the
 * group's sandbox, and what the orchestrator holds is the stream, not a process.
 * There is nothing to `process.kill`, so "is it still going" and "stop it" are both
 * questions about this map.
 */
/**
 * ponytail: the map is memory, so after a restart every in-flight turn looks
 * orphaned — the useful answer, because nobody is reading its output any more. The
 * command keeps running in the sandbox until its own timeout and its writes land in
 * the checkout the requeued turn will see, which is the same shape as a duplicated
 * turn and already handled by reconcile. An exec id in the job row would let a
 * restart re-attach; worth it only if restarts mid-turn stop being rare.
 */
const live = new Map<number, Set<() => void>>();

export function track(jobId: number, abort: () => void): void {
  const cancellers = live.get(jobId) ?? new Set();
  cancellers.add(abort);
  live.set(jobId, cancellers);
}

export function untrack(jobId: number, abort?: () => void): void {
  if (!abort) {
    live.delete(jobId);
    return;
  }
  const cancellers = live.get(jobId);
  cancellers?.delete(abort);
  if (cancellers?.size === 0) live.delete(jobId);
}

export function isRunning(jobId: number): boolean {
  return live.has(jobId);
}

/** Stop a turn. Returns false when this process was not the one running it. */
export function abortJob(jobId: number): boolean {
  const stops = live.get(jobId);
  if (!stops) return false;
  live.delete(jobId);
  for (const stop of stops) {
    try {
      stop();
    } catch {
      // Already finished between the lookup and the call.
    }
  }
  return true;
}

/** Every turn this process is reading. Shutdown only. */
export function abortAll(): number {
  let n = 0;
  // Snapshot on purpose — `abortJob` deletes from the map it is iterating, and
  // a live iterator over a mutating Map skips entries.
  // oxlint-disable-next-line no-useless-spread
  for (const id of [...live.keys()]) if (abortJob(id)) n++;
  return n;
}
