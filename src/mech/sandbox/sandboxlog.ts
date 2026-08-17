import type { Ctx } from "../../mech/ctx.ts";

/**
 * The last few hundred lines a group's container printed, in memory.
 *
 * Live frames already carry this to a panel that is open — and that was the whole
 * story, so a boss who opened the 工作区 tab thirty seconds into a two-minute
 * clone saw an empty box and a spinner. Whatever happened before the panel
 * existed had nowhere to be.
 *
 * In memory, capped, and gone on restart, on purpose. This is the machine
 * talking to itself while it sets up: worth watching, worth scrolling back
 * through, not worth a table. What survives is the outcome line the caller
 * already writes to the record.
 */

const CAP = 500;
const buffers = new Map<number, Line[]>();

export interface Line {
  at: number;
  /** `cmd` is what was run, `out` is what it printed, `end` is how it finished. */
  kind: "cmd" | "out" | "end";
  text: string;
}

/** Record a line and, in the same call, put it on the live feed. */
export function sandboxLog(ctx: Ctx, grpId: number, kind: Line["kind"], text: string): void {
  const buf = buffers.get(grpId) ?? [];
  const at = Date.now();
  buf.push({ at, kind, text });
  if (buf.length > CAP) buf.splice(0, buf.length - CAP);
  buffers.set(grpId, buf);
  ctx.bus?.live({
    at,
    grpId,
    agentId: null,
    role: "orchestrator",
    // `status` is how the panes already tell a command apart from its output.
    kind: kind === "out" ? "tool" : "status",
    body: kind === "cmd" ? `$ ${text}` : text,
  });
}

export function sandboxLines(grpId: number): Line[] {
  return buffers.get(grpId) ?? [];
}

/** A rebuilt container starts a fresh log; the old one described a dead sandbox. */
export function clearSandboxLog(grpId: number): void {
  buffers.delete(grpId);
}
