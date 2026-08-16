import { memo } from "react";
import { groupedRows, type PanelFrame, type State } from "../lib/api";
import { cn, clock } from "../lib/utils";

/** One event row. Memoized so a new frame arriving only mounts its own row —
 *  every other row keeps the same `f` reference and the same booleans, so
 *  React bails out before touching their DOM. Without this, Timeline's
 *  re-render on every SSE message would re-run every row's JSX, and
 *  DevTools' Highlight Updates would flag the whole list on each frame. */
const TimelineRow = memo(function TimelineRow({
  f,
  showHeader,
  showDivider,
}: {
  f: PanelFrame;
  showHeader: boolean;
  showDivider: boolean;
}) {
  return (
    <div
      className={cn(
        "fade-in grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2 py-1 text-[0.75rem]",
        showDivider && "border-t border-rule-soft",
      )}
    >
      <span className="pt-px font-mono text-[0.625rem] text-ink-3">{showHeader ? clock(f.at) : ""}</span>
      <div className="min-w-0">
        {showHeader && (
          <>
            <span className={cn("font-semibold", f.author === "boss" && "text-accent")}>{f.author}</span>
            {f.target && <span className="text-ink-3"> → {f.target}</span>}
            {f.intent && f.intent !== "inform" && (
              <span className="ml-1 font-mono text-[0.5625rem] uppercase tracking-[0.06em] text-ink-3">{f.intent}</span>
            )}{" "}
          </>
        )}
        <span
          className={cn(
            "break-words",
            f.cls === "say" && "text-ink",
            f.cls === "state" && "text-ok",
            f.cls === "ask" && "text-warn",
            (f.cls === "tool" || f.cls === "partial") && "font-mono text-[0.6875rem] text-ink-3",
          )}
        >
          {f.text}
        </span>
      </div>
    </div>
  );
});

/**
 * A timeline, not a log.
 *
 * What gets read here is who said what to whom; tool calls and state changes are
 * context around that, so agent-to-agent talk is the only kind with full ink.
 * Scope follows the selection: a requirement when one is open, else the project.
 * A feed that ignores where the boss is looking is a wall of unrelated lines.
 */
export function Timeline({
  st,
  frames,
  grpId,
  projectId,
}: {
  st: State;
  frames: PanelFrame[];
  grpId: number | null;
  projectId: number | null;
}) {
  let ids: Set<number> | null = null;
  let label = "全部";
  if (grpId) {
    ids = new Set([grpId]);
    label = st.groups.find((g) => g.id === grpId)?.name ?? "";
  } else if (projectId) {
    ids = new Set(st.groups.filter((g) => g.project_id === projectId).map((g) => g.id));
    label = st.projects.find((p) => p.id === projectId)?.name ?? "";
  }

  // Scope, in order of precision: the requirement, else the project, else
  // everything. A standing Architect or CoS has no group — that exchange is exactly
  // what this feed is for — so it is kept when it belongs to this project, and only
  // an unattributable orchestrator line is shown everywhere.
  const shown = frames
    .filter((f) => {
      if (!ids) return true;
      if (f.grpId != null) return ids.has(f.grpId);
      if (projectId != null && f.projectId != null) return f.projectId === projectId;
      return true;
    })
    .slice(-160)
    .reverse();

  return (
    <div>
      <h2 className="mb-2.5 flex items-baseline gap-1.5 text-[0.75rem] font-semibold text-ink-2">
        事件流 <span className="truncate font-normal text-ink-3">{label}</span>
      </h2>
      {!shown.length && <div className="text-[0.75rem] text-ink-3">无事件</div>}
      <div className="[&>*:first-child]:border-t-0">
        {groupedRows(shown).map(({ f, showHeader, showDivider }) => (
          <TimelineRow key={f.id} f={f} showHeader={showHeader} showDivider={showDivider} />
        ))}
      </div>
    </div>
  );
}
