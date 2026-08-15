/**
 * Which turns this process is currently reading.
 *
 * Replaces `job.pid`. A turn no longer runs on this machine — it runs inside the
 * group's sandbox, and what the orchestrator holds is the stream, not a process.
 * There is nothing to `process.kill`, so "is it still going" and "stop it" both
 * become questions about this map.
 *
 * Ceiling: the map is memory, so after a restart every in-flight turn looks
 * orphaned — which is the useful answer, because nobody is reading its output
 * any more. The command itself keeps running inside the sandbox until its own
 * timeout and its writes land in the checkout the requeued turn will see. Same
 * shape as a duplicated turn, which the reconcile already handles.
 * `ponytail: an exec id in the job row would let a restart re-attach instead;
 * worth it only if restarts mid-turn stop being rare.`
 */
const live = new Map<number, () => void>();

export function track(jobId: number, abort: () => void): void {
  live.set(jobId, abort);
}

export function untrack(jobId: number): void {
  live.delete(jobId);
}

export function isRunning(jobId: number): boolean {
  return live.has(jobId);
}

/** Stop a turn. Returns false when this process was not the one running it. */
export function abortJob(jobId: number): boolean {
  const stop = live.get(jobId);
  if (!stop) return false;
  try {
    stop();
  } catch {
    // Already finished between the lookup and the call.
  }
  live.delete(jobId);
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
