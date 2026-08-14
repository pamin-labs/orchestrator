import type { Frame } from "./api";

/**
 * What a sandbox rebuild looks like from the frame buffer.
 *
 * Pulled out of the pane because it is the part that can be wrong: which run is
 * the current one, whether the clone finished, whether the whole thing failed.
 * The pane is then a rendering of this and nothing else, and this is checkable
 * without mounting React (`test/bootstrap-pane.test.ts`).
 *
 * Live frames only. They never reach the database, so this state is gone on
 * reload and the outcome line in the record is what remains — the pane must not
 * be a second copy of something already stored.
 */
export interface Bootstrap {
  /** Still going: show it. */
  running: boolean;
  /** Ended badly: keep showing it, because it is the one outcome to act on. */
  failed: boolean;
  /** The install command, once the clone has returned and it has started. */
  cmd: string | null;
  /** Output of this run, oldest first. */
  lines: Frame[];
  /** When the run started, for the clock. */
  since: number;
  /** When it ended, or null while it is going. */
  until: number | null;
}

const STARTED = "沙盒是新的";
const ENDED = /^装好了|^装失败了/;

export function bootstrapOf(frames: Frame[], grpId: number): Bootstrap {
  const mine = frames.filter((f) => f.grpId === grpId && f.author === "orchestrator");
  // One run, not every run in this session: a second rebuild starts its own, and
  // concatenating them made the header quote the previous run's command.
  const began = mine.filter((f) => f.cls === "state" && f.text.startsWith(STARTED)).pop();
  const since = began?.at ?? 0;
  const lines = mine.filter((f) => f.cls === "tool" && f.agentId == null && f.at >= since);
  const done = mine.filter((f) => f.cls === "state" && f.at >= since && ENDED.test(f.text)).pop();
  const cmd = lines.find((f) => f.text.startsWith("$ "))?.text.slice(2) ?? null;
  return {
    running: (!!began || !!lines.length) && !done,
    failed: !!done?.text.startsWith("装失败了"),
    cmd,
    lines,
    since: since || lines[0]?.at || 0,
    until: done?.at ?? null,
  };
}
