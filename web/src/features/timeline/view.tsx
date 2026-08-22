import { memo } from "react";
import type { State } from "../../shared/api";
import { frameText, groupedRows, type PanelFrame } from "../../shared/stream";
import { clock } from "../../shared/format";
import { cn } from "../../ui/cn";
import { Trans, useLingui } from "@lingui/react/macro";

const FRAME_TONE: Record<PanelFrame["cls"], string> = {
  say: "text-ink",
  state: "text-ok",
  ask: "text-warn",
  tool: "font-mono text-meta text-ink-3",
  partial: "font-mono text-meta text-ink-3",
};

/**
 * The sentence arrives rendered, because this row is the panel's one `memo`.
 *
 * A parent's re-render does not reach through `memo`, so a row that called
 * `saidText` itself would keep the language it was first drawn in — which is
 * what the whole timeline did while the frame carried the rendered string. The
 * parent subscribes, so `text` changes when the locale does, and `memo` compares
 * props and re-renders. That is `memo` working rather than being worked around.
 */
const TimelineRow = memo(function TimelineRow({
  f,
  text,
  showHeader,
  showDivider,
}: {
  f: PanelFrame;
  text: string;
  showHeader: boolean;
  showDivider: boolean;
}) {
  return (
    <div
      className={cn(
        "fade-in grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2 py-1 text-secondary",
        showDivider && "border-t border-rule-soft",
      )}
    >
      <span className="pt-px font-mono text-pill text-ink-3">{showHeader ? clock(f.at) : ""}</span>
      <div className="min-w-0">
        <FrameHeader frame={f} show={showHeader} />
        <span className={cn("break-words", FRAME_TONE[f.cls])}>{text}</span>
      </div>
    </div>
  );
});

function FrameHeader({ frame, show }: { frame: PanelFrame; show: boolean }) {
  if (!show) return null;
  return (
    <>
      <span className={cn("font-semibold", frame.author === "boss" && "text-accent")}>{frame.author}</span>
      <Target value={frame.target} />
      <Intent value={frame.intent} />{" "}
    </>
  );
}

const Target = ({ value }: { value: string | null | undefined }) =>
  value ? <span className="text-ink-3"> → {value}</span> : null;

function Intent({ value }: { value: string | null | undefined }) {
  if (!value || value === "inform") return null;
  return <span className="ml-1 font-mono text-tag uppercase tracking-[0.06em] text-ink-3">{value}</span>;
}

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
  const { t } = useLingui();
  let ids: Set<number> | null = null;
  let label = t`All`;
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
      <h2 className="mb-2.5 flex items-baseline gap-1.5 text-secondary font-semibold text-ink-2">
        <Trans>Event stream</Trans> <span className="truncate font-normal text-ink-3">{label}</span>
      </h2>
      {!shown.length && (
        <div className="text-secondary text-ink-3">
          <Trans>No events</Trans>
        </div>
      )}
      <div className="[&>*:first-child]:border-t-0">
        {groupedRows(shown).map(({ f, showHeader, showDivider }) => (
          <TimelineRow key={f.id} f={f} text={frameText(f)} showHeader={showHeader} showDivider={showDivider} />
        ))}
      </div>
    </div>
  );
}
