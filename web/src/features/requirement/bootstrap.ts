import type { PanelFrame } from "../../shared/stream";
import { BOOTSTRAP_FAILED, BOOTSTRAP_OK, BOOTSTRAP_START } from "../../../../src/contracts/events.ts";

/**
 * What a sandbox rebuild looks like from the frame buffer.
 *
 * Pulled out of the pane because it is the part that can be wrong: which run is the
 * current one, whether the clone finished, whether the whole thing failed. The pane
 * is then a rendering of this and nothing else, checkable without mounting React.
 *
 * Live frames only. They never reach the database, so this state is gone on reload
 * and the outcome line in the record is what remains.
 */
export interface Bootstrap {
  /** Still going: show it. */
  running: boolean;
  /** Ended badly: keep showing it, because it is the one outcome to act on. */
  failed: boolean;
  /** The install command, once the clone has returned and it has started. */
  cmd: string | null;
  /** Output of this run, oldest first. */
  lines: PanelFrame[];
  /** When the run started, for the clock. */
  since: number;
  /** When it ended, or null while it is going. */
  until: number | null;
}

/**
 * Matched on `meta.step`, never on the text.
 *
 * These three rows used to be found by their Chinese bodies, which recognised a
 * rebuild for exactly one reader; `start.ts` writes `msg` templates now, so the
 * text arrives in whichever of ten languages this browser reads, and no prefix
 * match can hold.
 */
/**
 * `failed` had already rotted the same way. It tested the body against the
 * panel's own translation of "Bootstrap failed", which matched only because
 * zh.po renders that as `Bootstrap failed` — the characters `start.ts` happened to
 * hardcode. In every other language a failed run reported itself as finished.
 */
const ended = (step: string | undefined): boolean => step === BOOTSTRAP_OK || step === BOOTSTRAP_FAILED;

export function bootstrapOf(frames: PanelFrame[], grpId: number): Bootstrap {
  const mine = frames.filter((f) => f.grpId === grpId && f.author === "orchestrator");
  // One run, not every run in this session: a second rebuild starts its own, and
  // concatenating them made the header quote the previous run's command.
  const began = mine.findLast((f) => f.cls === "state" && f.step === BOOTSTRAP_START);
  const since = began?.at ?? 0;
  const lines = mine.filter((f) => f.cls === "tool" && f.agentId == null && f.at >= since);
  const done = mine.findLast((f) => f.cls === "state" && f.at >= since && ended(f.step));
  const cmd = lines.find((f) => f.text.startsWith("$ "))?.text.slice(2) ?? null;
  return {
    running: (!!began || !!lines.length) && !done,
    failed: done?.step === BOOTSTRAP_FAILED,
    cmd,
    lines,
    since: since || lines[0]?.at || 0,
    until: done?.at ?? null,
  };
}
