import type { PanelFrame } from "../../shared/stream";
import { t } from "@lingui/core/macro";

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
 * i18n-exempt: these match the orchestrator's own event text, which
 * `src/mech/flow/start.ts` emits as a hardcoded Chinese `bus.emit` body rather
 * than through `say()`. So this pane already fails to recognise them for a boss
 * whose `output.language` is English — a defect one layer down, recorded in
 * docs/project/progress.md, not fixed by translating the copy here.
 */
const STARTED = "沙盒是新的";
const ENDED = /^装好了|^装失败了/;

export function bootstrapOf(frames: PanelFrame[], grpId: number): Bootstrap {
  const mine = frames.filter((f) => f.grpId === grpId && f.author === "orchestrator");
  // One run, not every run in this session: a second rebuild starts its own, and
  // concatenating them made the header quote the previous run's command.
  const began = mine.findLast((f) => f.cls === "state" && f.text.startsWith(STARTED));
  const since = began?.at ?? 0;
  const lines = mine.filter((f) => f.cls === "tool" && f.agentId == null && f.at >= since);
  const done = mine.findLast((f) => f.cls === "state" && f.at >= since && ENDED.test(f.text));
  const cmd = lines.find((f) => f.text.startsWith("$ "))?.text.slice(2) ?? null;
  return {
    running: (!!began || !!lines.length) && !done,
    failed: !!done?.text.startsWith(t`Bootstrap failed`),
    cmd,
    lines,
    since: since || lines[0]?.at || 0,
    until: done?.at ?? null,
  };
}
